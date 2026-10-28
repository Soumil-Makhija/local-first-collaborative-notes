import { Rga } from './crdt.js';
import { openStore, validateDocumentId } from './store.js';
import { PeerSession, parseSignal } from './peer.js';
import { parseBackup, makeBackup, MAX_BACKUP_BYTES } from './backup.js';

const $ = id => document.getElementById(id);
const actor = crypto.randomUUID(); // A fresh identity on every page avoids cross-tab clock reuse.
const editor = $('editor');
let store, model, docId, peer, peerDocument, composing = false, changing = false, pending = 0, saveFailed = false;
let deferred = [];
let transitioningTabs = [];
let saves = Promise.resolve();
let actions = Promise.resolve();
let pairingGeneration = 0;
const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fieldnotes-events-v1') : null;

function error(error) {
  $('error').textContent = error instanceof Error ? error.message : String(error);
  $('error').hidden = false;
}
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
const title = () => [...model.text.split('\n').find(line => line.trim()) || 'Untitled note'].slice(0, 70).join('');
function counts() {
  const text = model.text;
  const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
  $('word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'} · ${[...text].length} characters`;
}
function saveStatus() {
  $('save-status').textContent = saveFailed ? 'Save failed — export a backup' : pending ? 'Saving locally…' : 'Saved locally';
  $('save-status').toggleAttribute('data-failed', saveFailed);
}
async function refreshNotes() {
  const notes = await store.list();
  $('notes').replaceChildren(...notes.map(note => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = note.title;
    button.title = note.id;
    if (note.id === docId) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => run(() => openNote(note.id)));
    item.append(button);
    return item;
  }));
}

// Saving is serial within a page; IndexedDB readwrite transactions serialize tabs.
// A failure keeps the dirty indicator sticky until reopening the stored note.
function persist(operations, source = 'local') {
  if (!operations.length) return Promise.resolve();
  const targetDoc = docId, targetTitle = title();
  pending++;
  saveStatus();
  const save = saves.then(async () => {
    try { await store.append(targetDoc, operations, targetTitle); }
    catch (e) { saveFailed = true; throw e; }
    try {
      broadcast?.postMessage({ docId: targetDoc, operations });
      if (targetDoc === peerDocument && source !== 'peer') peer?.send(operations);
    } catch (e) { error(e); } // Transport failure does not undo a committed local save.
    await refreshNotes();
  });
  saves = save.catch(e => { error(e); }).finally(() => { pending--; saveStatus(); });
  return save;
}

function captureSelection() {
  const ids = model.visibleIds();
  const start = [...editor.value.slice(0, editor.selectionStart)].length;
  const end = [...editor.value.slice(0, editor.selectionEnd)].length;
  return { ids, start, end, direction: editor.selectionDirection, scroll: editor.scrollTop };
}
function render(selection) {
  editor.value = model.text;
  if (selection) {
    const ids = model.visibleIds(), positions = new Map(ids.map((id, i) => [id, i + 1]));
    const points = [...model.text];
    const offset = old => {
      let at = old;
      while (at > 0 && !positions.has(selection.ids[at - 1])) at--;
      const index = at ? positions.get(selection.ids[at - 1]) : 0;
      return points.slice(0, index).join('').length;
    };
    editor.setSelectionRange(offset(selection.start), offset(selection.end), selection.direction);
    editor.scrollTop = selection.scroll;
  }
  counts();
}
function localEdit() {
  if (!model || composing || changing) return;
  try {
    const operations = model.replace(editor.value);
    counts();
    // Handle rejection in the serial save queue; preserve visible unsaved work.
    persist(operations).catch(() => {});
  } catch (e) { render(); error(e); }
}
async function merge(operations, source) {
  if (composing) {
    if (deferred.length >= 1024 || deferred.reduce((n, entry) => n + entry.operations.length, 0) + operations.length > 200_000) {
      throw new Error('Too many peer edits while composing; finish composing and reconnect.');
    }
    deferred.push({ operations, source, docId, model }); return;
  }
  const selection = captureSelection();
  const additions = model.merge(operations);
  if (!additions.length) return;
  render(selection);
  await persist(additions, source);
}
function disconnect() {
  peer?.close();
  peer = undefined;
  peerDocument = undefined;
  $('sync-status').textContent = 'Disconnected';
  $('signal-out').value = '';
  $('copy-signal').disabled = true;
}
async function openNote(id) {
  validateDocumentId(id);
  if (composing) throw new Error('Finish composing text before switching notes.');
  if (saveFailed) throw new Error('Export a backup before leaving this note: a local save failed.');
  changing = true;
  editor.disabled = true;
  try {
    // Stop the old peer before the flush: an incoming frame must not append a
    // later save behind the promise we are about to await.
    disconnect();
    await saves;
    if (saveFailed) throw new Error('Export a backup before leaving this note: a local save failed.');
    // Load/validate the next document before changing the current document.
    const next = new Rga(actor, await store.load(id));
    await store.append(id, []);
    docId = id;
    model = next;
    deferred = [];
    history.replaceState(null, '', `#${id}`);
    $('document-id').value = id;
    clearError();
    render();
    saveStatus();
    await refreshNotes();
  } finally {
    changing = false;
    editor.disabled = !model;
    const queued = transitioningTabs;
    transitioningTabs = [];
    for (const entry of queued) {
      if (model && entry.docId === docId) await merge(entry.operations, 'tab');
    }
  }
}
function session() {
  if (saveFailed) throw new Error('Export a backup before pairing: a local save failed.');
  if (composing) throw new Error('Finish composing text before pairing.');
  disconnect();
  const targetDoc = docId;
  const targetModel = model;
  let created;
  created = new PeerSession({
    docId,
    getOperations: () => targetModel.operations(),
    onOperations: operations => targetDoc === docId && targetModel === model ? merge(operations, 'peer') : undefined,
    onStatus: status => { if (peer === created) $('sync-status').textContent = status; },
    onError: e => { if (peer === created) error(e); },
  });
  peer = created;
  peerDocument = targetDoc;
  return created;
}
function run(task) {
  // Serialize user actions across awaits. A pairing action cannot create an old
  // document's session while another action is switching to a different note.
  const action = actions.then(async () => { clearError(); await task(); });
  actions = action.catch(e => { error(e); });
  return actions;
}
function runPairing(task) {
  // Capture cancellation when the user clicks, including time spent queued or
  // waiting for a local save before a PeerSession exists.
  const generation = pairingGeneration;
  return run(async () => {
    const active = () => generation === pairingGeneration;
    if (!active()) return;
    try { await task(active); }
    catch (e) { if (active()) throw e; }
  });
}
function showSignal(text) {
  $('signal-out').value = text;
  $('copy-signal').disabled = false;
}

document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault(); // The URL fragment belongs to the document, not focus navigation.
  editor.focus();
});

editor.addEventListener('input', event => { if (!event.isComposing) localEdit(); });
editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => {
  composing = false;
  localEdit();
  const queued = deferred;
  deferred = [];
  // merge applies to memory and queues persistence before its first await.
  // Drain every entry now, so an already queued note switch observes all saves.
  for (const entry of queued) {
    if (entry.docId === docId && entry.model === model) merge(entry.operations, entry.source).catch(error);
  }
});
$('new-note').addEventListener('click', () => run(() => openNote(crypto.randomUUID())));
$('open-note').addEventListener('click', () => run(() => openNote($('document-id').value.trim())));
$('offer').addEventListener('click', () => runPairing(async active => {
  await saves;
  if (!active()) return;
  const signal = await session().createOffer();
  if (active()) showSignal(signal);
}));
$('accept-offer').addEventListener('click', () => runPairing(async active => {
  const raw = $('signal-in').value;
  const signal = parseSignal(raw);
  if (signal.description.type !== 'offer') throw new Error('Paste an offer here.');
  if (signal.docId !== docId) await openNote(signal.docId);
  await saves;
  if (!active()) return;
  const answer = await session().acceptOffer(raw);
  if (active()) showSignal(answer);
}));
$('accept-answer').addEventListener('click', () => runPairing(async () => {
  if (!peer) throw new Error('Create an offer before accepting an answer.');
  await peer.acceptAnswer($('signal-in').value);
}));
$('disconnect').addEventListener('click', () => { pairingGeneration++; disconnect(); });
$('copy-signal').addEventListener('click', () => run(async () => {
  try { await navigator.clipboard.writeText($('signal-out').value); }
  catch { $('signal-out').focus(); $('signal-out').select(); throw new Error('Copy the selected pairing data manually; clipboard access is unavailable.'); }
}));
$('export').addEventListener('click', () => run(() => {
  if (composing) throw new Error('Finish composing text before exporting.');
  const url = URL.createObjectURL(new Blob([makeBackup(docId, model.operations())], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `local-notes-${docId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
$('import').addEventListener('change', () => run(async () => {
  const file = $('import').files[0];
  try {
    if (!file) return;
    if (composing) throw new Error('Finish composing text before importing.');
    if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 64 MiB limit.');
    const data = parseBackup(await file.text());
    // Validate against existing local content too, before switching or persisting.
    const existing = data.docId === docId ? model.operations() : await store.load(data.docId);
    new Rga('import-check', existing).merge(data.operations);
    if (data.docId !== docId) await openNote(data.docId);
    await merge(data.operations, 'import');
  } finally { $('import').value = ''; }
}));
broadcast?.addEventListener('message', event => {
  if (changing) {
    if (event.data && transitioningTabs.length < 1024) transitioningTabs.push(event.data);
    return;
  }
  if (event.data?.docId !== docId || !model) return;
  const data = event.data;
  run(() => data.docId === docId ? merge(data.operations, 'tab') : undefined);
});
window.addEventListener('hashchange', event => {
  const id = new URL(event.newURL).hash.slice(1);
  if (!model) return;
  run(async () => {
    if (id === docId) return;
    try { await openNote(id); }
    catch (e) {
      // Rejected navigation must leave the URL identifying the visible note.
      history.replaceState(null, '', `#${docId}`);
      throw e;
    }
  });
});
window.addEventListener('beforeunload', event => {
  if (pending || saveFailed || composing) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { peer?.close(); broadcast?.close(); store?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function offline() {
  if (!('serviceWorker' in navigator)) { $('offline-status').textContent = 'Offline caching unavailable in this browser'; return; }
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    $('offline-status').textContent = 'Ready for offline use';
  } catch { $('offline-status').textContent = 'Offline cache failed — keep this page open'; }
}
async function start() {
  try {
    store = await openStore();
    const hash = location.hash.slice(1);
    const notes = await store.list();
    const id = hash || notes[0]?.id || crypto.randomUUID();
    await openNote(id);
    for (const id of ['new-note', 'open-note', 'export', 'import', 'offer', 'accept-offer', 'accept-answer', 'disconnect']) $(id).disabled = false;
  } catch (e) { error(e); $('save-status').textContent = 'Notebook could not be opened'; }
  offline();
}
start();
