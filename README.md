# Local-first collaborative notes

A custom sequence CRDT for an offline notes editor with directly paired WebRTC peers.
No CRDT library is used. This first milestone delivers the tested merge core;
the browser editor and transport are in development.

Node.js 22 or newer is required for the development commands. There are no runtime dependencies.

```sh
npm test
npm run check
npm run demo
npm run benchmark
node --input-type=module - <<'JS'
import { Rga } from './src/crdt.js';
const alice = new Rga('alice');
alice.insert(0, 'Hello');
const bob = new Rga('bob', alice.operations());
alice.insert(5, ' from Alice');
bob.insert(5, ' from Bob');
alice.merge(bob.operations());
bob.merge(alice.operations());
console.log(alice.text, alice.text === bob.text);
JS
```

The core retains immutable insertion and deletion operations, traverses insertion
anchors deterministically, and accepts missing ancestors for later delivery.
Import validation rejects conflicting identities and malformed operations atomically.
Text positions count Unicode codepoints, rather than UTF-16 units or graphemes.
Tombstones and operations are retained; there is no garbage collection.

See [CRDT design](docs/CRDT.md) and [reproducible measurements](docs/BENCHMARKS.md).
