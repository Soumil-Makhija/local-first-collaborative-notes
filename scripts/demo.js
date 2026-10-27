import assert from 'node:assert/strict';
import { Rga } from '../src/crdt.js';

const a = new Rga('alice');
a.insert(0, 'Packing list\n- water\n');
const b = new Rga('bob', a.operations());
a.insert([...a.text].length, '- raincoat\n');
b.insert([...b.text].length, '- snacks 🥨\n');
b.delete(0, 7);
console.log('During partition:', JSON.stringify({ alice: a.text, bob: b.text }, null, 2));
// Deliberately deliver all operations backward, twice, including deletes before inserts.
for (const op of b.operations().toReversed()) a.merge([op, op]);
b.merge(a.operations());
assert.equal(a.text, b.text);
assert.deepEqual(a.operations(), b.operations());
console.log(`After synchronization (${a.operations().length} operations):\n${a.text}`);
console.log('Both replicas and their complete operation logs are identical.');
