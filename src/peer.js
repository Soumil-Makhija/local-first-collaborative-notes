import { Rga } from './crdt.js';

export const PEER_LIMITS = Object.freeze({
  signalBytes: 128 * 1024,
  frameBytes: 16 * 1024,
  queuedBytes: 16 * 1024 * 1024,
  queuedFrames: 1024,
  bufferedBytes: 256 * 1024,
  iceTimeoutMs: 15_000,
});

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).byteLength;
const CHANNEL = 'notes-v1';
const PROTOCOL = 'notes-crdt-v1';
const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));

function validDocId(docId) {
  if (typeof docId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(docId)) {
    throw new TypeError('Document ID must contain 1–80 ASCII letters, digits, underscores or hyphens');
  }
  return docId;
}

function parseBounded(raw, limit, name) {
  if (typeof raw !== 'string' || raw.length > limit || bytes(raw) > limit) {
    throw new TypeError(`${name} must be a JSON string of at most ${limit} UTF-8 bytes`);
  }
  try { return JSON.parse(raw); } catch { throw new TypeError(`${name} is not valid JSON`); }
}

/** Inspect a manually transferred signal before selecting its document in the UI. */
export function parseSignal(raw) {
  const signal = parseBounded(raw, PEER_LIMITS.signalBytes, 'Signal');
  if (!fields(signal, ['version', 'docId', 'description']) || signal.version !== 1
      || !fields(signal.description, ['type', 'sdp'])
      || !['offer', 'answer'].includes(signal.description.type)
      || typeof signal.description.sdp !== 'string' || !signal.description.sdp.trim()) {
    throw new TypeError('Unsupported or malformed signaling payload');
  }
  validDocId(signal.docId);
  return signal;
}

function framesFor(docId, operations) {
  // Reuse the CRDT validator: this also makes a defensive canonical snapshot.
  const validated = new Rga('peer-validation', operations).operations();
  const prefix = `{"version":1,"docId":${JSON.stringify(docId)},"ops":[`;
  const overhead = bytes(prefix) + 2;
  const frames = [];
  let parts = [];
  let size = overhead;
  let total = 0;
  const finish = () => {
    if (!parts.length) return;
    frames.push({ data: `${prefix}${parts.join(',')}]}`, bytes: size });
    total += size;
    if (total > PEER_LIMITS.queuedBytes) throw new RangeError('Outgoing sync exceeds the 16 MiB queue limit');
    parts = [];
    size = overhead;
  };
  for (const operation of validated) {
    const part = JSON.stringify(operation);
    const length = bytes(part);
    if (overhead + length > PEER_LIMITS.frameBytes) throw new RangeError('Operation cannot fit in one data frame');
    if (size + (parts.length ? 1 : 0) + length > PEER_LIMITS.frameBytes) finish();
    size += (parts.length ? 1 : 0) + length;
    parts.push(part);
  }
  finish();
  return frames;
}

/** One manually paired, reliable ordered WebRTC data channel for one document. */
export class PeerSession {
  #docId;
  #getOperations;
  #onOperations;
  #onStatus;
  #onError;
  #pc;
  #channel = null;
  #role = null;
  #answerAccepted = false;
  #ready = false;
  #closed = false;
  #removers = [];
  #cancelIce = null;
  #outgoing = [];
  #outgoingBytes = 0;
  #incoming = [];
  #incomingBytes = 0;
  #incomingCount = 0;
  #processing = false;

  constructor({ docId, getOperations, onOperations, onStatus = () => {}, onError = () => {} }) {
    this.#docId = validDocId(docId);
    for (const callback of [getOperations, onOperations, onStatus, onError]) {
      if (typeof callback !== 'function') throw new TypeError('Peer callbacks must be functions');
    }
    if (typeof globalThis.RTCPeerConnection !== 'function') throw new Error('WebRTC is unavailable in this browser');
    this.#getOperations = getOperations;
    this.#onOperations = onOperations;
    this.#onStatus = onStatus;
    this.#onError = onError;
    this.#pc = new RTCPeerConnection({ iceServers: [] });
    this.#listen(this.#pc, 'datachannel', ({ channel }) => {
      if (this.#role !== 'answerer' || this.#channel) {
        channel.close();
        this.#fail(new Error('Unexpected data channel'));
        return;
      }
      this.#attach(channel);
    });
    this.#listen(this.#pc, 'connectionstatechange', () => {
      if (this.#pc.connectionState === 'failed') this.#fail(new Error('Peer connection failed; create a new pairing'));
      else if (this.#pc.connectionState === 'closed') this.close();
      else if (this.#pc.connectionState === 'disconnected') this.#status('Connection interrupted; waiting for recovery');
      else if (this.#pc.connectionState === 'connected' && this.connected) this.#status('Connected');
    });
  }

  get connected() { return !this.#closed && this.#ready && this.#channel?.readyState === 'open'; }

  async createOffer() {
    try {
      this.#assertIdle();
      this.#role = 'offerer';
      this.#attach(this.#pc.createDataChannel(CHANNEL, { ordered: true, protocol: PROTOCOL }));
      this.#status('Gathering connection candidates');
      await this.#pc.setLocalDescription(await this.#pc.createOffer());
      await this.#gatherIce();
      const signal = this.#localSignal('offer');
      this.#status('Offer ready; send it to your peer');
      return signal;
    } catch (error) { this.#fail(error); throw error; }
  }

  async acceptOffer(raw) {
    try {
      this.#assertIdle();
      const signal = this.#signalFor(raw, 'offer');
      this.#role = 'answerer';
      this.#status('Gathering connection candidates');
      await this.#pc.setRemoteDescription(signal.description);
      await this.#pc.setLocalDescription(await this.#pc.createAnswer());
      await this.#gatherIce();
      const answer = this.#localSignal('answer');
      this.#status('Answer ready; send it back to the offer creator');
      return answer;
    } catch (error) { this.#fail(error); throw error; }
  }

  async acceptAnswer(raw) {
    try {
      if (this.#closed || this.#role !== 'offerer' || this.#answerAccepted
          || this.#pc.signalingState !== 'have-local-offer') throw new Error('No outstanding offer is waiting for an answer');
      const signal = this.#signalFor(raw, 'answer');
      this.#answerAccepted = true;
      await this.#pc.setRemoteDescription(signal.description);
      if (this.#closed) throw new Error('Pairing was closed');
      if (!this.connected) this.#status('Answer accepted; connecting');
    } catch (error) { this.#fail(error); throw error; }
  }

  /** False before open: the open handler sends a fresh full log, including offline edits. */
  send(operations) {
    if (!this.connected) return false;
    try { this.#enqueue(operations); return true; }
    catch (error) { this.#fail(error); throw error; }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#cancelIce?.(new Error('Pairing was closed'));
    for (const remove of this.#removers.splice(0)) remove();
    this.#outgoing = [];
    this.#outgoingBytes = 0;
    this.#incoming = [];
    this.#incomingBytes = 0;
    this.#incomingCount = 0;
    this.#channel?.close();
    this.#pc.close();
    this.#status('Closed');
  }

  #assertIdle() {
    if (this.#closed || this.#role !== null) throw new Error('Create a new session for a new pairing');
  }

  #signalFor(raw, type) {
    const signal = parseSignal(raw);
    if (signal.docId !== this.#docId) throw new Error('The signal belongs to a different document');
    if (signal.description.type !== type) throw new Error(`Expected an ${type} signal`);
    return signal;
  }

  #localSignal(type) {
    if (this.#closed) throw new Error('Pairing was closed');
    const description = this.#pc.localDescription;
    const raw = JSON.stringify({ version: 1, docId: this.#docId, description: { type: description?.type, sdp: description?.sdp } });
    const signal = parseSignal(raw);
    if (signal.description.type !== type) throw new Error('Unexpected local WebRTC description');
    return raw;
  }

  #gatherIce() {
    if (this.#closed) return Promise.reject(new Error('Pairing was closed'));
    if (this.#pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        this.#pc.removeEventListener('icegatheringstatechange', changed);
        this.#cancelIce = null;
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (this.#pc.iceGatheringState === 'complete') finish(); };
      this.#cancelIce = finish;
      this.#pc.addEventListener('icegatheringstatechange', changed);
      timer = setTimeout(() => finish(new Error('ICE gathering timed out after 15 seconds; create a new pairing')), PEER_LIMITS.iceTimeoutMs);
      changed();
    });
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#removers.push(() => target.removeEventListener(type, listener));
  }

  #attach(channel) {
    if (channel.label !== CHANNEL || channel.protocol !== PROTOCOL || channel.ordered !== true
        || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      this.#fail(new Error('Peer requested an unsupported data channel'));
      return;
    }
    this.#channel = channel;
    channel.bufferedAmountLowThreshold = PEER_LIMITS.bufferedBytes / 2;
    this.#listen(channel, 'open', () => this.#opened());
    this.#listen(channel, 'message', ({ data }) => this.#received(data));
    this.#listen(channel, 'bufferedamountlow', () => {
      try { this.#flush(); } catch (error) { this.#fail(error); }
    });
    this.#listen(channel, 'close', () => this.close());
    this.#listen(channel, 'error', () => this.#fail(new Error('Data channel failed; create a new pairing')));
    if (channel.readyState === 'open') this.#opened();
  }

  #opened() {
    if (this.#closed || this.#ready) return;
    try {
      this.#enqueue(this.#getOperations());
      this.#ready = true;
      this.#status('Connected');
    } catch (error) { this.#fail(error); }
  }

  #enqueue(operations) {
    const frames = framesFor(this.#docId, operations);
    const addedBytes = frames.reduce((total, frame) => total + frame.bytes, 0);
    if (this.#outgoingBytes + addedBytes + this.#channel.bufferedAmount > PEER_LIMITS.queuedBytes) {
      throw new RangeError('Outgoing sync exceeds the 16 MiB queue limit; reconnect after the peer recovers');
    }
    this.#outgoing.push(...frames);
    this.#outgoingBytes += addedBytes;
    this.#flush();
  }

  #flush() {
    if (this.#closed || this.#channel?.readyState !== 'open') return;
    while (this.#outgoing.length) {
      const frame = this.#outgoing[0];
      if (this.#channel.bufferedAmount + frame.bytes > PEER_LIMITS.bufferedBytes) return;
      this.#channel.send(frame.data);
      this.#outgoing.shift();
      this.#outgoingBytes -= frame.bytes;
    }
  }

  #received(raw) {
    if (this.#closed) return;
    try {
      const frame = parseBounded(raw, PEER_LIMITS.frameBytes, 'Data frame');
      if (!fields(frame, ['version', 'docId', 'ops']) || frame.version !== 1 || frame.docId !== this.#docId) {
        throw new TypeError('Unsupported data frame or wrong document ID');
      }
      // Each frame is independently mergeable: missing anchors resolve on later frames.
      const operations = new Rga('peer-validation', frame.ops).operations();
      const size = bytes(raw);
      if (this.#incomingCount + 1 > PEER_LIMITS.queuedFrames || this.#incomingBytes + size > PEER_LIMITS.queuedBytes) {
        throw new RangeError('Incoming sync exceeds the receive queue limit');
      }
      this.#incoming.push({ operations, bytes: size });
      this.#incomingCount++;
      this.#incomingBytes += size;
      void this.#processIncoming();
    } catch (error) { this.#fail(error); }
  }

  async #processIncoming() {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (!this.#closed && this.#incoming.length) {
        const frame = this.#incoming.shift();
        await this.#onOperations(frame.operations);
        if (this.#closed) break;
        this.#incomingCount--;
        this.#incomingBytes -= frame.bytes;
      }
    } catch (error) { this.#fail(error); }
    finally { this.#processing = false; }
  }

  #status(message) { try { this.#onStatus(message); } catch { /* UI errors do not affect transport cleanup. */ } }

  #fail(error) {
    if (this.#closed) return;
    try { this.#onError(error instanceof Error ? error : new Error(String(error))); }
    catch { /* Always release the connection, even if error reporting fails. */ }
    this.close();
  }
}
