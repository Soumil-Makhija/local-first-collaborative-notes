# Sequence CRDT

`src/crdt.js` implements a replicated growable array (RGA), rather than wrapping a CRDT library. Each writer needs a unique actor string. In the browser application, create a new writer identity for every editing session: sharing an actor between independently editing replicas can produce conflicting IDs.

```js
const note = new Rga('unique-writer');
const additions = note.insert(0, 'Hello 😀');
otherReplica.merge(additions);
note.delete(0, 1);
note.replace('Updated text');
console.log(note.text, note.visibleIds(), note.operations());
```

The constructor accepts an optional operation array for restoration. `insert(index, text)`, `delete(index, count)`, `replace(text)`, and `merge(operations)` return arrays of newly accepted operations. All text positions and counts use Unicode code points. A combining mark is its own code point; indices are not grapheme clusters. `replace` preserves the unchanged prefix and suffix and emits edits for the changed middle. `operations()` returns a canonical ascending `(clock, actor)` snapshot, and `visibleIds()` returns visible insertion IDs. Returned arrays and objects are defensive copies.

An insertion is `{type: 'insert', id: '1@writer', after: null, value: 'H'}`. A deletion is `{type: 'delete', id: '2@writer', target: '1@writer'}`. An ID consists of a canonical positive safe-integer Lamport clock, `@`, and the actor; the first `@` is the separator. The actor may itself contain `@` and Unicode, must contain 1–128 UTF-16 units, and cannot contain ASCII controls or unpaired surrogates. Every insertion value is exactly one valid Unicode code point. Additional operation fields are rejected to avoid silently interpreting unsupported formats.

Insertions form an anchor tree. The root anchor is `null`; siblings sort by descending `(clock, actor)`, using deterministic JavaScript string comparison for actors. Iterative depth-first traversal emits a node before its children. A new local insertion at a visible index anchors to the preceding visible insertion and has a greater clock than every observed operation, so it appears at the requested local position. A multi-character insertion chains its characters, keeping concurrent inserted runs together. Tombstones hide an insertion while retaining its descendants. Concurrent edits converge, but a conflict is not necessarily the text either author would have produced alone.

Merge is commutative, associative, and idempotent for valid compatible histories. Missing anchors and deletion targets are retained and resolve when their insertions arrive. All references must have strictly smaller Lamport clocks than the referring operation, which makes cycles impossible even with missing anchors. A reference must identify an insertion when known. Exact duplicate operations are harmless; reusing an ID for different content is an error. The entire incoming batch is validated before mutation, including conflicts, type collisions, and limits. A rejected batch leaves the log, text, and Lamport clock unchanged.

The exported `LIMITS` bounds each text argument to 100,000 code points and each batch and total history to 200,000 events. Edits that exceed a bound or exhaust the safe-integer clock fail atomically. Input text must be well-formed Unicode. History includes tombstones and is never automatically compacted; a long-lived heavily edited document may reach the history limit even when its visible text is short. This implementation rebuilds a cached visible sequence after accepted changes, with sorting cost up to `O(n log n)`, and retains `O(n)` history. It favors a reviewable, dependency-free implementation over large-document performance. Actor identity and IDs prevent accidental duplication, not malicious impersonation; the transport and persistence layers must provide their own access control and durability.

The anchor-tree approach is inspired by the sequence CRDTs discussed in Shapiro et al., [A comprehensive study of Convergent and Commutative Replicated Data Types](https://pages.lip6.fr/Marc.Shapiro/papers/Comprehensive-CRDTs-RR7506-2011-01.pdf). This small implementation and its validation rules are specific to this repository; its randomized tests are not a formal proof.
