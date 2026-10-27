import test from 'node:test';
import assert from 'node:assert/strict';
import { Rga } from '../src/crdt.js';

// A fixed PRNG makes a failure's seed sufficient to reproduce its edit history.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assertSame(replicas) {
  for (const replica of replicas.slice(1)) {
    assert.equal(replica.text, replicas[0].text);
    assert.deepEqual(replica.visibleIds(), replicas[0].visibleIds());
    assert.deepEqual(replica.operations(), replicas[0].operations());
  }
}

test('middle insertion, deletion and replacement preserve the local codepoint edit intent', () => {
  const replica = new Rga('local');
  const initial = replica.insert(0, 'abc');
  assert.equal(initial.length, 3);
  assert.equal(replica.text, 'abc');
  replica.insert(1, 'XY');
  assert.equal(replica.text, 'aXYbc');
  replica.insert(0, '[');
  replica.insert([...replica.text].length, ']');
  assert.equal(replica.text, '[aXYbc]');
  replica.delete(2, 3);
  assert.equal(replica.text, '[ac]');
  replica.replace('a🧪b');
  assert.equal(replica.text, 'a🧪b');
  replica.replace('a🧪b');
  assert.equal(replica.text, 'a🧪b');
  assert.equal(replica.visibleIds().length, 3);
});

test('deletions delivered before their insertion and missing anchors converge', () => {
  const author = new Rga('writer');
  author.insert(0, 'abcd');
  author.insert(2, '🧪');
  author.delete(1, 3);
  assert.equal(author.text, 'ad');
  const reverse = new Rga('reverse');
  for (const op of author.operations().toReversed()) reverse.merge([op]);
  assertSame([author, reverse]);
  assert.equal(reverse.merge(author.operations()).length, 0);
});

test('concurrent overlapping deletes remove the union of observed characters', () => {
  const origin = new Rga('origin');
  origin.insert(0, 'abcdef');
  const left = new Rga('left', origin.operations());
  const right = new Rga('right', origin.operations());
  left.delete(1, 3);
  right.delete(2, 3);
  assert.equal(left.text, 'aef');
  assert.equal(right.text, 'abf');
  left.merge(right.operations());
  right.merge(left.operations());
  assertSame([left, right]);
  assert.equal(left.text, 'af');
});

test('an unobserved concurrent insertion survives deletion of its surrounding text', () => {
  const origin = new Rga('origin');
  origin.insert(0, 'abcd');
  const left = new Rga('left', origin.operations());
  const right = new Rga('right', origin.operations());
  left.delete(1, 2);
  right.insert(2, 'X');
  const combined = [...left.operations(), ...right.operations()];
  left.merge(combined);
  right.merge(combined.toReversed());
  assertSame([left, right]);
  assert.equal(left.text, 'aXd');
});

test('concurrent insertions at one cursor keep both complete strings deterministically', () => {
  const origin = new Rga('origin');
  origin.insert(0, 'ac');
  const left = new Rga('left', origin.operations());
  const right = new Rga('right', origin.operations());
  left.insert(1, '12');
  right.insert(1, 'XY');
  const combined = [...left.operations(), ...right.operations()];
  left.merge(combined);
  right.merge(combined.toReversed());
  assertSame([left, right]);
  assert.ok(['a12XYc', 'aXY12c'].includes(left.text), left.text);
});

test('merge is commutative, associative and idempotent for independently edited histories', () => {
  const base = new Rga('base');
  base.insert(0, 'base');
  const branches = ['A', 'B', 'C'].map(actor => new Rga(actor, base.operations()));
  branches[0].insert(2, 'α');
  branches[1].delete(1, 2);
  branches[2].replace('BASE🧪');
  const [a, b, c] = branches.map(replica => replica.operations());
  const ab = new Rga('ab', a);
  ab.merge(b);
  const ba = new Rga('ba', b);
  ba.merge(a);
  assertSame([ab, ba]);
  const leftGrouped = new Rga('left-grouped', ab.operations());
  leftGrouped.merge(c);
  const bc = new Rga('bc', b);
  bc.merge(c);
  const rightGrouped = new Rga('right-grouped', a);
  rightGrouped.merge(bc.operations());
  assertSame([leftGrouped, rightGrouped]);
  const before = leftGrouped.operations();
  assert.deepEqual(leftGrouped.merge([...before, ...before]), []);
  assert.deepEqual(leftGrouped.operations(), before);
});

test('astral Unicode and combining sequences are edited by code point, not UTF-16 unit', () => {
  const author = new Rga('emoji');
  author.insert(0, 'A🧪e\u0301👩\u200d💻Z');
  assert.equal(author.visibleIds().length, 8);
  author.delete(1, 1);
  assert.equal(author.text, 'Ae\u0301👩\u200d💻Z');
  author.insert(1, '🙂');
  assert.equal(author.text, 'A🙂e\u0301👩\u200d💻Z');
  const restored = new Rga('restored', author.operations().toReversed());
  assertSame([author, restored]);
});

test('80 seeded three-replica partitions converge after arbitrary duplicate delivery', () => {
  const alphabet = ['a', 'b', 'Z', '🧪', '🙂', '\n', 'é', '\u0301'];
  for (let seed = 1; seed <= 80; seed++) {
    const rng = random(seed);
    const replicas = ['A', 'B', 'C'].map(actor => new Rga(`${actor}-${seed}`));
    for (let step = 0; step < 90; step++) {
      const replica = replicas[Math.floor(rng() * replicas.length)];
      const before = [...replica.text];
      const at = Math.floor(rng() * (before.length + 1));
      const kind = rng();
      if (kind < 0.58 || before.length === 0) {
        const value = alphabet[Math.floor(rng() * alphabet.length)]
          + (rng() < 0.25 ? alphabet[Math.floor(rng() * alphabet.length)] : '');
        replica.insert(at, value);
        before.splice(at, 0, ...value);
      } else if (kind < 0.92) {
        const count = Math.min(1 + Math.floor(rng() * 3), before.length - at);
        replica.delete(at, count);
        before.splice(at, count);
      } else {
        const replacement = before.slice(0, Math.floor(before.length / 2)).join('') + '🧪';
        replica.replace(replacement);
        before.splice(0, before.length, ...replacement);
      }
      assert.equal(replica.text, before.join(''), `local edit seed=${seed}, step=${step}`);

      // Each exchange has omissions, reordering and duplicates. Pending dependencies
      // must eventually resolve without requiring senders to use causal ordering.
      if (rng() < 0.4) {
        const source = replicas[Math.floor(rng() * replicas.length)];
        const target = replicas[Math.floor(rng() * replicas.length)];
        const subset = shuffled(source.operations(), rng).filter(() => rng() < 0.45);
        target.merge([...subset, ...subset.slice(0, 3)]);
      }
    }
    const union = replicas.flatMap(replica => replica.operations());
    for (const replica of replicas) replica.merge(shuffled([...union, ...union], rng));
    try {
      assertSame(replicas);
      const replay = new Rga(`replay-${seed}`);
      for (const op of shuffled(replicas[0].operations(), rng)) replay.merge([op]);
      assertSame([replicas[0], replay]);
    } catch (error) {
      error.message = `seed=${seed}: ${error.message}`;
      throw error;
    }
  }
});
