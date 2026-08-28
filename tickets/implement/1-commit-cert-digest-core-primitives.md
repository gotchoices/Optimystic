description: First slice of the commit content-digest work — give the core library the ability to hash a block's agreed content and to compute, from staged local changes only, what each block will contain after commit.
files: packages/db-core/src/blocks/helpers.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/utility/lru-map.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/index.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/quorum-restore.spec.ts
difficulty: hard
----

# Commit content digest — part 1 of 3: core primitives

Split from `commit-cert-bind-block-content-digest` (see that ticket's full rationale, reproduced in
brief here; parts 2 and 3 are `commit-cert-digest-threading` and `commit-cert-digest-member-check`).
The overall goal: the client that authors a transaction also declares the canonical hash of the block
content each id will materialize to, inside the commit operation, so cohort signatures bind content —
and members check the declaration before approving. This part builds the primitives; **no behavior
changes yet** beyond the moved hash helper.

Investigation for the whole feature is DONE — findings below are verified against the code as of this
split. Trust them; do not re-derive.

## Task 1: promote `canonicalBlockHash` into db-core

Today at `packages/db-p2p/src/cluster/quorum-restore.ts:163`, with its private `canonicalJson` at
`:154`. Move BOTH into `packages/db-core/src/blocks/helpers.ts` (tiny file, 2 functions today; already
exported via the blocks barrel `blocks/index.ts` → `helpers.js` → root `index.ts`). db-core already
depends on `multiformats` and `uint8arrays` (verified in its package.json), so the imports
(`sha256` from `multiformats/hashes/sha2`, `toString` from `uint8arrays`) move cleanly.

Update the importers — leave NO copy behind (a drifted hash reports honest content as forged):

- `packages/db-p2p/src/cluster/quorum-restore.ts` — delete the two functions; it does not use
  `canonicalBlockHash` internally (`selectQuorumBlock` takes precomputed hashes), so it just loses
  the export. Its doc comments referencing the function can stay pointing at db-core.
- `packages/db-p2p/src/cluster/reconcile-block.ts:7-9` imports it from `./quorum-restore.js`
  (used at `:138`) — switch that one name to `@optimystic/db-core`.
- `packages/db-p2p/test/quorum-restore.spec.ts:15-17` imports it too (tests at `:331-389`) — switch
  the import; the tests themselves stay.

## Task 2: digest types

In `packages/db-core/src/network/struct.ts`, beside `CommitRequest` (line ~100):

```ts
/** What one block will materialize to at the committing revision, declared by the client that
 *  authored the transforms. */
export type BlockContentDigest = {
	/** base64url SHA-256 of canonicalJson(block) - see canonicalBlockHash. */
	digest: string;
	/** Committed revision of the base the digest was computed from. ABSENT when the block's
	 *  transform carries an insert, which makes the result base-independent and therefore
	 *  checkable by every member regardless of how far behind it is. */
	baseRev?: number;
};

/** Per-block content declarations riding on a commit. Optional per id: a block the client cannot
 *  digest without a network read is simply omitted, and falls back to corroboration downstream. */
export type BlockContentDigests = Record<BlockId, BlockContentDigest>;
```

Add `blockDigests?: BlockContentDigests` to:
- `CommitRequest` (`network/struct.ts:100`), and
- `RepoCommitRequest` (`network/i-repo.ts:26` — it imports types from `../index.js`; add to that list).

Verified wire path (why this is all that's needed): `NetworkTransactor.commitBlocks` sends a
`RepoCommitRequest` per peer → `RepoClient.commit` (db-p2p `src/repo/client.ts:43-48`) wraps the
request object verbatim into `RepoMessage` as `{ commit: request }` → `CoordinatorRepo.commit`
(`coordinator-repo.ts:1395-1398`) puts the received request into the consensus message. The cluster
hash helpers (`computeClusterMessageHash`/`PromiseHash`/`CommitHash` in
`db-core/src/cluster/membership.ts`) canonicalise the whole message generically, so the new field is
folded into every hash and covered by every signature with NO change to those helpers, and an
un-upgraded peer recomputes the changed preimage correctly.

## Task 3: `CacheSource.peek` / `getCachedRevision` (+ recency-neutral LRU read)

`LruMap.get` (`db-core/src/utility/lru-map.ts:13-21`) bumps recency (delete + re-insert). A digest
pass must not reshape eviction order, so first add to `LruMap`:

```ts
/** Read without refreshing recency — for observation passes that must not reshape eviction order. */
peek(key: K): V | undefined { return this.map.get(key); }
```

Then on `CacheSource` (`db-core/src/transform/cache-source.ts` — it holds `cache: LruMap` and
`revisions: Map`):

```ts
/** The block currently cached for `id`, without consulting the source. Cloned (callers apply ops
 *  to it) and recency-neutral (LruMap.peek). */
peek(id: BlockId): T | undefined
/** The committed revision of the content currently cached for `id`. */
getCachedRevision(id: BlockId): number | undefined
```

`getCachedRevision` reads the SAME `revisions` map `tryGet` re-emits on a hit — that value originates
from `GetBlockResult.materializedRev` (`transactor-source.ts:92`, via the `getReadRevision` probe),
which is the revision the content was materialized at, i.e. the number a member compares against its
own `latest.rev`. Do NOT substitute `state.latest.rev`. Known quirk (documented at
`cache-source.ts:36-38`): an LRU-evicted id can leave a stale `revisions` entry — harmless here,
because `peek` returns `undefined` for the evicted id, so a stale revision never pairs with a peeked
block (callers must require BOTH).

## Task 4: `Tracker.peekMaterialized`

On `Tracker` (`db-core/src/transform/tracker.ts`):

```ts
/** The block `id` materializes to under the staged transforms, computed WITHOUT loading from the
 *  source, plus the committed revision of the base used. `undefined` when not computable here. */
peekMaterialized(id: BlockId): { block: IBlock; baseRev?: number } | undefined
```

Design decisions already settled during investigation:

- Build the per-block transform with `transformForBlockId(this.transforms, id)` and materialize with
  the canonical `applyTransform` (`transform/helpers.ts:138`) — the exact function the member side
  (`StorageRepo.internalCommit`) uses — so client and member can never disagree on semantics
  (insert replaces the block, then updates apply, then delete wins).
- No transform staged for the id at all (no insert, no updates, no delete) → `undefined`.
- Insert present → `applyTransform(undefined, transform)`; `baseRev` ABSENT (base-independent —
  identical result whatever base the member holds, since insert replaces the block first).
- Updates only → probe the source for `peek(id)` and `getCachedRevision(id)`, duck-typed exactly like
  the existing `getGeneration` probe (`tracker.ts:25-28`), because Tracker layers over test doubles.
  If either the block or the revision is missing → `undefined` (a commit must not pay a network round
  trip to describe itself). Otherwise apply and return `{ block, baseRev }`.
- Delete (delete-last-wins) → `applyTransform` returns `undefined` → return `undefined`.
- CLONE before mutating: `applyTransform`/`applyOperations` mutate the block in place, and with an
  insert they mutate `transform.insert` itself — clone both the base (CacheSource.peek already
  clones) and the transform (`transformForBlockId` clones `updates` but NOT `insert`).

## Task 5: `computeBlockContentDigests`

New `packages/db-core/src/transform/digest.ts` (+ add to `transform/index.ts` barrel):

```ts
/** Digests for the blocks the tracker's staged transforms touch, computed WITHOUT loading anything
 *  from the source. An id whose base is not already cached is omitted rather than fetched. */
export async function computeBlockContentDigests(
	tracker: Tracker<IBlock>,
	blockIds: BlockId[]
): Promise<BlockContentDigests>
```

For each id: `tracker.peekMaterialized(id)`; skip on `undefined`; else
`{ digest: await canonicalBlockHash(block), ...(baseRev !== undefined ? { baseRev } : {}) }`.

## Tests (db-core, mocha/chai — see `test/cache-source.spec.ts`, `test/lru-map.spec.ts` for harness)

- `LruMap.peek` does not change eviction order (fill to max, peek oldest, insert one, oldest still
  evicted).
- `computeBlockContentDigests`: insert → digest present, no `baseRev`; update-only with cached base →
  digest present, `baseRev` = the cached materialized revision; delete-only → omitted; update-only
  with uncached base → omitted; id with no staged transform → omitted.
- `peekMaterialized` digest equals `canonicalBlockHash(applyTransform(...))` computed independently
  (client/member agreement, in-package half).
- Peek pass leaves tracker/cache state observably unchanged (repeat `tryGet` results identical).

## Validation

`yarn build && yarn typecheck && yarn test` from the root (db-p2p must build too — the moved helper).
Report anything pre-existing per the pre-existing-failure rules.
