import { Rga } from './crdt.js';
import { validateDocumentId } from './store.js';

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) {
    throw new Error('Backup exceeds the 64 MiB limit.');
  }
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || Object.keys(data).sort().join(',') !== 'docId,operations,version') {
    throw new Error('Expected a version 1 notes backup.');
  }
  validateDocumentId(data.docId);
  // Validate all operations before opening or mutating a local document.
  const checked = new Rga('backup-validator', data.operations);
  return { version: 1, docId: data.docId, operations: checked.operations() };
}

export function makeBackup(docId, operations) {
  validateDocumentId(docId);
  const checked = new Rga('backup-validator', operations);
  const text = JSON.stringify({ version: 1, docId, operations: checked.operations() }, null, 2);
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 64 MiB limit.');
  return text;
}
