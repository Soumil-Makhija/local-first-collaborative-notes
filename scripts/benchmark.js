import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { Rga } from '../src/crdt.js';

const args = process.argv.slice(2);
const accepted = new Set(['--samples', '--warmups']);
const config = { samples: 7, warmups: 2 };
for (let i = 0; i < args.length; i += 2) {
  if (!accepted.has(args[i]) || !/^\d+$/.test(args[i + 1] ?? '')) {
    throw new Error('Usage: node scripts/benchmark.js [--samples 1..30] [--warmups 0..10]');
  }
  config[args[i].slice(2)] = Number(args[i + 1]);
}
if (config.samples < 1 || config.samples > 30 || config.warmups > 10) {
  throw new Error('Samples must be 1..30; warmups must be 0..10.');
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle(input, seed) {
  const rng = random(seed);
  const result = [...input];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function time(action) {
  const start = performance.now();
  const value = action();
  return { milliseconds: performance.now() - start, value };
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rounded = value => Number(value.toFixed(3));
  return {
    median_ms: rounded(sorted[Math.floor(sorted.length / 2)]),
    min_ms: rounded(sorted[0]),
    max_ms: rounded(sorted.at(-1)),
    samples_ms: values.map(rounded),
  };
}

// Per branch: 100 inserts and 25 deletes. Locations depend on the current
// document length, and the seed is fixed rather than wall-clock dependent.
function edit(replica, seed) {
  const rng = random(seed);
  for (let i = 0; i < 100; i++) {
    const size = replica.visibleIds().length;
    replica.insert(Math.floor(rng() * (size + 1)), String.fromCharCode(65 + (i % 26)));
    if (i % 4 === 0) {
      const afterSize = replica.visibleIds().length;
      replica.delete(Math.floor(rng() * afterSize), 1);
    }
  }
}

const sizes = [1000, 5000, 10000];
const results = [];
for (const size of sizes) {
  const measurements = {
    initial_insert: [],
    ordered_replay: [],
    shuffled_replay: [],
    concurrent_local_edits: [],
    bidirectional_merge: [],
    render_text: [],
  };
  let metrics;
  const text = Array.from({ length: size }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789\n'[i % 37]).join('');
  for (let run = -config.warmups; run < config.samples; run++) {
    const origin = new Rga('origin');
    const insert = time(() => origin.insert(0, text));
    assert.equal(origin.text, text);
    const operations = origin.operations();

    const replay = time(() => new Rga('replay', operations));
    assert.equal(replay.value.text, text);
    const reordered = shuffle(operations, 0x5eed + size);
    const shuffledReplay = time(() => new Rga('shuffled', reordered));
    assert.equal(shuffledReplay.value.text, text);

    const left = new Rga('left', operations);
    const right = new Rga('right', operations);
    const edits = time(() => {
      edit(left, 0xace + size);
      edit(right, 0xbdf + size);
    });
    // Serialization and full-log extraction are excluded from merge timing.
    // Each side receives the other's complete log, as the current sync protocol does.
    const leftLog = left.operations();
    const rightLog = right.operations();
    const merge = time(() => {
      left.merge(rightLog);
      right.merge(leftLog);
    });
    const render = time(() => left.text);
    assert.equal(render.value, right.text);
    assert.deepEqual(left.operations(), right.operations());
    assert.ok(render.value.length > 0);

    metrics = {
      initial_operations: operations.length,
      initial_log_utf8_bytes: Buffer.byteLength(JSON.stringify(operations)),
      merged_operations: left.operations().length,
      merged_visible_codepoints: left.visibleIds().length,
      merged_log_utf8_bytes: Buffer.byteLength(JSON.stringify(left.operations())),
    };
    if (run >= 0) {
      measurements.initial_insert.push(insert.milliseconds);
      measurements.ordered_replay.push(replay.milliseconds);
      measurements.shuffled_replay.push(shuffledReplay.milliseconds);
      measurements.concurrent_local_edits.push(edits.milliseconds);
      measurements.bidirectional_merge.push(merge.milliseconds);
      measurements.render_text.push(render.milliseconds);
    }
  }
  results.push({
    initial_codepoints: size,
    ...metrics,
    timings: Object.fromEntries(Object.entries(measurements).map(([name, values]) => [name, summarize(values)])),
  });
}

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    logical_cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
  },
  config: {
    ...config,
    sizes_codepoints: sizes,
    edits_per_branch: { inserts: 100, deletes: 25 },
    concurrent_branches: 2,
    clock: 'performance.now',
    transport_and_serialization_in_timing: false,
    seed_scheme: '0x5eed + size for shuffled replay; 0xace/0xbdf + size for edit positions',
  },
  results,
}, null, 2));
