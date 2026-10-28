import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Rga } from '../src/crdt.js';
import { PeerSession, PEER_LIMITS, parseSignal } from '../src/peer.js';

const byteLength = (text) => new TextEncoder().encode(text).byteLength;
const signal = (type = 'offer', docId = 'doc-1') => JSON.stringify({ version: 1, docId, description: { type, sdp: 'v=0\r\ns=fake-test-session\r\n' } });
const frame = (ops, docId = 'doc-1') => JSON.stringify({ version: 1, docId, ops });
const insertion = (id, value = 'x', after = null) => ({ type: 'insert', id, after, value });
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeChannel extends EventTarget {
  label = 'notes-v1';
  protocol = 'notes-crdt-v1';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = [];
  largestBuffer = 0;
  send(data) {
    assert.equal(this.readyState, 'open');
    this.sent.push(data);
    this.bufferedAmount += byteLength(data);
    this.largestBuffer = Math.max(this.largestBuffer, this.bufferedAmount);
  }
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  receive(data) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event('bufferedamountlow')); }
}

class FakeRTC extends EventTarget {
  static instances = [];
  static gatheringState = 'complete';
  signalingState = 'stable';
  connectionState = 'new';
  localDescription = null;
  remoteDescription = null;
  constructor(configuration) {
    super();
    this.configuration = configuration;
    this.iceGatheringState = FakeRTC.gatheringState;
    FakeRTC.instances.push(this);
  }
  createDataChannel(label, options) {
    this.channel = Object.assign(new FakeChannel(), { label, ...options });
    return this.channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\ns=offer\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\ns=answer\r\n' }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  receiveChannel(channel = new FakeChannel()) {
    const event = new Event('datachannel');
    Object.defineProperty(event, 'channel', { value: channel });
    this.dispatchEvent(event);
    return channel;
  }
  finishGathering() { this.iceGatheringState = 'complete'; this.dispatchEvent(new Event('icegatheringstatechange')); }
  close() { this.connectionState = 'closed'; this.dispatchEvent(new Event('connectionstatechange')); }
}

const nativeRTC = globalThis.RTCPeerConnection;
let sessions;
beforeEach(() => { globalThis.RTCPeerConnection = FakeRTC; FakeRTC.instances = []; FakeRTC.gatheringState = 'complete'; sessions = []; });
afterEach(() => { for (const session of sessions) session.close(); globalThis.RTCPeerConnection = nativeRTC; });

function make(overrides = {}) {
  const errors = [];
  const statuses = [];
  const received = [];
  const session = new PeerSession({
    docId: 'doc-1', getOperations: () => [], onOperations: (ops) => { received.push(ops); },
    onError: (error) => errors.push(error), onStatus: (status) => statuses.push(status), ...overrides,
  });
  sessions.push(session);
  return { session, pc: FakeRTC.instances.at(-1), errors, statuses, received };
}

async function connected(overrides) {
  const result = make(overrides);
  await result.session.createOffer();
  await result.session.acceptAnswer(signal('answer'));
  result.pc.channel.open();
  assert.equal(result.session.connected, true);
  return { ...result, channel: result.pc.channel };
}

test('signals require exact versioned JSON shapes and bounded UTF-8 strings', () => {
  assert.equal(parseSignal(signal()).description.type, 'offer');
  assert.equal(parseSignal(signal('answer', 'doc_abc-123')).docId, 'doc_abc-123');
  for (const raw of [null, '{}', 'not JSON', JSON.stringify({ ...JSON.parse(signal()), version: 2 }),
    JSON.stringify({ ...JSON.parse(signal()), extra: true }),
    JSON.stringify({ version: 1, docId: '', description: { type: 'offer', sdp: 'v=0' } }),
    JSON.stringify({ version: 1, docId: '日本@doc', description: { type: 'offer', sdp: 'v=0' } }),
    JSON.stringify({ version: 1, docId: 'doc-1', description: { type: 'rollback', sdp: 'v=0' } }),
    JSON.stringify({ version: 1, docId: 'doc-1', description: { type: 'offer', sdp: '' } }),
    JSON.stringify({ version: 1, docId: 'doc-1', description: { type: 'offer', sdp: '🙂'.repeat(PEER_LIMITS.signalBytes / 3) } }),
  ]) assert.throws(() => parseSignal(raw));
});

test('offer and answer use no ICE servers, wait for complete gathering, and bind the document', async () => {
  FakeRTC.gatheringState = 'gathering';
  const offerer = make();
  let resolved = false;
  const pending = offerer.session.createOffer().then((result) => { resolved = true; return result; });
  await tick();
  assert.equal(resolved, false);
  assert.deepEqual(offerer.pc.configuration, { iceServers: [] });
  offerer.pc.finishGathering();
  const offer = await pending;
  assert.equal(parseSignal(offer).description.type, 'offer');
  assert.equal(offerer.pc.channel.ordered, true);
  FakeRTC.gatheringState = 'complete';
  const answerer = make();
  const answer = await answerer.session.acceptOffer(offer);
  assert.equal(parseSignal(answer).description.type, 'answer');
  await offerer.session.acceptAnswer(answer);
  assert.equal(offerer.pc.remoteDescription.type, 'answer');
  await assert.rejects(offerer.session.acceptAnswer(answer), /outstanding offer/);
  assert.equal(offerer.pc.connectionState, 'closed');
  const wrong = make();
  await assert.rejects(wrong.session.acceptOffer(signal('offer', 'other-doc')), /different document/);
  assert.equal(wrong.pc.connectionState, 'closed');
});

test('closing cancels an outstanding ICE gather and releases the connection', async () => {
  FakeRTC.gatheringState = 'gathering';
  const { session, pc } = make();
  const pending = session.createOffer();
  await tick();
  session.close();
  await assert.rejects(pending, /closed/);
  pc.finishGathering();
  assert.equal(session.connected, false);
  assert.equal(pc.connectionState, 'closed');
});

test('incomplete ICE gathering times out at the documented 15 second limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeRTC.gatheringState = 'gathering';
  const { session, pc, errors } = make();
  const pending = session.createOffer();
  const rejected = assert.rejects(pending, /timed out after 15 seconds/);
  await tick();
  t.mock.timers.tick(PEER_LIMITS.iceTimeoutMs);
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(pc.connectionState, 'closed');
});

test('answerers accept exactly one reliable ordered protocol channel', async () => {
  const good = make();
  await good.session.acceptOffer(signal());
  const channel = good.pc.receiveChannel();
  channel.open();
  assert.equal(good.session.connected, true);
  const duplicate = good.pc.receiveChannel();
  assert.equal(duplicate.readyState, 'closed');
  assert.equal(good.session.connected, false);
  assert.match(good.errors[0].message, /Unexpected/);
  for (const changes of [{ ordered: false }, { label: 'other' }, { protocol: '' }, { maxRetransmits: 1 }]) {
    const invalid = make();
    await invalid.session.acceptOffer(signal());
    const candidate = Object.assign(new FakeChannel(), changes);
    invalid.pc.receiveChannel(candidate);
    assert.equal(candidate.readyState, 'closed');
    assert.equal(invalid.pc.connectionState, 'closed');
  }
  const idle = make();
  idle.pc.receiveChannel();
  assert.match(idle.errors[0].message, /Unexpected/);
});

test('opening takes a fresh full log including edits made before connection', async () => {
  const document = new Rga('writer');
  document.insert(0, 'before');
  const { session, pc } = make({ getOperations: () => document.operations() });
  await session.createOffer();
  assert.equal(session.send(document.insert(6, ' open')), false);
  pc.channel.open();
  const restored = new Rga('copy');
  for (const raw of pc.channel.sent) restored.merge(JSON.parse(raw).ops);
  assert.equal(restored.text, 'before open');
  const edits = document.insert(11, '!');
  assert.equal(session.send(edits), true);
  restored.merge(JSON.parse(pc.channel.sent.at(-1)).ops);
  assert.equal(restored.text, document.text);
});

test('UTF-8 framing, queued backpressure and independently mergeable frames preserve the log', async () => {
  const document = new Rga('writer');
  document.insert(0, '🙂日本'.repeat(2000));
  const sender = await connected({ getOperations: () => document.operations() });
  assert.ok(sender.channel.bufferedAmount <= PEER_LIMITS.bufferedBytes);
  const initialFrames = sender.channel.sent.length;
  for (let i = 0; i < 10; i++) sender.channel.drain();
  assert.ok(sender.channel.sent.length > initialFrames, 'drain must resume the paused queue');
  assert.ok(sender.channel.largestBuffer <= PEER_LIMITS.bufferedBytes);
  assert.ok(sender.channel.sent.length > 1);
  assert.ok(sender.channel.sent.every((raw) => byteLength(raw) <= PEER_LIMITS.frameBytes));
  const restored = new Rga('receiver');
  const receiver = await connected({ onOperations: async (ops) => { restored.merge(ops); } });
  for (const raw of sender.channel.sent.toReversed()) receiver.channel.receive(raw);
  await tick();
  assert.equal(restored.text, document.text);
  assert.deepEqual(restored.operations(), document.operations());
  assert.equal(receiver.errors.length, 0);
});

test('malformed, oversized, cross-document, binary, and invalid-operation frames close the session', async () => {
  for (const raw of ['bad JSON', frame([], 'wrong'), JSON.stringify({ version: 2, docId: 'doc-1', ops: [] }),
    JSON.stringify({ version: 1, docId: 'doc-1', ops: [], extra: true }), new ArrayBuffer(1),
    'x'.repeat(PEER_LIMITS.frameBytes + 1), frame([insertion('1@x', 'ab')]),
    frame([insertion('01@x')]), frame([insertion('1@x', 'x', '2@x')]),
  ]) {
    const peer = await connected();
    peer.channel.receive(raw);
    assert.equal(peer.session.connected, false);
    assert.equal(peer.errors.length, 1);
    assert.equal(peer.received.length, 0);
  }
});

test('incoming callbacks serialize, and close discards callbacks that have not started', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const peer = await connected({ onOperations: async (ops) => { seen.push(ops[0].id); await gate; } });
  peer.channel.receive(frame([insertion('1@x')]));
  peer.channel.receive(frame([insertion('2@x')]));
  assert.deepEqual(seen, ['1@x']);
  release();
  await tick();
  assert.deepEqual(seen, ['1@x', '2@x']);
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const cancelled = [];
  const second = await connected({ onOperations: async (ops) => { cancelled.push(ops[0].id); await secondGate; } });
  second.channel.receive(frame([insertion('1@y')]));
  second.channel.receive(frame([insertion('2@y')]));
  second.session.close();
  releaseSecond();
  await tick();
  assert.deepEqual(cancelled, ['1@y']);
  second.channel.receive(frame([insertion('3@y')]));
  assert.deepEqual(cancelled, ['1@y']);
});

test('receive queue and outgoing queue limits fail closed instead of dropping edits silently', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const receiver = await connected({ onOperations: () => gate });
  for (let i = 0; i <= PEER_LIMITS.queuedFrames; i++) receiver.channel.receive(frame([]));
  assert.equal(receiver.session.connected, false);
  assert.match(receiver.errors[0].message, /receive queue limit/);
  release();
  await tick();
  const sender = await connected();
  sender.channel.bufferedAmount = PEER_LIMITS.bufferedBytes;
  const big = new Rga('a'.repeat(128));
  big.insert(0, 'x'.repeat(30_000));
  let sent = 0;
  assert.throws(() => { while (sent++ < 10) sender.session.send(big.operations()); }, /queue limit/);
  assert.equal(sender.session.connected, false);
  assert.equal(sender.channel.sent.length, 0);
});

test('CRDT application failures close the transport and preserve error evidence', async () => {
  const document = new Rga('local');
  document.insert(0, 'safe');
  const peer = await connected({ onOperations: (ops) => document.merge(ops) });
  peer.channel.receive(frame([insertion('1@local', 'X')]));
  await tick();
  assert.equal(peer.session.connected, false);
  assert.match(peer.errors[0].message, /Conflicting operation ID/);
  assert.equal(document.text, 'safe');
});
