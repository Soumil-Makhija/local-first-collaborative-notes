# Peer transport

`src/peer.js` uses one browser `RTCPeerConnection` and one reliable, ordered data
channel (`notes-v1`, protocol `notes-crdt-v1`) per document pairing. There is no
signaling service, discovery service, STUN server, TURN relay, or presence service.
The user transfers an offer and an answer through a channel they choose. Both
payloads include the document ID. The UI opens or creates that document before
accepting an offer; callers of the transport API must do the same. Document IDs
use the same ASCII letters/digits/underscore/hyphen format as the local store,
with a maximum length of 80.

This configuration uses host ICE candidates only. It is useful between browser
contexts on one machine and may work across a reachable local network. NAT,
firewalls, browser privacy rules, and network topology can prevent a connection.
It does not promise arbitrary internet connectivity or work around those limits.
No microphone or camera access is requested. Use a secure browser context (HTTPS
or localhost); the browser provides WebRTC DTLS encryption. The app has no account
authentication: exchange pairing payloads with the intended person through a
trusted channel. A document ID is an identifier, not a password.

## API and pairing

```js
import { PeerSession, parseSignal } from './src/peer.js';

const session = new PeerSession({
  docId,
  getOperations: () => document.operations(),
  onOperations: async (operations) => {
    document.merge(operations);
    await persist(document.operations());
    render(document.text);
  },
  onStatus: (message) => showStatus(message),
  onError: (error) => showError(error.message),
});

// Offer creator:
const offer = await session.createOffer();
// Transfer offer to the other browser, then receive its answer:
await session.acceptAnswer(answer);

// Alternatively, the other browser inspects the offer before constructing its
// own PeerSession for parseSignal(offer).docId:
const answer = await otherSession.acceptOffer(offer);

// Every locally accepted edit:
session.send(newOperations);
// When switching documents, canceling pairing, or disconnecting:
session.close();
```

`parseSignal(string)` validates the exact version-1 envelope
`{version:1, docId, description:{type,sdp}}` and returns it. Types are `offer` or
`answer`; signal JSON is limited to 128 KiB in UTF-8. Each session accepts one
pairing attempt. Offers and answers wait for complete, non-trickle ICE gathering
before returning, with a 15-second gathering timeout. A wrong-document signal,
unexpected answer, extra channel, malformed payload, or failed connection closes
the session and reports an `Error` through `onError`.

`getOperations()` is synchronous and must return the current full CRDT log.
`send(operations)` returns `false` before the channel opens or after close. On
open, the session fetches a fresh full log, including edits made during pairing.
After open, `send` validates and queues operations, returning `true`; validation,
queue-capacity, and send failures both throw to the caller and report through
`onError` before closing the connection. `connected` indicates an open initialized
data channel. Status callbacks receive readable strings, including `Connected`
and `Closed`.

## Framing and flow control

Each text data-channel message is independent JSON:
`{version:1, docId, ops:[...]}`. Frames have a maximum encoded size of 16 KiB. The
sender validates a defensive snapshot using the CRDT implementation, then packs
whole operations into frames. UTF-8 size is measured rather than assuming that
one JavaScript character takes one byte. There is no chunk assembly: CRDT missing
anchors and early tombstones let the receiver merge each frame independently.
The initial exchange sends the entire retained log; later sends carry live edits.
There is no acknowledgment, log compaction, or missing-operation summary protocol.
Re-pairing exchanges both full logs and recovers retained edits after interruption.

The sender pauses before the browser data-channel buffer would exceed 256 KiB,
then resumes on `bufferedamountlow` at a 128 KiB threshold. The app queue plus the
browser's reported buffered bytes is capped at 16 MiB. A single full-log exchange
larger than 16 MiB is rejected, even if its operation count fits the CRDT's
200,000-event bound. Queue overflow fails closed and reports the error; the local
document is not discarded. A `true` return from `send` means queued locally, not
that the peer saved the edit.

Incoming frames are bounded before JSON parsing, checked for exact envelope shape,
version, document identity, and valid CRDT operations. The receiver allows at most
1,024 pending frames and 16 MiB of pending frame bytes, including the frame whose
callback is running. `onOperations` calls run serially and are awaited, so async
storage cannot reorder application callbacks. The application must merge into its
existing CRDT; that merge also checks identity conflicts across frames. Callback
rejection closes the session with the original error. A full exchange is not an
atomic transaction: earlier valid frames may already have been saved when a later
frame fails. Closing removes event listeners, clears queues, cancels pending ICE
gathering, and closes both WebRTC objects. An application callback already running
cannot be canceled; queued callbacks that have not started are discarded.

## Verification

`node --test tests/peer.test.js` uses fake `RTCPeerConnection` and data-channel
objects to verify strict signaling, complete ICE gathering and timeout, matching
document IDs, unexpected channels/answers, UTF-8 framing, reverse frame delivery,
initial and live log delivery, buffer pause/resume, bounded queues, serialized
async callbacks, cleanup, and invalid-message rejection.

`npm run test:e2e` also exercises real browser data channels: manually transferring
offers and answers between isolated browser contexts, delivering a full history
across multiple frames, sending live edits in both directions, composing while
peer edits arrive, disconnecting and making independent edits, then re-pairing
and checking equal persisted text after reload. This suite passed locally in
Chrome 156 on macOS. Linux CI is configured to install the Chromium revision
pinned by the locked Playwright dependency; see the [CI runs](https://github.com/Soumil-Makhija/local-first-collaborative-notes/actions)
for commit-specific results. These same-machine browser tests do not establish cross-device or arbitrary-network
reachability. No other browser engine, operating-system IME, or physical-device
network has been certified by this evidence.

The implementation follows the browser events and buffering model in the
[W3C WebRTC specification](https://www.w3.org/TR/webrtc/).
