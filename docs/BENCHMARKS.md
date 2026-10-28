# Reproducible CRDT benchmark

Measured on 2026-10-28 at 20:39 UTC (13:39 America/Vancouver) with Node **v24.21.0**, macOS/Darwin **23.6.0**, **arm64 Apple M2**, 8 logical CPUs and 8 GiB RAM. The complete output, including all samples and machine information, is in [benchmark-results.json](benchmark-results.json). These are local measurements from a shared development machine; other development and test activity may overlap, and the machine was not isolated for timing. Treat the timings as noisy observations of this run rather than evidence of a speedup or slowdown from an earlier run.

Run from the repository root, without dependencies or network access:

```sh
npm run benchmark
# To save a new machine-readable measurement:
node scripts/benchmark.js > docs/benchmark-results.json
# Optional shorter run; keep the sample count when comparing results:
node scripts/benchmark.js --samples 3 --warmups 1
```

The default uses two unreported warmup iterations and seven measured iterations **per size**, all in one Node process. It uses `performance.now()` and fixed random seeds. Every iteration asserts that replay reconstructs the original text and both branches converge to identical text and canonical operation logs. Timings exclude those assertions.

## Median elapsed milliseconds

| Initial code points | Initial batch insert | Ordered replay | Shuffled replay | Concurrent local edits | Bidirectional merge | First text render after merge |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 8.278 | 7.813 | 8.273 | 178.071 | 14.826 | 0.977 |
| 5,000 | 44.487 | 42.234 | 45.070 | 886.084 | 68.308 | 4.211 |
| 10,000 | 92.448 | 92.442 | 92.183 | 1,874.236 | 134.690 | 8.589 |

“Concurrent local edits” means two disconnected replicas, each performing 100 single-code-point inserts and 25 single-code-point deletes at seeded positions. The measured code executes the branches sequentially in one process; concurrency here means independent histories, not parallel CPU execution. It includes the public editing API and the position lookup used to generate the workload. It excludes constructing the branches from the common history.

Ordered and shuffled replay measure constructing an `Rga` from a complete log; they exclude the subsequent first text render. Shuffled replay is one batch whose insertion dependencies arrive in arbitrary order. The merge column measures **both directions together**: each replica receives the other's full log, including the already known base operations. Serialization, log extraction, transport, persistence and the subsequent text render are excluded from that column. Rendering measures the first visible-view construction after the merge, rather than reading an already cached view.

## Canonical operation-log size

Sizes are UTF-8 byte lengths of `JSON.stringify(replica.operations())`, without whitespace, an application envelope or compression. A code point becomes an insertion operation; each deletion is another operation and keeps its target as a tombstone.

| Initial code points / operations | Initial log bytes | Merged operations | Merged visible code points | Merged log bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 68,805 | 1,250 | 1,150 | 85,356 |
| 5,000 | 352,913 | 5,250 | 5,150 | 369,693 |
| 10,000 | 708,049 | 10,250 | 10,150 | 725,098 |

These bytes depend on actor-ID lengths, clock digits and text. The fixture uses short actor names and ASCII/newline content. Real browser identities and Unicode text can produce larger logs. Each merged history has 200 extra insertions and 50 deletions; the final visible count and operation count are recorded from the workload. Every iteration checks that both replicas have identical text and canonical operation logs.

## Interpretation and limits

This implementation favors readable CRDT logic over large-document efficiency. It rebuilds the visible insertion tree after edits, sorts sibling lists and retains all operations. Repeated edits therefore get slower as the history grows, including when much of the text has been deleted. Full-log synchronization and JSON persistence also scale with retained history; their end-to-end browser cost is outside this benchmark. There is no tombstone garbage collection or log compaction.

The 10,000-code-point case took a median 1.87 seconds for the entire 250-edit workload, with measured samples from 1.82 to 1.92 seconds. This supports a small-note prototype, not a claim of editor performance at large scale. No measurements beyond 10,000 initial code points are published here. Configured operation and input limits are rejection boundaries, not demonstrated performance targets.

Seven samples on one machine do not establish a stable latency bound, cross-platform comparison or statistical performance claim. The benchmark does not measure WebRTC connection setup, peer bandwidth, IndexedDB/localStorage, browser layout, memory peaks, prolonged editing, hostile peers or packet-level network failures. The seeded convergence tests exercise a wider set of edit/delivery histories; neither the benchmark nor those finite tests prove the CRDT correct.
