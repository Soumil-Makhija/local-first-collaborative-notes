import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const editor = page => page.getByRole('textbox', { name: 'Note text', exact: true });

async function ready(page, path = '/') {
  await page.goto(path);
  await expect(editor(page)).toBeEnabled();
  await expect(page.locator('#save-status')).toHaveText(/Saved locally/);
}

async function saved(page) {
  await expect(page.locator('#save-status')).toHaveText(/Saved locally/);
}

async function holdableWrites(context) {
  await context.addInitScript(() => {
    globalThis.holdWriteCompletions = false;
    globalThis.heldWriteCompletions = [];
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      configurable: true,
      enumerable: complete.enumerable,
      get() { return complete.get.call(this); },
      set(listener) {
        complete.set.call(this, function (event) {
          const deliver = () => listener.call(this, event);
          if (globalThis.holdWriteCompletions && this.mode === 'readwrite' && this.objectStoreNames.contains('events')) {
            globalThis.heldWriteCompletions.push(deliver);
          } else deliver();
        });
      },
    });
  });
}

const releaseWrites = page => page.evaluate(() => {
  globalThis.holdWriteCompletions = false;
  for (const deliver of globalThis.heldWriteCompletions.splice(0)) deliver();
});

async function pair(left, right) {
  for (const page of [left, right]) {
    if (await page.locator('#pairing').getAttribute('open') === null) {
      await page.locator('#pairing > summary').click();
    }
  }
  await left.getByRole('button', { name: 'Create offer', exact: true }).click();
  await expect.poll(async () => {
    try {
      const signal = JSON.parse(await left.locator('#signal-out').inputValue());
      return signal.description?.type;
    } catch { return ''; }
  }, { timeout: 20_000 }).toBe('offer');
  const offer = await left.locator('#signal-out').inputValue();
  await right.getByRole('textbox', { name: 'Peer pairing data', exact: true }).fill(offer);
  await right.getByRole('button', { name: 'Accept offer', exact: true }).click();
  await expect.poll(async () => {
    try {
      const signal = JSON.parse(await right.locator('#signal-out').inputValue());
      return signal.description?.type;
    } catch { return ''; }
  }, { timeout: 20_000 }).toBe('answer');
  await left.getByRole('textbox', { name: 'Peer pairing data', exact: true })
    .fill(await right.locator('#signal-out').inputValue());
  await left.getByRole('button', { name: 'Accept answer', exact: true }).click();
  await expect(left.locator('#sync-status')).toHaveText(/^Connected/);
  await expect(right.locator('#sync-status')).toHaveText(/^Connected/);
}

async function appendText(page, value) {
  await editor(page).evaluate(element => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await editor(page).pressSequentially(value);
  await saved(page);
}

test('saved Unicode notes reload and open in another tab while fully offline', async ({ page, context }) => {
  await ready(page);
  await editor(page).fill('Offline 🧪 notes\nSecond line');
  await saved(page);
  const noteUrl = page.url();
  await expect(page.locator('#offline-status')).toHaveText(/Ready for offline use/);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(editor(page)).toHaveValue('Offline 🧪 notes\nSecond line');
  await saved(page);
  const second = await context.newPage();
  await ready(second, noteUrl);
  await expect(editor(second)).toHaveValue('Offline 🧪 notes\nSecond line');
  await appendText(second, '\nWritten offline');
  await page.reload();
  await expect(editor(page)).toHaveValue('Offline 🧪 notes\nSecond line\nWritten offline');
});

test('real manually signaled WebRTC peers sync, diverge disconnected, and converge after re-pairing', async ({ browser, baseURL }) => {
  test.setTimeout(100_000);
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  try {
    await contexts[1].addInitScript(() => {
      globalThis.receivedNoteFrames = 0;
      const OriginalPeerConnection = globalThis.RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends OriginalPeerConnection {
        constructor(...args) {
          super(...args);
          this.addEventListener('datachannel', ({ channel }) => {
            channel.addEventListener('message', ({ data }) => {
              try { if (Array.isArray(JSON.parse(data).ops)) globalThis.receivedNoteFrames++; }
              catch { /* The application separately validates channel data. */ }
            });
          });
        }
      };
    });
    const [left, right] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([ready(left), ready(right)]);
    const sharedNote = 'Shared 🧪 note\n' + 'abcdefghijklmnopqrstuvwxyz🙂\n'.repeat(60);
    expect([...sharedNote].length).toBeGreaterThan(1500);
    await editor(left).fill(sharedNote);
    await editor(right).fill('Private note on B');
    await Promise.all([saved(left), saved(right)]);
    const privateNoteUrl = right.url();

    await pair(left, right);
    await expect(editor(right)).toHaveValue(sharedNote);
    expect(await right.evaluate(() => globalThis.receivedNoteFrames)).toBeGreaterThan(1);
    await appendText(left, ' live-A');
    await expect(editor(right)).toHaveValue(sharedNote + ' live-A');
    await appendText(right, ' live-B');
    await expect(editor(left)).toHaveValue(sharedNote + ' live-A live-B');

    // Synthetic DOM composition events exercise the application's remote-render
    // deferral. This is not an operating-system IME compatibility claim.
    const beforeComposition = await editor(right).inputValue();
    const receivedBeforeComposition = await right.evaluate(() => globalThis.receivedNoteFrames);
    await editor(right).evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      element.value += '漢';
      element.setSelectionRange(element.value.length, element.value.length);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '漢', inputType: 'insertCompositionText', isComposing: true }));
    });
    await appendText(left, ' remote-A');
    await expect.poll(() => right.evaluate(() => globalThis.receivedNoteFrames)).toBeGreaterThan(receivedBeforeComposition);
    await expect(editor(right)).toHaveValue(beforeComposition + '漢');
    await editor(right).dispatchEvent('compositionend', { data: '漢' });
    await expect.poll(() => editor(right).inputValue()).toContain('remote-A');
    await expect.poll(() => editor(left).inputValue()).toContain('漢');
    await expect.poll(async () => (await editor(left).inputValue()) === (await editor(right).inputValue())).toBe(true);

    await left.locator('#disconnect').click();
    await expect(left.locator('#sync-status')).toHaveText(/^Disconnected/);
    await expect(right.locator('#sync-status')).toHaveText(/^(Disconnected|Closed)/);
    await appendText(left, ' offline-A');
    await appendText(right, ' offline-B');
    await expect(editor(left)).not.toHaveValue(await editor(right).inputValue());

    await pair(left, right);
    await expect.poll(() => editor(left).inputValue()).toContain('offline-A');
    await expect.poll(() => editor(left).inputValue()).toContain('offline-B');
    await expect.poll(async () => (await editor(left).inputValue()) === (await editor(right).inputValue())).toBe(true);
    await Promise.all([saved(left), saved(right)]);
    const merged = await editor(left).inputValue();
    await left.reload();
    await right.reload();
    await expect(editor(left)).toHaveValue(merged);
    await expect(editor(right)).toHaveValue(merged);

    const privateTab = await contexts[1].newPage();
    await ready(privateTab, privateNoteUrl);
    await expect(editor(privateTab)).toHaveValue('Private note on B');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('two tabs preserve the union of concurrent writes even without live broadcasts', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  // Hold the optional live notification side channel silent. Both tabs edit the
  // same observed base; only the real IndexedDB transactions can retain union.
  await context.addInitScript(() => {
    window.BroadcastChannel = class {
      onmessage = null;
      postMessage() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    };
  });
  try {
    const first = await context.newPage();
    await ready(first);
    await editor(first).fill('base');
    await saved(first);
    const second = await context.newPage();
    await ready(second, first.url());
    await expect(editor(second)).toHaveValue('base');
    await Promise.all([editor(first).fill('base A'), editor(second).fill('base B')]);
    await Promise.all([saved(first), saved(second)]);
    await first.reload();
    await second.reload();
    await expect.poll(() => editor(first).inputValue()).toMatch(/^base(?: A B| B A)$/);
    await expect(editor(second)).toHaveValue(await editor(first).inputValue());
  } finally {
    await context.close();
  }
});

test('downloaded backups import into their note and malformed imports preserve saved content', async ({ page }) => {
  await ready(page);
  await editor(page).fill('Backup 🧪\nKeep this content');
  await saved(page);
  const originalId = await page.locator('#document-id').inputValue();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`local-notes-${originalId}.json`);
  const bytes = await readFile(await download.path());
  const backup = JSON.parse(bytes.toString());
  expect(backup.version).toBe(1);
  expect(backup.docId).toBe(originalId);
  expect(backup.operations.length).toBeGreaterThan(0);

  await page.locator('#new-note').click();
  await expect(editor(page)).toHaveValue('');
  const otherId = await page.locator('#document-id').inputValue();
  expect(otherId).not.toBe(originalId);
  await editor(page).fill('Other local note stays saved');
  await saved(page);
  await page.locator('#import').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/json', buffer: bytes });
  await expect(page.locator('#document-id')).toHaveValue(originalId);
  await expect(editor(page)).toHaveValue('Backup 🧪\nKeep this content');
  await saved(page);

  const malformed = { ...backup, operations: [...backup.operations, { type: 'insert', id: 'invalid', after: null, value: '!' }] };
  await page.locator('#import').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
  await expect(page.getByRole('alert')).not.toHaveText('');
  await expect(editor(page)).toHaveValue('Backup 🧪\nKeep this content');
  await page.reload();
  await expect(editor(page)).toHaveValue('Backup 🧪\nKeep this content');

  await page.locator('.open-document > summary').click();
  await page.locator('#document-id').fill(otherId);
  await page.locator('#open-note').click();
  await expect(editor(page)).toHaveValue('Other local note stays saved');
});

test('real IndexedDB writers commit union, roll back conflicting batches, and reopen intact', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { openStore } = await import('/src/store.js');
    const { Rga } = await import('/src/crdt.js');
    const a = new Rga('store-test-a');
    const b = new Rga('store-test-b');
    a.insert(0, 'A');
    b.insert(0, 'B');
    const first = await openStore();
    const second = await openStore();
    await Promise.all([
      first.append('store-race', a.operations(), 'Preserved title'),
      second.append('store-race', b.operations()),
    ]);
    const union = await first.load('store-race');
    const validAddition = { type: 'insert', id: '2@store-test-a', after: '1@store-test-a', value: 'C' };
    const conflict = { ...a.operations()[0], value: 'X' };
    let rejected = false;
    try { await second.append('store-race', [validAddition, conflict]); }
    catch { rejected = true; }
    const afterRejected = await first.load('store-race');
    const metadata = (await first.list()).find(note => note.id === 'store-race');
    const pendingReference = [
      { type: 'insert', id: '1@reference-anchor', after: null, value: 'R' },
      { type: 'insert', id: '3@reference-holder', after: '2@reference-missing', value: 'H' },
    ];
    await first.append('reference-race', pendingReference, 'Reference title');
    let referenceRejected = false;
    try {
      await second.append('reference-race', [
        { type: 'delete', id: '2@reference-missing', target: '1@reference-anchor' },
      ], 'Must roll back');
    } catch { referenceRejected = true; }
    const afterReferenceRejected = await first.load('reference-race');
    const referenceMetadata = (await first.list()).find(note => note.id === 'reference-race');
    const existingDelete = [
      { type: 'insert', id: '1@existing', after: null, value: 'E' },
      { type: 'delete', id: '2@existing', target: '1@existing' },
    ];
    await first.append('reference-existing', existingDelete);
    let existingReferenceRejected = false;
    try {
      await second.append('reference-existing', [
        { type: 'insert', id: '3@child', after: '2@existing', value: 'C' },
      ]);
    } catch { existingReferenceRejected = true; }
    const afterExistingReferenceRejected = await first.load('reference-existing');
    first.close();
    second.close();
    const reopened = await openStore();
    const restored = await reopened.load('store-race');
    reopened.close();
    return {
      union, rejected, afterRejected, restored, title: metadata?.title,
      referenceRejected, pendingReference, afterReferenceRejected,
      referenceTitle: referenceMetadata?.title,
      existingReferenceRejected, existingDelete, afterExistingReferenceRejected,
    };
  });
  expect(result.union).toHaveLength(2);
  expect(result.rejected).toBe(true);
  expect(result.afterRejected).toEqual(result.union);
  expect(result.restored).toEqual(result.union);
  expect(result.title).toBe('Preserved title');
  expect(result.referenceRejected).toBe(true);
  expect(result.afterReferenceRejected).toEqual(result.pendingReference);
  expect(result.referenceTitle).toBe('Reference title');
  expect(result.existingReferenceRejected).toBe(true);
  expect(result.afterExistingReferenceRejected).toEqual(result.existingDelete);
});

test('Disconnect cancels offer creation and acceptance waiting for local saves', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await holdableWrites(context);
  try {
    const page = await context.newPage();
    await ready(page);
    await page.locator('#pairing > summary').click();
    const docId = await page.locator('#document-id').inputValue();
    await page.locator('#signal-in').fill(JSON.stringify({
      version: 1, docId, description: { type: 'offer', sdp: 'v=0\r\ns=unused-canceled-offer\r\n' },
    }));
    for (const action of ['offer', 'accept-offer']) {
      await page.evaluate(() => { globalThis.holdWriteCompletions = true; });
      await editor(page).fill(`Retained text while canceling ${action}`);
      await expect.poll(() => page.evaluate(() => globalThis.heldWriteCompletions.length)).toBeGreaterThan(0);
      await page.locator(`#${action}`).click();
      await page.locator('#disconnect').click();
      // Export runs after the queued pairing action, proving its asynchronous
      // continuation finished before checking the canceled state.
      const download = page.waitForEvent('download');
      await page.locator('#export').click();
      await releaseWrites(page);
      await download;
      await saved(page);
      await expect(page.locator('#sync-status')).toHaveText('Disconnected');
      await expect(page.locator('#signal-out')).toHaveValue('');
      await expect(page.locator('#copy-signal')).toBeDisabled();
      await expect(page.locator('#error')).toBeHidden();
    }
  } finally {
    await context.close();
  }
});

test('pending saves serialize pairing and note switches, and composing drains stay with their note', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await holdableWrites(context);
  await context.addInitScript(() => {
    globalThis.receivedTabMessages = 0;
    const OriginalChannel = BroadcastChannel;
    globalThis.BroadcastChannel = class extends OriginalChannel {
      constructor(name) {
        super(name);
        this.addEventListener('message', () => globalThis.receivedTabMessages++);
      }
    };
  });
  try {
    const page = await context.newPage();
    await ready(page);
    const oldNoteUrl = page.url();
    const oldId = await page.locator('#document-id').inputValue();
    await page.locator('#pairing > summary').click();
    await page.evaluate(() => { globalThis.holdWriteCompletions = true; });
    await editor(page).fill('Old note saved during the transition');
    await expect.poll(() => page.evaluate(() => globalThis.heldWriteCompletions.length)).toBeGreaterThan(0);
    await page.locator('#offer').click();
    await page.locator('#new-note').click();
    await expect(page.locator('#document-id')).toHaveValue(oldId);
    await releaseWrites(page);
    await expect(page.locator('#document-id')).not.toHaveValue(oldId);
    await expect(editor(page)).toBeEnabled();
    await expect(editor(page)).toHaveValue('');
    await expect(page.locator('#signal-out')).toHaveValue('');
    await expect(page.locator('#sync-status')).toHaveText('Disconnected');

    await editor(page).fill('Composition base');
    await saved(page);
    const composingUrl = page.url();
    const composingId = await page.locator('#document-id').inputValue();
    await page.evaluate(async docId => {
      const { openStore } = await import('/src/store.js');
      const { Rga } = await import('/src/crdt.js');
      const store = await openStore();
      const remote = new Rga('deferred-test-peer', await store.load(docId));
      store.close();
      const first = remote.insert(remote.visibleIds().length, ' remote-X');
      const second = remote.insert(remote.visibleIds().length, ' remote-Y');
      const element = document.getElementById('editor');
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.value += '漢';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '漢', isComposing: true }));
      const channel = new BroadcastChannel('fieldnotes-events-v1');
      channel.postMessage({ docId, operations: first });
      channel.postMessage({ docId, operations: second });
      globalThis.deferredTestChannel = channel;
    }, composingId);
    await expect.poll(() => page.evaluate(() => globalThis.receivedTabMessages)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => { globalThis.holdWriteCompletions = true; });
    await editor(page).dispatchEvent('compositionend', { data: '漢' });
    await expect.poll(() => page.evaluate(() => globalThis.heldWriteCompletions.length)).toBeGreaterThan(0);
    await page.locator('#new-note').click();
    await releaseWrites(page);
    await expect(page.locator('#document-id')).not.toHaveValue(composingId);
    await expect(editor(page)).toBeEnabled();
    await expect(editor(page)).toHaveValue('');
    await saved(page);

    const restored = await context.newPage();
    await ready(restored, composingUrl);
    await expect.poll(() => editor(restored).inputValue()).toContain('漢');
    await expect.poll(() => editor(restored).inputValue()).toContain('remote-X');
    await expect.poll(() => editor(restored).inputValue()).toContain('remote-Y');
    await ready(restored, oldNoteUrl);
    await expect(editor(restored)).toHaveValue('Old note saved during the transition');
  } finally {
    await context.close();
  }
});

test('hash navigation opens saved notes and restores the visible note after rejected navigation', async ({ page, context }) => {
  await holdableWrites(context);
  await ready(page);
  await editor(page).fill('First hash navigation note');
  await saved(page);
  const firstUrl = page.url();
  const firstId = await page.locator('#document-id').inputValue();
  await page.locator('#new-note').click();
  await expect(editor(page)).toHaveValue('');
  await editor(page).fill('Second hash navigation note');
  await saved(page);
  const secondUrl = page.url();
  const secondId = await page.locator('#document-id').inputValue();
  await page.evaluate(() => { globalThis.sameDocumentNavigation = true; });

  await page.goto(firstUrl);
  await expect(editor(page)).toHaveValue('First hash navigation note');
  await expect(page.locator('#document-id')).toHaveValue(firstId);
  await page.goBack();
  await expect(editor(page)).toHaveValue('Second hash navigation note');
  await expect(page.locator('#document-id')).toHaveValue(secondId);
  expect(await page.evaluate(() => globalThis.sameDocumentNavigation)).toBe(true);

  await page.evaluate(() => { globalThis.holdWriteCompletions = true; });
  await editor(page).fill('Second note saved during rapid hash navigation');
  await expect.poll(() => page.evaluate(() => globalThis.heldWriteCompletions.length)).toBeGreaterThan(0);
  await page.evaluate(id => { location.hash = id; }, firstId);
  await expect(editor(page)).toBeDisabled();
  await page.evaluate(id => { location.hash = id; }, secondId);
  await releaseWrites(page);
  await expect(page.locator('#document-id')).toHaveValue(secondId);
  await expect(editor(page)).toBeEnabled();
  await expect(editor(page)).toHaveValue('Second note saved during rapid hash navigation');
  await expect(page).toHaveURL(secondUrl);
  await editor(page).fill('Second hash navigation note');
  await saved(page);

  await page.evaluate(() => { location.hash = 'invalid/document'; });
  await expect(page.locator('#error')).toContainText('Document ID must contain');
  await expect(page).toHaveURL(secondUrl);
  await expect(editor(page)).toHaveValue('Second hash navigation note');
  await expect(page.locator('#document-id')).toHaveValue(secondId);

  await editor(page).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.value += '漢';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '漢', isComposing: true }));
  });
  await page.evaluate(id => { location.hash = id; }, firstId);
  await expect(page.locator('#error')).toContainText('Finish composing text');
  await expect(page).toHaveURL(secondUrl);
  await expect(editor(page)).toHaveValue('Second hash navigation note漢');
  await editor(page).dispatchEvent('compositionend', { data: '漢' });
  await saved(page);

  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    globalThis.restoreTransactions = () => { IDBDatabase.prototype.transaction = original; };
    IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
      if (mode === 'readwrite') throw new DOMException('Injected save failure', 'QuotaExceededError');
      return original.call(this, stores, mode, ...options);
    };
  });
  await editor(page).fill('Unsaved work stays visible');
  await expect(page.locator('#save-status')).toHaveText('Save failed — export a backup');
  await page.evaluate(() => { globalThis.restoreTransactions(); });
  await page.evaluate(id => { location.hash = id; }, firstId);
  await expect(page.locator('#error')).toContainText('Export a backup before leaving this note');
  await expect(page).toHaveURL(secondUrl);
  await expect(page.locator('#document-id')).toHaveValue(secondId);
  await expect(editor(page)).toHaveValue('Unsaved work stays visible');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export').click();
  const backup = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  const recovery = await page.evaluate(async ({ docId, operations }) => {
    const { Rga } = await import('/src/crdt.js');
    const { openStore } = await import('/src/store.js');
    const store = await openStore();
    try {
      return {
        exported: new Rga('export-check', operations).text,
        stored: new Rga('stored-check', await store.load(docId)).text,
      };
    } finally { store.close(); }
  }, backup);
  expect(backup.docId).toBe(secondId);
  expect(recovery.exported).toBe('Unsaved work stays visible');
  expect(recovery.stored).toBe('Second hash navigation note漢');
});

test('narrow mobile layout supports skip navigation, keyboard editing and moving focus', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await ready(page);
    const noteUrl = page.url();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to note' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();
    expect(page.url()).toBe(noteUrl);
    await page.keyboard.type('Keyboard note');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await saved(page);
    await expect(editor(page)).toHaveValue('Keyboard note\nSecond line');
    await page.keyboard.press('Tab');
    await expect(editor(page)).not.toBeFocused();
    const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    await page.reload();
    await expect(editor(page)).toHaveValue('Keyboard note\nSecond line');
    expect(page.url()).toBe(noteUrl);
  } finally {
    await context.close();
  }
});
