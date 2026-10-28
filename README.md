# Fieldnotes · local-first collaborative notes

An offline-capable plain-text notebook with a custom replicated growable array
(CRDT) and direct WebRTC synchronization. Write locally, pair with one trusted
peer, disconnect, and exchange a fresh offer and answer to merge offline edits.
There is no note backend, account, signaling server, STUN server, or TURN relay.

## Run it

Install Node.js **22 or newer**. The app has no runtime dependencies.

```sh
git clone https://github.com/Soumil-Makhija/local-first-collaborative-notes.git
cd local-first-collaborative-notes
npm start
```

Open **http://127.0.0.1:4178**. The local server only serves the app's static files
and binds to loopback; note text never goes through HTTP. Keep using the same
origin and port to access your saved notebook. After the footer says **Ready for
offline use**, you can reload or reopen this origin without the server running.
The initial visit requires the server. Browser storage can be cleared or evicted;
use **Export backup** for a separate JSON copy. Imported backups retain operation
history and merge with an existing note of the same ID.

### Pair two browsers

Run this app on each device at its own localhost origin (or serve the static
assets over HTTPS). Use **Pair a peer** on both:

1. First browser: select **Create offer**; copy **Your pairing data**.
2. Second browser: paste it into **Peer pairing data**, select **Accept offer**.
   This opens the offered note, preserving other local notes, and generates an answer.
3. Copy that answer back to the first browser and select **Accept answer**.
4. Wait for **Connected**. Edits flow directly through the data channel. After
   disconnecting, both can keep editing. Pair again with fresh data to reconcile.

The note ID groups replicas; it is not a password. Pairing data contains network
addresses and the connection fingerprint; exchange it through a trusted channel.
Only pair with people you trust to read and edit the note. DTLS encrypts the
transport, but this app has no accounts, identity verification, access revocation,
or encryption of browser storage and JSON backups.

**Network boundary:** no automatic discovery or NAT relay is provided. Direct
host-candidate connections usually require a reachable local network; firewalls,
client isolation, VPNs, browser privacy settings or NAT can prevent them. A failed
connection does not prevent local editing or manual backup exchange. Plain HTTP
on a LAN IP is not a supported offline origin: service workers require HTTPS or a
trustworthy loopback origin. See [transport details](docs/TRANSPORT.md) and the
[Service Worker API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

## What works

- Multiple local notes, first-line titles, open by note ID, word and codepoint counts.
- Immediate edits; **Saved locally** appears after the IndexedDB transaction commits.
- Service-worker cached app assets; IndexedDB operation logs survive offline reload.
- Same-origin tab synchronization through BroadcastChannel; append transactions
  preserve concurrent tab logs even if live broadcasts are missed.
- Full-log catch-up on every WebRTC connection, then bounded incremental operation frames.
- Validated export/import, rejected conflicting IDs and atomic invalid batches.
- Unicode codepoint edits, composition buffering, and selection anchoring during peer edits.

## Check it

```sh
npm test                     # Node behavioral tests, including ephemeral loopback server
npm run check                # JavaScript syntax checks
npm run demo                 # partition, concurrent edits, reverse/duplicate delivery
npm run benchmark            # measured deterministic CRDT workloads as JSON
npm ci                       # development-only Playwright dependency
npx playwright install chromium
npm run test:e2e             # real IndexedDB, offline, WebRTC, import/export, narrow layout
# Existing local Chrome can be used instead:
PLAYWRIGHT_CHROME=1 npm run test:e2e
```

[Measurements and reproduction](docs/BENCHMARKS.md) include raw samples, runtime,
hardware, log sizes and explicit exclusions. Core timings exclude browser storage,
serialization and network latency; they are not a claim about WAN collaboration.

## Architecture and boundaries

`src/crdt.js` is our dependency-free operation-set sequence implementation:
immutable insertions anchor to previous insertions, deterministic descending
Lamport/actor order resolves siblings, and deletions retain tombstones. Every
writer gets a fresh UUID per page session. Missing ancestors and deletes delivered
before insertions resolve after later delivery. [Design and invariants](docs/CRDT.md).

`src/store.js` appends only newly accepted events and metadata in one IndexedDB
transaction; it validates the combined stored and incoming log before writing.
This preserves tab unions and rejects conflicts atomically, at **O(history)**
read/validation cost per save. `src/peer.js` bounds JSON frames to 16 KiB, queues
with backpressure, checks version/document IDs, and serializes incoming processing.
`src/app.js` adapts textarea changes to CRDT edits and defers remote edits during
composition. `sw.js` caches only the static app shell. The local static server has
an explicit asset allowlist and no data endpoint.

This is a small-note editor. It retains every event and tombstone, with no history
compaction; total history is capped at 200,000 operations. A text edit argument is
limited to 100,000 codepoints; the transport queue is limited to 16 MiB. A growing
history can reach these bounds with very little visible text. Export a backup
before starting a fresh note. Large edits rebuild the visible sequence and can
pause the UI; see the measured workloads rather than treating bounds as a
performance guarantee.

Positions are codepoints, not grapheme clusters; combining sequences may be split.
There is no rich text, shared undo, remote cursor display, automatic reconnection,
background synchronization after a page closes, multi-peer mesh, or conflict-free
note deletion. Concurrent replacements keep both writers' inserted content, which
may need human cleanup. Native textarea undo is browser-local, not collaborative
undo. Synthetic composition tests do not certify an operating-system IME or screen
reader. Browser/device combinations beyond the stated test evidence remain unverified.

Local saves are browser transactions, not a backup or a disk-fsync guarantee.
If a save fails, the visible text remains exportable and the UI reports the error.
The app blocks note switching after a save failure. No analytics or telemetry is
included. It never requests microphone, camera or screen access.

MIT licensed.
