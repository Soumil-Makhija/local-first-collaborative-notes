import test from 'node:test';
import assert from 'node:assert/strict';
import { Rga, LIMITS } from '../src/crdt.js';

const insertion = (id, after, value) => ({ type: 'insert', id, after, value });
const deletion = (id, target) => ({ type: 'delete', id, target });

test('local inserts, deletes, and replacements preserve index intent and Unicode code points', () => {
  const document = new Rga('writer');
  document.insert(0, 'A😀e\u0301Z');
  document.insert(2, '日本');
  assert.equal(document.text, 'A😀日本e\u0301Z');
  document.delete(1, 3);
  assert.equal(document.text, 'Ae\u0301Z');
  const originalIds = document.visibleIds();
  const change = document.replace('Ae\u0301🙂Z');
  assert.equal(change.length, 1);
  assert.equal(document.text, 'Ae\u0301🙂Z');
  assert.deepEqual(document.visibleIds().filter((id) => originalIds.includes(id)), originalIds);
  assert.deepEqual(document.replace(document.text), []);
  document.insert(0, 'start');
  document.insert([...document.text].length, 'end');
  assert.equal(document.text, 'startAe\u0301🙂Zend');
  document.replace('');
  assert.equal(document.text, '');
  document.insert(0, 'new');
  assert.equal(document.text, 'new');
});

test('concurrent sibling inserts use deterministic descending IDs without interleaving runs', () => {
  const base = new Rga('seed');
  base.insert(0, 'ab');
  const alice = new Rga('alice', base.operations());
  const bob = new Rga('bob', base.operations());
  const a = alice.insert(1, 'XY');
  const b = bob.insert(1, '12');
  alice.merge(b);
  bob.merge(a);
  assert.equal(alice.text, 'a12XYb');
  assert.equal(bob.text, alice.text);
  assert.deepEqual(alice.operations(), bob.operations());
  assert.equal(alice.merge(a).length, 0);
});

test('missing anchors and early tombstones resolve after arbitrary delivery', () => {
  const document = new Rga('viewer');
  document.merge([deletion('5@writer', '2@writer'), insertion('3@writer', '2@writer', 'C')]);
  assert.equal(document.text, '');
  document.merge([insertion('2@writer', '1@writer', 'B')]);
  assert.equal(document.text, '');
  document.merge([insertion('1@writer', null, 'A')]);
  assert.equal(document.text, 'AC');
  assert.deepEqual(document.visibleIds(), ['1@writer', '3@writer']);
  document.insert(1, '!');
  assert.equal(document.text, 'A!C');
  assert.equal(document.operations().at(-1).id, '6@viewer');
});

test('concurrent deletion preserves descendants, concurrent replacements converge', () => {
  const seed = new Rga('seed');
  seed.insert(0, 'hello');
  const alice = new Rga('alice', seed.operations());
  const bob = new Rga('bob', seed.operations());
  const a = alice.delete(1, 2);
  const b = bob.insert(2, 'X');
  alice.merge(b);
  bob.merge(a);
  assert.equal(alice.text, 'hXlo');
  assert.equal(bob.text, alice.text);
  const first = alice.replace('hi');
  const second = bob.replace('hey');
  alice.merge(second);
  bob.merge(first);
  assert.equal(alice.text, bob.text);
  assert.deepEqual(alice.operations(), bob.operations());
});

test('invalid batches are atomic, including conflicts and reference type collisions', () => {
  const document = new Rga('writer');
  document.insert(0, 'a');
  const original = document.operations();
  const invalid = [
    insertion('2@writer', '1@writer', 'b'),
    insertion('1@writer', null, 'z'),
  ];
  assert.throws(() => document.merge(invalid));
  assert.deepEqual(document.operations(), original);
  assert.equal(document.text, 'a');
  assert.throws(() => document.merge([insertion('3@writer', '2@writer', 'c'), deletion('2@writer', '1@writer')]));
  assert.deepEqual(document.operations(), original);
  document.merge([insertion('4@remote', '3@remote', 'd')]);
  const beforeCollision = document.operations();
  assert.throws(() => document.merge([deletion('3@remote', '1@writer')]));
  assert.deepEqual(document.operations(), beforeCollision);
  document.insert(1, '!');
  assert.equal(document.operations().at(-1).id, '5@writer');
});

test('malformed operations, invalid indices, and unsafe payloads never change the document', () => {
  const document = new Rga('actor');
  document.insert(0, 'safe');
  const before = document.operations();
  for (const operation of [
    null, {}, [], { type: 'unknown', id: '9@x' },
    insertion('09@x', null, 'a'), insertion('0@x', null, 'a'),
    insertion('9007199254740992@x', null, 'a'), insertion('9@', null, 'a'),
    insertion('9@x', '9@y', 'a'), insertion('9@x', '10@y', 'a'),
    insertion('9@x', null, ''), insertion('9@x', null, 'ab'),
    insertion('9@x', null, '\ud800'), insertion('9@x', undefined, 'a'),
    { ...insertion('9@x', null, 'a'), extra: true }, deletion('9@x', null),
    deletion('9@x', '9@x'),
  ]) {
    assert.throws(() => document.merge([insertion('8@x', null, 'x'), operation]), JSON.stringify(operation));
    assert.deepEqual(document.operations(), before);
  }
  for (const action of [
    () => document.insert(-1, 'x'), () => document.insert(1.5, 'x'),
    () => document.insert(5, ''), () => document.delete(3, 2),
    () => document.delete(0, -1), () => document.delete(0, 1.2),
    () => document.replace('\udfff'), () => document.insert(0, 'x'.repeat(LIMITS.textCodePoints + 1)),
    () => document.merge({}), () => document.merge(Array(LIMITS.batchOperations + 1)),
  ]) {
    assert.throws(action);
    assert.deepEqual(document.operations(), before);
  }
  assert.throws(() => new Rga(''));
  assert.throws(() => new Rga('a\n'));
  assert.throws(() => new Rga('\ud800'));
  assert.throws(() => new Rga('a'.repeat(LIMITS.actorLength + 1)));
});

test('operations with accessors or hidden fields are rejected without executing accessors', () => {
  const document = new Rga('writer');
  const accessor = insertion('1@remote', null, 'x');
  let accessed = false;
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { accessed = true; return 'x'; } });
  assert.throws(() => document.merge([accessor]), /data properties/u);
  assert.equal(accessed, false);
  const hidden = insertion('1@remote', null, 'x');
  Object.defineProperty(hidden, 'unexpected', { value: true });
  assert.throws(() => document.merge([hidden]));
  const symbolic = insertion('1@remote', null, 'x');
  symbolic[Symbol('unexpected')] = true;
  assert.throws(() => document.merge([symbolic]));
  assert.equal(document.text, '');
});

test('conflicting copies of a valid ID are rejected and operation snapshots are defensive', () => {
  const document = new Rga('writer');
  const returned = document.insert(0, 'a');
  returned[0].value = 'changed';
  const snapshot = document.operations();
  snapshot[0].value = 'changed again';
  assert.equal(document.text, 'a');
  assert.throws(() => document.merge([insertion('1@writer', null, 'b')]));
  assert.throws(() => document.merge([deletion('1@writer', '1@other')]));
  assert.equal(document.text, 'a');
  const copy = document.visibleIds();
  copy.length = 0;
  assert.equal(document.visibleIds().length, 1);
});

test('valid unusual actor IDs round-trip and clock exhaustion fails atomically', () => {
  const document = new Rga('編輯@desk');
  document.insert(0, '🙂');
  assert.equal(new Rga('copy', document.operations()).text, '🙂');
  const exhausted = new Rga('full', [insertion(`${Number.MAX_SAFE_INTEGER}@remote`, null, 'x')]);
  assert.throws(() => exhausted.insert(0, 'y'), /exhausted/u);
  assert.equal(exhausted.text, 'x');
});

test('a deep anchor chain materializes without recursive stack overflow', () => {
  const document = new Rga('long');
  document.insert(0, 'x'.repeat(30_000));
  assert.equal(document.text.length, 30_000);
  document.delete(0, 1);
  assert.equal(document.text.length, 29_999);
  const reverse = new Rga('replay');
  reverse.merge(document.operations().reverse());
  assert.equal(reverse.text, document.text);
});

function generator(seed) {
  let state = seed >>> 0;
  return (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

test('seeded distributed edits converge under delayed, shuffled, duplicated delivery', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const random = generator(seed);
    const replicas = ['alpha', 'beta', 'gamma', 'delta'].map((actor) => new Rga(actor));
    const alphabet = ['a', 'Z', '😀', '\n', 'é', '中'];
    const history = [];
    for (let step = 0; step < 120; step++) {
      const editor = replicas[random(replicas.length)];
      const old = [...editor.text];
      const index = random(old.length + 1);
      let operations;
      if (old.length && random(3) === 0) {
        const at = Math.min(index, old.length - 1);
        operations = editor.delete(at, 1);
        old.splice(at, 1);
      } else {
        const value = alphabet[random(alphabet.length)];
        operations = editor.insert(index, value);
        old.splice(index, 0, value);
      }
      assert.equal(editor.text, old.join(''), `local intent seed ${seed}, step ${step}`);
      history.push(...operations);
      if (random(2) === 0 && history.length) {
        replicas[random(replicas.length)].merge([history[random(history.length)]]);
      }
    }
    for (const replica of replicas) {
      const shuffled = history.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const other = random(i + 1);
        [shuffled[i], shuffled[other]] = [shuffled[other], shuffled[i]];
      }
      for (let offset = 0; offset < shuffled.length; offset += 7) replica.merge(shuffled.slice(offset, offset + 7));
      replica.merge(history);
      assert.equal(replica.text, replicas[0].text, `convergence seed ${seed}`);
      assert.deepEqual(replica.operations(), replicas[0].operations());
    }
    assert.equal(new Rga('reload', JSON.parse(JSON.stringify(replicas[0].operations()))).text, replicas[0].text);
  }
});
