description: Fix a cluster of small storage-layer defects — code that reorders its caller's data, stores a shared object without copying it, keeps a metric that is never updated and hands out its internal counters by reference, casts into another library's private internals, and treats "couldn't read the folder" the same as "folder is empty."
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p-storage-fs/src/file-storage.ts
difficulty: medium
----

# Assorted storage-layer correctness and cleanliness defects

A group of small, independent defects across the storage subsystem. Each is a localized fix;
none warrants its own ticket, but several are genuine correctness bugs, not just style.

**Note on the original ticket:** it pointed at `restoration-coordinator-v2.ts`; the real file is
`restoration-coordinator.ts` (no `-v2` exists — line numbers below were re-derived against HEAD).
The original also claimed a "bare `console.log`" in that file — **there is none**; all logging
already goes through `this.log` (a `createLogger` instance). That sub-item is dropped as stale.

All claims below were verified against the code at HEAD during the fix stage.

## The defects

### 1. In-place sort mutates caller state — `storage-repo.ts:162-165`

```ts
const missing = latest
    ? context.committed.filter(c => c.rev > latest.rev)   // new array — safe
    : context.committed;                                  // ALIAS of caller's array
for (const { actionId, rev } of missing.sort((a, b) => a.rev - b.rev)) {
```

When `latest` is undefined (block has no committed revision yet), `missing` is the caller's
`context.committed` array itself, and `.sort()` reorders it **in place**, mutating the shared
request context. Copy before sorting.

Fix: sort a copy — `[...missing].sort(...)` (or `missing.slice().sort(...)`).

### 2. Missing clone violates the store's own clone-on-store invariant — `memory-storage.ts:102-104`

```ts
async saveTransaction(blockId, actionId, transform): Promise<void> {
    this.actions.set(this.getActionKey(blockId, actionId), transform);   // stores caller's ref
}
```

Every sibling writer in this file clones on store — `savePendingTransaction` (line 82),
`saveMaterializedBlock` (131), `saveMetadata` (43) — and the file's own `@pitfall` docs mandate
it (see the docblocks and `docs/internals.md` "Storage Returns References"). `saveTransaction`
is the lone exception: it stores the caller's reference, so a later caller mutation corrupts
stored state.

Fix: `this.actions.set(key, structuredClone(transform))`.

### 3. Dead metric + reference-leaking getter — `restoration-coordinator.ts:23,178-201`

Two issues (the third, the "bare console.log", does not exist — see note above):

- **`failureByRing` (declared line 23) is never incremented** — dead metric. `recordSuccess`
  (178) updates `successByRing`; nothing updates `failureByRing`. Either increment it where a
  ring is exhausted without yielding the block, or remove it. Recommended: a `recordFailure`
  path is fuzzy here (failures are per-peer-query, and "ring exhausted" is the natural unit) —
  increment `failureByRing[ringDepth]` once per ring that was tried and returned nothing, at the
  points where the inner peer loops complete without returning (the `for ringDepth` loop body,
  and after the `nonSelfMyPeers` loop). If a clean failure unit is not obvious, **remove the
  field** rather than leave it dead — a dishonest metric is worse than an absent one. Decide and
  document which you did.

- **`getMetrics` (194-201) leaks internal Maps** — `return { ...this.metrics }` spreads only the
  top level, so the returned `successByRing` / `failureByRing` are the **same Map instances** the
  coordinator keeps mutating. A caller can mutate them and corrupt internal state, and the
  snapshot changes under the caller's feet.

  Fix: copy the Maps — `successByRing: new Map(this.metrics.successByRing)` (and same for
  `failureByRing`, if kept).

### 4. `ring-selector.ts:95` — fake PeerId is a LIVE CRASH, not just a cast smell

```ts
const coord = await hashPeerId({ toString: () => peerId } as any);
```

`hashPeerId` (in `p2p-fret`, `ring/hash.ts`) does **`peerId.toMultihash().bytes`** — it never
calls `toString()`. The fabricated object has no `toMultihash`, so this **throws
`TypeError: peerId.toMultihash is not a function` every time `calculatePartition` runs with
`ringDepth >= 1`**. It is reachable in production: `RingSelector.createArachnodeInfo` calls
`calculatePartition` (ring-selector.ts:110-112) and is invoked during node bring-up and on
capacity updates (`libp2p-node-base.ts:885` and `:1000`), so a node that computes any ring depth
≥ 1 rejects there.

This is masked in tests: `ring-selector.spec.ts` wraps every `calculatePartition` call in
`try/catch` with comments like "hashPeerId might fail for non-multiaddr peer IDs - that's
acceptable" — those catches are hiding a real, always-on failure.

Root cause: the caller passes a peer id **string** (`peerId.toString()` from libp2p), but
`hashPeerId` needs a real `PeerId`. `restoration-coordinator.ts:160` already shows the pattern:
`peerIdFromString(peerIdStr)` from `@libp2p/peer-id`.

Fix: `const coord = await hashPeerId(peerIdFromString(peerId));` (import `peerIdFromString`).
Then **tighten the spec**: replace the swallow-the-error `try/catch` blocks around
`calculatePartition` with assertions that partitions are actually produced for real peer-id
strings — the current tests would pass even with the function fully broken.

Caveat to check while implementing: the spec passes literal strings like `'some-peer-id'` /
`'peer-4'`, which are **not** valid base58 peer ids — `peerIdFromString` will reject them too.
The test fix therefore needs real/encodable peer-id strings (generate a key pair, or use a known
valid peer-id constant already used elsewhere in the db-p2p tests — grep for `peerIdFromString`
and `createEd25519PeerId` in `packages/db-p2p/test`). If a valid peer id is impractical in that
unit test, at minimum assert the failure is surfaced rather than swallowed.

### 5. `arachnode-fret-adapter.ts:59` — `as any` into FRET internals

```ts
const myPeerId = (this.fret as any).node?.peerId?.toString();
```

`FretService` (the public interface in `p2p-fret`, `index.ts:90-120`) exposes **no** self-peer
accessor, so this reaches into the concrete impl's private `.node`. Fragile: any impl that lacks
`.node` silently yields `undefined`, and `getMyArachnodeInfo` (and thus `setStatus`) then no-ops.

Recommended fix: **inject the self peer id** into the adapter instead of poking internals. Add an
optional `selfPeerId?: string` constructor param to `ArachnodeFretAdapter` and use it in
`getMyArachnodeInfo`. Both construction sites have the peer id in scope:
`libp2p-node-base.ts:872` (the `peerId` used at `:885`) and `reference-peer/src/cli.ts:160`
(verify the peer id is available there; the libp2p node's `peerId` should be). Keep the
`(this.fret as any).node` read as a fallback **only if** a call site genuinely cannot supply the
id, and in that case add a one-line comment explaining why the cast is load-bearing.

If constructor injection turns out to touch more call sites than expected, the acceptable minimum
is: narrow the cast to a named local type (e.g. `{ node?: { peerId?: { toString(): string } } }`)
and add a comment that it depends on the `Libp2pFretService` shape — no bare `as any`.

### 6. `file-storage.ts:70-83` — readdir swallows all errors as "no pendings"

```ts
const files = await fs.readdir(pendingPath)
    .catch((err) => { log('... readdir failed ...'); return [] as string[]; });   // ANY error -> empty
```

Any `readdir` failure (transient `EACCES`, `EIO`, …) is reported as an empty directory, so
`listPendingTransactions` silently returns "no pending transactions" and `pend`'s conflict
detection is skipped — a correctness hazard, not just noise. Only `ENOENT` (directory absent)
should map to empty; other errors must surface.

Fix: in the `.catch`, rethrow when `code !== 'ENOENT'`; return `[]` only for `ENOENT`. Mirror the
existing pattern already used in this same file at `directoryByteSize` (lines 136-140), which
does exactly this ENOENT-vs-other discrimination.

Second, smaller concern (line 80): the id-scheme regex
`/^(?:[\w\d]+-[\w\d]+-...|(?:tx|stamp):[A-Za-z0-9_-]+)$/` silently drops any filename whose id
doesn't match legacy-UUID or `tx:`/`stamp:` shape, so a future id scheme would vanish from the
listing with no signal. **Loosen or document.** Lowest-risk option: keep the filter but `log()`
a warning when a `.json` file is skipped by the regex, so a new id format leaves a breadcrumb
instead of disappearing. (Do not broaden it to accept everything — the `.json` + decode guard is
what keeps stray files out; just make a skip observable.)

## Reproduction notes (turn these into tests)

- **#1:** build a `BlockGets` context whose block has no committed `latest`, with
  `context.committed` in a deliberately non-ascending `rev` order; call `StorageRepo.get`; assert
  `context.committed`'s element order/identity is unchanged afterward.
- **#2:** `saveTransaction` an object into `MemoryRawStorage`, mutate the caller's reference, then
  `getTransaction` and assert the stored value is unchanged. (Pattern: `block-storage.spec.ts`,
  `file-storage.spec.ts`.)
- **#3:** after some `recordSuccess`, call `getMetrics`, mutate the returned `successByRing`, call
  `getMetrics` again, assert the second snapshot is unaffected.
- **#4:** call `RingSelector.calculatePartition(ringDepth>=1, <valid-peer-id-string>)` and assert
  it resolves to a partition (no throw). This test **fails today** and passes after the fix.
- **#6:** point `listPendingTransactions` at a path that fails with a non-ENOENT code (e.g. a file
  where a directory is expected → `ENOTDIR`, or a stubbed `fs.readdir` rejecting with `EACCES`)
  and assert it rejects rather than yielding nothing; and that a genuinely-absent dir (`ENOENT`)
  still yields empty.

## TODO

- [ ] storage-repo.ts: sort a copy of `missing`, not the possible `context.committed` alias.
- [ ] memory-storage.ts: `structuredClone(transform)` in `saveTransaction`.
- [ ] restoration-coordinator.ts: either increment `failureByRing` at ring-exhaustion points or
      remove the field; document the choice. Return `new Map(...)` copies from `getMetrics`.
- [ ] ring-selector.ts: `hashPeerId(peerIdFromString(peerId))`; import `peerIdFromString`.
- [ ] ring-selector.spec.ts: replace the error-swallowing `try/catch` around `calculatePartition`
      with real assertions using valid peer-id strings.
- [ ] arachnode-fret-adapter.ts: inject `selfPeerId` via constructor (preferred) or narrow the
      cast to a named type with a justifying comment; wire the two construction sites.
- [ ] file-storage.ts: rethrow non-ENOENT from the `listPendingTransactions` readdir catch; make
      regex-skipped `.json` files log a warning (or document the filter).
- [ ] Add the reproduction tests above.
- [ ] Validate: from `packages/db-p2p` run `yarn test 2>&1 | tee /tmp/db-p2p-test.log` (or the
      package's test script) and from `packages/db-p2p-storage-fs` run its test script; type-check
      both packages. Stream output — do not silently redirect.
