----
description: Make the group that approves a write also state, and check, what the record will actually contain — so a later reader can tell a genuine copy from a forged one. Today the group's approval says only which record changed, not what it changed to.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/blocks/helpers.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: hard
----

# Bind block content into the commit consensus message

## What this is and why it is first

When a node commits a transaction, the cohort runs a consensus round over a message that says
*which* blocks change, at *which* revision, under *which* action id. It says nothing about what the
blocks will **contain**. Every signature the cohort produces is therefore a signature over a claim
with no content in it — which is why a node repairing a block today cannot ask "is this the agreed
content?" and has to fall back on "did two other peers say the same thing?".

This ticket adds the missing declaration: the client that authored the transforms also declares the
**canonical hash of the block each id will materialize to**, inside the commit operation. Because the
cluster's hashing helpers canonicalise the *whole* message generically
(`computeClusterMessageHash` / `computeClusterPromiseHash` / `computeClusterCommitHash` in
`packages/db-core/src/cluster/membership.ts`), a new field inside the commit operation is folded into
every hash and covered by every existing signature with **no change to those helpers**, and an
un-upgraded peer recomputes the changed preimage correctly. No new signature type, no new round.

A signature only means something if signers check what they sign, so this ticket also adds the
member-side check: before a member approves the commit record, it materializes the block locally and
**rejects on mismatch**.

Nothing verifies or persists a durable proof yet — that is `persist-block-commit-proof`. This ticket
ends with the digest declared, hashed, signed and checked.

## Who declares the digest — settled, do not re-open

**The client, via its `Tracker`.** This was the one question the plan stage left open; it is answered
by reading the code:

- The **coordinator cannot**. `CoordinatorRepo.commit` (`coordinator-repo.ts:1384`) forwards the
  caller's request without materializing anything, and the block immediately below it explicitly
  handles a coordinator that was chosen for commit *after missing the pend phase*.
- The **client can**, at both commit call sites, because both still hold the staged `Tracker`:
  - `Collection.sync` — `packages/db-core/src/collection/collection.ts:638` builds a snapshot
    `Tracker` over `this.sourceCache` and calls `this.source.transact(tracker.transforms, ...)`. The
    tracker is reset only *after* a successful commit.
  - `TransactionCoordinator.commitCollection` —
    `packages/db-core/src/transaction/coordinator.ts:1044-1061` reaches
    `this.collections.get(collectionId)`, whose `.tracker` still holds the staged transforms
    (`tracker.reset()` runs at `:385` / `:636`, after commit).

  A `Tracker` serves `source block + updates` from `tryGet`, so it is exactly the object that knows
  the post-transform content.

## Why the declaration must carry the base revision

`StorageRepo.commit` accepts a commit whenever `latest.rev < request.rev`
(`packages/db-p2p/src/storage/storage-repo.ts:589-610`) — **not** only when
`latest.rev === request.rev - 1`. A member that missed an intermediate commit therefore applies the
transform to an older base and legitimately materializes *different bytes* at the same revision. (This
is the divergence `ClusterMember.reconcileDivergentCommit` exists to repair; pre-existing behaviour,
not something this ticket introduces.)

So a bare digest is uncheckable: a lagging honest member would compute a different hash and reject a
perfectly good transaction. The declaration therefore names the base it was computed from, and a
member checks only when it can:

| Transform for the id | Base dependence | Member behaviour |
|---|---|---|
| carries an `insert` (with or without `updates`) | none — `applyTransform` adopts the inserted block and applies ops to it | **always check**; mismatch → reject |
| `updates` only | depends on the base | check **iff** local `latest?.rev === baseRev`; otherwise abstain (approve as today) |
| `delete` only | materializes nothing | no digest declared; nothing to check |

"Abstain" means: contribute no content attestation, vote exactly as the member does today.

**Residual, to state in the ticket text and in a code comment at the check site:** a false digest
requires the declarer to lie *and* enough of the cohort to be simultaneously unable to check (lagging
bases) that no honest checker is left. Any single caught-up honest member rejects and the transaction
fails. That is strictly stronger than today, where the commit signatures bind no content whatsoever.

## Types

Add to `packages/db-core/src/network/struct.ts`, beside `CommitRequest`:

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

Add `blockDigests?: BlockContentDigests` to **both**:

- `CommitRequest` (`packages/db-core/src/network/struct.ts:100`) — the client-facing request that
  `CoordinatorRepo.commit` receives and puts into the consensus message; and
- `RepoCommitRequest` (`packages/db-core/src/network/i-repo.ts:26`) — the per-peer request
  `NetworkTransactor.commitBlocks` actually puts on the wire.

## Promote `canonicalBlockHash` into db-core

It lives at `packages/db-p2p/src/cluster/quorum-restore.ts:163` today and both packages now need it.
Move it (and the private `canonicalJson` it uses) to `packages/db-core/src/blocks/helpers.ts`, export
it from the db-core barrel, and update the two db-p2p importers (`quorum-restore.ts` itself and
`reconcile-block.ts:138`). Do **not** leave a second copy behind — a drifted hash reports honest
content as forged.

## Client-side digest computation

New `packages/db-core/src/transform/digest.ts`:

```ts
/** Digests for the blocks the tracker's staged transforms touch, computed WITHOUT loading anything
 *  from the source. An id whose base is not already cached is omitted rather than fetched: a commit
 *  must not pay a network round trip to describe itself. */
export async function computeBlockContentDigests(
	tracker: Tracker<IBlock>,
	blockIds: BlockId[]
): Promise<BlockContentDigests>
```

It needs a non-loading materialize. Add to `Tracker`:

```ts
/** The block `id` materializes to under the staged transforms, computed WITHOUT loading from the
 *  source, plus the committed revision of the base used. `undefined` when not computable here. */
peekMaterialized(id: BlockId): { block: IBlock; baseRev?: number } | undefined
```

- insert present → `applyTransform(undefined, transform)`, no `baseRev`.
- updates only → probe the source for an already-held base and its revision; if either is missing,
  return `undefined`.
- delete only → `undefined`.

The probe is duck-typed exactly like the existing `getGeneration` probe in `Tracker`
(`tracker.ts:25-28`), because `Tracker` layers over test doubles too. Add the two probed methods to
`CacheSource`:

```ts
/** The block currently cached for `id`, without consulting the source. */
peek(id: BlockId): T | undefined
/** The committed revision of the content currently cached for `id`. */
getCachedRevision(id: BlockId): number | undefined
```

`CacheSource` already holds both maps (`cache`, `revisions`). `getCachedRevision` must read the SAME
`revisions` map that `tryGet` re-emits on a hit — that value originates from
`GetBlockResult.materializedRev` (`transactor-source.ts:92`), which is the revision the content was
*materialized* at, i.e. the number a member compares against its own `latest.rev`. Do not substitute
`state.latest.rev`.

## Threading the digests to the wire

- `TransactorSource.transact` gains a `blockDigests?: BlockContentDigests` parameter and puts it on
  the `CommitRequest` it builds (`transactor-source.ts:147`).
- `Collection.sync` computes them from its snapshot tracker before calling `transact`
  (`collection.ts:638`).
- `TransactionCoordinator.commitCollection` computes them from `collection.tracker` and puts them on
  its `CommitRequest` (`coordinator.ts:1044`).
- **`NetworkTransactor` must subset them per batch.** `commit` splits the request into header, tail
  and remaining batches, and `commitBlocks` sends one `RepoCommitRequest` per coordinating peer
  (`network-transactor.ts:681-770`). Each batch's message becomes its own cluster record, so each must
  carry **only its own blocks'** digests. Shipping the whole map to every batch would make one cohort
  sign for blocks it is not responsible for.

## Member-side check

`ClusterMember.validatePendOperations` (`cluster-repo.ts:1159`) only ever inspects `'pend' in
operation`; a **commit** record's promise round consequently validates nothing and approves by
default. That is the hook.

- Add `validateCommitOperations(record)` beside it, and call it from `evaluatePromise`
  (`cluster-repo.ts:937-944`) after `validatePendOperations`.
- For each `{ commit }` operation carrying `blockDigests`, for each declared id, apply the
  checkable/abstain table above. On a checkable mismatch return
  `{ valid: false, reason: CONTENT_DIGEST_MISMATCH }` — a new exported constant beside
  `MEMBERSHIP_NOT_ADMITTED` (`cluster-repo.ts:140`). The reason rides in the reject vote's
  `rejectReason`, which `clusterVoteSigningPayload` already folds into the signed bytes.
- A member that holds **no pending transform** for the action never saw the pend and cannot
  materialize: abstain, do not reject.

**The check must be on the promise round, not the commit round.** The commit-round vote is cast
deliberately blind — `cluster-repo.ts:835-858` signs the commit whenever
`approvedPromises >= superMajority`, regardless of how this member voted at promise time. The
promise-round approvals are the only votes that carry "I checked this". Downstream verification
(`persist-block-commit-proof`) depends on this, so do not move the check.

## Member-side preview

Add to `StorageRepo`:

```ts
/** The digest the block WOULD materialize to if `actionId`'s pending transform committed at `rev`,
 *  plus the base revision it was computed from. Read-only: touches no durable state and takes no
 *  commit latch. */
previewCommitDigest(blockId: BlockId, actionId: ActionId, rev: number):
	Promise<{ digest?: string; baseRev?: number; baseIndependent: boolean } | undefined>
```

Reuse the same three reads `internalCommit` does — `storage.getPendingTransaction(actionId)`,
`storage.getLatest()`, `storage.getBlock(latest.rev)` — then `applyTransform` +
`canonicalBlockHash`. `digest` is `undefined` when the transform materializes nothing (a tombstone).
Returns `undefined` when there is no pending transform for the action.

Do **not** take the per-block commit latch here. This runs on the vote path, ahead of the commit that
will take it; taking it would serialize voting behind commits and risks deadlocking against the
commit path's sorted multi-block acquisition.

## Edge cases & interactions

- **Lagging member, update-only block.** Member's `latest.rev !== baseRev` → abstains, approves. Pin
  this: it is the case that makes the whole scheme safe to turn on.
- **Lagging member, insert-carrying block.** Checks and must agree, because the insert makes the
  result base-independent. Pin it.
- **Tombstone / delete-only.** No digest declared, no check, commit proceeds. Also cover
  `internalCommit`'s "absent `newBlock` with a prior `latest`" tombstone branch
  (`storage-repo.ts:876-890`).
- **Mixed-version cohort, both directions.** An upgraded member receiving a commit with no
  `blockDigests` abstains everywhere. An un-upgraded member receiving one ignores the field but still
  hashes it into `messageHash`/`promiseHash`/`commitHash` via `canonicalJson`, so its signatures stay
  valid and mutually verifiable. Pin both.
- **Multi-block commit.** Each id is checked independently; one mismatch rejects the whole record
  (there is one vote per record, not per block).
- **Per-batch subsetting.** A digest for a block id not in this batch's `blockIds` must never appear
  in that batch's message. Pin it.
- **Uncached base.** Client omits the id; commit proceeds with a partial `blockDigests` map. Pin that
  a partial map is legal and that undeclared ids are not checked.
- **`peek` and LRU recency.** `LruMap.get` bumps recency; if `peek` uses it, say so in a comment or
  add a recency-neutral read. A digest pass must not reshape the cache's eviction order.
- **Header and tail blocks.** `NetworkTransactor.commit` commits the header and the tail as their own
  single-block batches before the rest. Both are ordinary tracker blocks, so both should carry
  digests; assert that rather than assuming it.
- **A digest declared for an id absent from `blockIds`** — malformed or hostile. Ignore the surplus
  entry; never throw out of the vote path.
- **Single-peer fast path.** `CoordinatorRepo.commit` short-circuits to a direct
  `storageRepo.commit` when `peerCount <= 1` (`coordinator-repo.ts:1387`). No consensus, no
  signatures, so no digest check runs there — confirm it still commits cleanly with the field present.

## TODO

- Move `canonicalBlockHash` (+ its `canonicalJson`) from `db-p2p/src/cluster/quorum-restore.ts` into
  `db-core/src/blocks/helpers.ts`; export from the db-core barrel; update `quorum-restore.ts` and
  `reconcile-block.ts`. Leave no duplicate.
- Add `BlockContentDigest` / `BlockContentDigests` to `db-core/src/network/struct.ts`; add
  `blockDigests?` to `CommitRequest` and to `RepoCommitRequest`.
- Add `CacheSource.peek` and `CacheSource.getCachedRevision`.
- Add `Tracker.peekMaterialized`, duck-typing the two new source methods the way `getGeneration` is
  duck-typed today.
- Add `db-core/src/transform/digest.ts` with `computeBlockContentDigests`.
- Thread digests: `Collection.sync` → `TransactorSource.transact` → `CommitRequest`;
  `TransactionCoordinator.commitCollection` → `CommitRequest`.
- Subset `blockDigests` per batch in `NetworkTransactor.commit` / `commitBlocks`.
- Add `StorageRepo.previewCommitDigest`.
- Add `CONTENT_DIGEST_MISMATCH` and `ClusterMember.validateCommitOperations`; call it from
  `evaluatePromise`.
- Tests (db-core): `computeBlockContentDigests` — insert (no `baseRev`), update-only (carries
  `baseRev` from the cached materialized revision), delete-only (omitted), uncached base (omitted);
  per-batch subsetting in `NetworkTransactor`.
- Tests (db-p2p): `previewCommitDigest` matches what `internalCommit` actually stores, for insert,
  update and tombstone; `validateCommitOperations` approves when abstaining, rejects on a
  base-independent mismatch, abstains on a base-rev mismatch, ignores surplus ids, and tolerates a
  member with no pending transform.
- Test: the three cluster hashes over the same message bytes are byte-identical whether or not the
  computing code knows about `blockDigests` (the mixed-version guarantee).
- Update `docs/internals.md` (and `docs/correctness.md` where it enumerates the commit message shape)
  with the declaration, the checkable/abstain rule, and the residual.
- Run `yarn build && yarn typecheck && yarn test` from the root; report anything pre-existing per the
  pre-existing-failure rules.
