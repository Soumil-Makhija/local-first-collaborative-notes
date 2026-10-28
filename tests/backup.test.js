import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup } from '../src/backup.js';
import { Rga } from '../src/crdt.js';

test('backup roundtrip preserves immutable history and document identity', () => {
  const rga = new Rga('alice');
  rga.insert(0, 'Hello 🧪');
  rga.delete(0, 1);
  const restored = parseBackup(makeBackup('shared-note_1', rga.operations()));
  assert.equal(restored.docId, 'shared-note_1');
  assert.deepEqual(restored.operations, rga.operations());
  assert.equal(new Rga('bob', restored.operations).text, 'ello 🧪');
});
test('backup parser rejects schema mismatches and conflicting operation histories', () => {
  for (const data of [null, [], {}, { version: 2, docId: 'a', operations: [] }, { version: 1, docId: '../path', operations: [] }, { version: 1, docId: 'a', operations: [], extra: true }]) {
    assert.throws(() => parseBackup(JSON.stringify(data)));
  }
  const a = { type: 'insert', id: '1@a', after: null, value: 'a' };
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, docId: 'a', operations: [a, { ...a, value: 'b' }] })));
});
