/** A compact operation-based replicated growable array, indexed by Unicode code points. */
export const LIMITS = Object.freeze({
  actorLength: 128,
  textCodePoints: 100_000,
  batchOperations: 200_000,
  totalOperations: 200_000,
});

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const compare = (a, b) => a.clock - b.clock || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);
const clone = (operation) => ({ ...operation });

function validUnicode(text) {
  for (const point of text) {
    const code = point.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

function validateActor(actor) {
  if (typeof actor !== 'string' || actor.length === 0 || actor.length > LIMITS.actorLength
      || /[\u0000-\u001f\u007f]/u.test(actor) || !validUnicode(actor)) {
    throw new TypeError(`Actor must be a nonempty Unicode string of at most ${LIMITS.actorLength} UTF-16 units without control characters`);
  }
  return actor;
}

function parseId(id) {
  if (typeof id !== 'string' || id.length > LIMITS.actorLength + 17) {
    throw new TypeError('Operation ID must be clock@actor');
  }
  const separator = id.indexOf('@');
  const clockText = id.slice(0, separator);
  const clock = Number(clockText);
  if (separator < 1 || !/^[1-9]\d{0,15}$/u.test(clockText) || !Number.isSafeInteger(clock)) {
    throw new TypeError('Operation clock must be a canonical positive safe integer');
  }
  return { clock, actor: validateActor(id.slice(separator + 1)) };
}

function validateOperation(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Each operation must be an object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !own(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    throw new TypeError('Operation fields must be enumerable data properties');
  }
  const expected = input.type === 'insert' ? ['type', 'id', 'after', 'value']
    : input.type === 'delete' ? ['type', 'id', 'target'] : null;
  if (!expected || keys.length !== expected.length || !expected.every((key) => own(input, key))) {
    throw new TypeError('Operation has an unknown type or unexpected fields');
  }
  const identity = parseId(input.id);
  let reference = null;
  let operation;
  if (input.type === 'insert') {
    if (typeof input.value !== 'string' || input.value.length > 2
        || [...input.value].length !== 1 || !validUnicode(input.value)) {
      throw new TypeError('An insertion value must contain exactly one Unicode code point');
    }
    if (input.after !== null) reference = parseId(input.after);
    operation = { type: 'insert', id: input.id, after: input.after, value: input.value };
  } else {
    reference = parseId(input.target);
    operation = { type: 'delete', id: input.id, target: input.target };
  }
  // This causal clock constraint rejects cycles without traversing untrusted ancestry.
  if (reference && reference.clock >= identity.clock) {
    throw new TypeError('An operation reference must have a strictly earlier Lamport clock');
  }
  return { ...identity, operation: Object.freeze(operation) };
}

function equivalent(a, b) {
  return a.type === b.type && a.id === b.id
    && (a.type === 'insert' ? a.after === b.after && a.value === b.value : a.target === b.target);
}

function points(text) {
  if (typeof text !== 'string' || text.length > LIMITS.textCodePoints * 2 || !validUnicode(text)) {
    throw new TypeError('Text must be a valid Unicode string within the configured limit');
  }
  const result = [...text];
  if (result.length > LIMITS.textCodePoints) throw new RangeError('Text exceeds the code point limit');
  return result;
}

function indexIn(index, length) {
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new RangeError('Index must be an integer within the visible text');
  }
}

export class Rga {
  #actor;
  #clock = 0;
  #entries = new Map();
  #requiredInsertIds = new Set();
  #cache = null;

  constructor(actor, operations = []) {
    this.#actor = validateActor(actor);
    this.merge(operations);
  }

  get actor() { return this.#actor; }

  get text() { return this.#view().values.join(''); }

  /** A defensive copy, in deterministic ascending (clock, actor) order. */
  operations() {
    return [...this.#entries.values()].sort(compare).map((entry) => clone(entry.operation));
  }

  visibleIds() { return this.#view().ids.slice(); }

  /** Validate the entire batch before changing any state; exact duplicates are harmless. */
  merge(operations) {
    if (!Array.isArray(operations)) throw new TypeError('Operations must be an array');
    if (operations.length > LIMITS.batchOperations) throw new RangeError('Operation batch exceeds the limit');
    const additions = new Map();
    const references = new Set();
    for (const input of operations) {
      const entry = validateOperation(input);
      const existing = this.#entries.get(entry.operation.id) || additions.get(entry.operation.id);
      if (existing) {
        if (!equivalent(existing.operation, entry.operation)) throw new TypeError(`Conflicting operation ID: ${entry.operation.id}`);
        continue;
      }
      additions.set(entry.operation.id, entry);
      const reference = entry.operation.type === 'insert' ? entry.operation.after : entry.operation.target;
      if (reference !== null) references.add(reference);
    }
    if (this.#entries.size + additions.size > LIMITS.totalOperations) throw new RangeError('Operation history exceeds the limit');
    for (const reference of references) {
      const target = additions.get(reference) || this.#entries.get(reference);
      if (target && target.operation.type !== 'insert') throw new TypeError('Operation references must identify insertions');
    }
    for (const [id, entry] of additions) {
      if (entry.operation.type === 'delete' && (references.has(id) || this.#requiredInsertIds.has(id))) {
        throw new TypeError('A referenced insertion ID cannot be used by a deletion');
      }
    }
    for (const [id, entry] of additions) {
      this.#entries.set(id, entry);
      this.#clock = Math.max(this.#clock, entry.clock);
    }
    for (const reference of references) this.#requiredInsertIds.add(reference);
    if (additions.size) this.#cache = null;
    return [...additions.values()].map((entry) => clone(entry.operation));
  }

  insert(index, text) {
    const view = this.#view();
    indexIn(index, view.ids.length);
    const values = points(text);
    this.#capacity(values.length);
    const operations = [];
    let after = index === 0 ? null : view.ids[index - 1];
    let clock = this.#clock;
    for (const value of values) {
      const id = `${++clock}@${this.#actor}`;
      operations.push({ type: 'insert', id, after, value });
      after = id;
    }
    return this.merge(operations);
  }

  delete(index, count) {
    const ids = this.#view().ids;
    indexIn(index, ids.length);
    if (!Number.isSafeInteger(count) || count < 0 || count > ids.length - index) {
      throw new RangeError('Delete count must fit within the visible text');
    }
    this.#capacity(count);
    let clock = this.#clock;
    return this.merge(ids.slice(index, index + count).map((target) => ({ type: 'delete', id: `${++clock}@${this.#actor}`, target })));
  }

  /** Preserve the common code-point prefix/suffix and replace only the changed middle. */
  replace(text) {
    const next = points(text);
    const current = this.#view();
    let prefix = 0;
    while (prefix < current.values.length && prefix < next.length && current.values[prefix] === next[prefix]) prefix++;
    let suffix = 0;
    while (suffix < current.values.length - prefix && suffix < next.length - prefix
      && current.values[current.values.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
    const deleted = current.ids.slice(prefix, current.ids.length - suffix);
    const inserted = next.slice(prefix, next.length - suffix);
    this.#capacity(deleted.length + inserted.length);
    let clock = this.#clock;
    const operations = deleted.map((target) => ({ type: 'delete', id: `${++clock}@${this.#actor}`, target }));
    let after = prefix === 0 ? null : current.ids[prefix - 1];
    for (const value of inserted) {
      const id = `${++clock}@${this.#actor}`;
      operations.push({ type: 'insert', id, after, value });
      after = id;
    }
    return this.merge(operations);
  }

  #capacity(count) {
    if (count > LIMITS.batchOperations || this.#entries.size + count > LIMITS.totalOperations) {
      throw new RangeError('Edit would exceed the operation history limit');
    }
    if (count > Number.MAX_SAFE_INTEGER - this.#clock) throw new RangeError('Lamport clock is exhausted');
  }

  #view() {
    if (this.#cache) return this.#cache;
    const children = new Map();
    const deleted = new Set();
    for (const entry of this.#entries.values()) {
      const operation = entry.operation;
      if (operation.type === 'delete') {
        deleted.add(operation.target);
      } else {
        const siblings = children.get(operation.after) || [];
        siblings.push(entry);
        children.set(operation.after, siblings);
      }
    }
    for (const siblings of children.values()) siblings.sort((a, b) => compare(b, a));
    const stack = [...(children.get(null) || [])].reverse();
    const ids = [];
    const values = [];
    // Iteration also handles very long single-anchor chains without a call-stack limit.
    while (stack.length) {
      const { operation } = stack.pop();
      if (!deleted.has(operation.id)) {
        ids.push(operation.id);
        values.push(operation.value);
      }
      const descendants = children.get(operation.id) || [];
      for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }
    this.#cache = { ids, values };
    return this.#cache;
  }
}
