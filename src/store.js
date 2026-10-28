import { Rga } from './crdt.js';

const DATABASE_NAME = 'local-notes-v1';
const DATABASE_VERSION = 1;
const DEFAULT_TITLE = 'Untitled note';

export function validateDocumentId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) {
    throw new TypeError('Document ID must contain 1–80 letters, digits, underscores, or hyphens');
  }
  return id;
}

function titleFor(title, previous) {
  if (title === undefined) return previous?.title ?? DEFAULT_TITLE;
  if (typeof title !== 'string') throw new TypeError('Note title must be a string');
  // Titles are display metadata; their length never changes the underlying note text.
  let bounded = '';
  let count = 0;
  for (const point of title) {
    if (count++ === 100) break;
    bounded += point;
  }
  return bounded || DEFAULT_TITLE;
}

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function committed(transaction) {
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted'));
  });
  // A request may reject before its transaction's abort event fires. Keep the
  // transaction rejection handled while callers finish handling that request.
  completion.catch(() => {});
  return completion;
}

async function abortAndRethrow(transaction, completion, error) {
  try { transaction.abort(); } catch { /* It may already have finished or aborted. */ }
  await completion.catch(() => {});
  throw error;
}

function createStore(database) {
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error('The notes database is closed; reopen it before saving');
  };
  const close = () => {
    closed = true;
    database.close();
  };
  database.onversionchange = close;

  return Object.freeze({
    async load(docId) {
      validateDocumentId(docId);
      ensureOpen();
      const transaction = database.transaction('events', 'readonly');
      const completion = committed(transaction);
      try {
        const rows = await resultOf(transaction.objectStore('events').index('doc').getAll(docId));
        await completion;
        for (const row of rows) {
          if (row.doc !== docId || row.id !== row.operation?.id) throw new Error('Stored operation identity is corrupt');
        }
        return new Rga('storage-read', rows.map((row) => row.operation)).operations();
      } catch (error) {
        return abortAndRethrow(transaction, completion, error);
      }
    },

    async append(docId, operations, title) {
      validateDocumentId(docId);
      ensureOpen();
      // Normalize and validate a whole batch before opening a write transaction.
      const incoming = new Rga('storage-validation', operations).operations();
      if (title !== undefined && typeof title !== 'string') throw new TypeError('Note title must be a string');
      const transaction = database.transaction(['events', 'notes'], 'readwrite');
      const completion = committed(transaction);
      try {
        const events = transaction.objectStore('events');
        const notes = transaction.objectStore('notes');
        // Read the whole stored log so cross-batch references and the total event
        // limit are checked before any writes. This costs O(history) per save.
        // IndexedDB serializes overlapping read/write transactions, so another
        // tab's committed additions are observed before this validation.
        const [previous, existing] = await Promise.all([
          resultOf(notes.get(docId)),
          resultOf(events.index('doc').getAll(docId)),
        ]);
        for (const row of existing) {
          if (row.doc !== docId || row.id !== row.operation?.id) throw new Error('Stored operation identity is corrupt');
        }
        const combined = new Rga('storage-validation', existing.map((row) => row.operation));
        const additions = combined.merge(incoming);
        for (const operation of additions) {
          events.add({ doc: docId, id: operation.id, operation });
        }
        notes.put({
          id: docId,
          title: titleFor(title, previous),
          updated: Math.max(Date.now(), (previous?.updated || 0) + 1),
        });
        await completion;
      } catch (error) {
        return abortAndRethrow(transaction, completion, error);
      }
    },

    async list() {
      ensureOpen();
      const transaction = database.transaction('notes', 'readonly');
      const completion = committed(transaction);
      try {
        const notes = await resultOf(transaction.objectStore('notes').getAll());
        await completion;
        return notes.map(({ id, title, updated }) => {
          validateDocumentId(id);
          if (typeof title !== 'string' || [...title].length > 100
            || !Number.isSafeInteger(updated) || updated < 0) throw new Error('Stored note metadata is corrupt');
          return { id, title, updated };
        }).sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      } catch (error) {
        return abortAndRethrow(transaction, completion, error);
      }
    },

    close,
  });
}

export async function openStore() {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable in this browser; notes cannot be saved locally');
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('notes', { keyPath: 'id' });
      const events = database.createObjectStore('events', { keyPath: ['doc', 'id'] });
      events.createIndex('doc', 'doc', { unique: false });
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error || new Error('Could not open the local notes database'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Another tab is blocking the notes database upgrade; close other note tabs and reload'));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(createStore(request.result));
    };
  });
}
