import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, validateDocumentId } from '../src/store.js';

test('document IDs allow stable URL-safe identifiers and reject ambiguous or oversized keys', () => {
  for (const id of ['a', 'note-1_A', 'A'.repeat(80)]) assert.equal(validateDocumentId(id), id);
  for (const id of ['', 'a'.repeat(81), 'space here', '../note', 'note/name', 'note?x=1', '😀', null, undefined, 1]) {
    assert.throws(() => validateDocumentId(id), /Document ID/u);
  }
});

test('storage reports unavailable IndexedDB explicitly', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  await assert.rejects(openStore(), /IndexedDB is unavailable/u);
});
