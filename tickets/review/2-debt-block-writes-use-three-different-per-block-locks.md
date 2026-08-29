description: Four different parts of the storage layer each wrote a block's bookkeeping record under different locks (one under none), so two could run at once on the same block and silently undo each other's work. Now every write to a block's records requires a token that can only be obtained by holding the one write lock for that block, so an unlocked write no longer compiles.
files: packages/db-p2p/src/storage/block-latch.ts (new), packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, packages/db-p2p/test/proof-keyspace-isolation.spec.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts
difficulty: hard
----

# One block, one write lock — review handoff

## What landed

A block's metadata is stored as **one blob** `{ latest, ranges }`, read and written whole, so any
read-modify-write of it overwrites `latest` whether it meant to or not. The invariant is now stated
over the whole blob and enforced by the type system:

> A block's metadata, revision records, action transforms, pending records, and stored proofs are
> only ever written while holding **one** named lock for that block: `Block.write:<blockId>`.

- **`src/storage/block-latch.ts`** (new): `blockWriteLatchKey`, `BlockWriteLatch` (opaque token,
  private constructor, minted only inside this module), `acquireBlockWriteLatch` (multi-latch form
  for `commit`), `withBlockWriteLatch` (scoped form for everyone else). It is the **single acquirer**
  of the key: `grep -rn "Latches.acquire" packages/db-p2p/src/storage` → exactly one code hit.
- **`IBlockStorage`**: every writing method takes `latch: BlockWriteLatch` as its LAST parameter.
  `saveReplica(block, source | undefined, proof | undefined, latch)` — two positional optionals now
  need an explicit `undefined`. `BlockStorage.assertLatch` rejects a token minted for another block.
- **`getBlock(rev?)` is local-only** (never calls `restoreCallback`): no metadata → `undefined`;
  pending-only + no `rev` → `undefined`; target rev outside `meta.ranges` → throws
  `RevisionNotCoveredError` (exported from `block-storage.ts`, carries `.blockId`/`.rev`); covered →
  materialize as before. The old implicit restore (`ensureRevision`) is gone; restore is the
  explicit latched call **`restoreRevision(rev, latch)`**.
- **Healing lives in one place**: `StorageRepo.get` → private `readBlockHealing`: `getBlock` → on
  `RevisionNotCoveredError` → `withBlockWriteLatch(id, l => restoreRevision(err.rev, l))` → re-read.
  A failed restore on a **pending-only** block (no `latest`) reads as absent (`undefined`); on a
  block that has a `latest` it rethrows → `{ state: {}, unavailable: 'unmaterializable' }`.
- **`StorageRepo`**: `commit` acquires per unique sorted id via `acquireBlockWriteLatch`, keeps a
  `Map<BlockId, BlockWriteLatch>`, builds `blockStorages` in request order **deduped**, and threads
  the token through `internalCommit` (param sits before the optional `proof`), `backFillProof`,
  `persistProofIfContentMatches`, `readCommitBase`, `refuseMissingBase`, `dropUnpromotablePendings`,
  `storage.recover(latch)`. `pend` / `cancel` take one latch per block branch (never nested).
  `saveReplicatedBlock` and `recoverBlock` use one `withBlockWriteLatch` scope.
  `commitLatchKey` / `withBlockCommitLatch` are **deleted**.
- **Dispute**: `InvalidationContext.withBlockCommitLatch` and `CollectionEnv.withBlockCommitLatch`
  are deleted; `applyInvalidation` always wraps each compensating `saveDeletion` / `saveReplica` in
  `withBlockWriteLatch`. There is no injection point for an unlatched write any more.
- `libp2p-node-base.ts`: dead `blockCommitLatch` alias removed. `index.ts` **and `rn.ts`** export
  `block-latch.js` (the `entry-parity` test caught the missing `rn.ts` line).
- Stale prose naming the "commit latch" / `ensureRevision` in `src/` and spec comments was updated.
  `docs/storage.md` and `README.md` were deliberately **not** touched — the follow-up ticket
  `block-write-latch-docs-and-commit-path-test` (sequence 2.5) owns the docs rewrite, the
  `materializeBlock` / `readCommitBase` `NOTE:`s, and the commit-never-fetches test.

## Use cases to exercise (all have tests; names given so the reviewer can run them)

1. **Repro A — restore cross-writes a revision and regresses `latest`.**
   `test/block-storage.spec.ts` → `describe('one block, one write lock')`, first test. Byte-identical
   to the failing version filed with the ticket; now passes because the restore and the replica share
   one latch.
2. **Repro B — a pend erases a committed `latest`.** Same describe, second test. `pend` now seeds
   metadata under the block's latch.
3. **External hold parks every writer.** `storage-repo.spec.ts`: "does not promote while another
   writer holds the block write latch", "recoverBlock does not reconcile meta.latest while another
   writer holds the block write latch". `invalidation.spec.ts`: "contends on the per-block write
   latch", "a commit queues behind the invalidation on the one write latch and latest stays
   monotonic". Pattern: test-side `Latches.acquire(blockWriteLatchKey(id))`, start the operation,
   assert not completed, release, assert landed.
4. **Two scopes never overlap.** `block-storage.spec.ts` "two write-latch scopes on one block never
   overlap" (replaces the old "saveReplica and saveDeletion are mutually exclusive (shared latch)").
5. **Token is block-bound.** `block-storage.spec.ts` "a write latch minted for one block is refused
   by another block's storage, writing nothing".
6. **`getBlock` local-only contract.** `block-storage.spec.ts` "getBlock is local-only: absent,
   absent, or a coverage gap — never a fetch" (asserts `restoreCallback` call count 0).
7. **Healing through the real path.** The restore-behaviour tests moved from direct `getBlock` to
   `StorageRepo.get({ blockIds, context: { rev, committed: [] } })`: "a healing read for an absent
   revision fires restoreCallback", "a named rev on a pending-only block with NO restoreCallback
   reads absent, not a fault", "…whose restore comes back empty reads absent", "…supplies revisions
   but no materialization is a fault". Restore-mechanics tests (vetting, coverage merge, refusal)
   call `restoreRevision` directly under `withBlockWriteLatch`.
8. **Deleted test** — `invalidation.spec.ts` 'WITHOUT the latch, a concurrent commit clobbers the
   invalidation (documents the lost update)' and its `GatedRawStorage` helper: the unlatched
   compensating write it documented is now unrepresentable. A one-line comment marks the spot.

## Validation run

- `yarn workspace @optimystic/db-p2p typecheck` → clean. `yarn workspace @optimystic/db-p2p test`
  → **2299 passing, 44 pending, 0 failing**.
- Root `yarn build && yarn typecheck` → clean.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` → 658 passing, 13 pending (+ smoke ok).
- `yarn workspace @optimystic/db-p2p-storage-fs test` → 60 passing, 1 pending (the pre-existing
  POSIX-only raw-colon skip on win32).
- `grep -rn "commitLatchKey\|withBlockCommitLatch\|ensureRevision" packages --include=*.ts --exclude-dir=dist --exclude-dir=node_modules`
  → no code hits (only `docs/storage.md` / `README.md`, owned by the 2.5 follow-up).

## Behaviour changes the reviewer should weigh (deliberate, but worth a second opinion)

- **The commit path never fetches from a peer.** `readCommitBase` → `getBlock` is local-only; a
  `latest` outside `meta.ranges` now raises `RevisionNotCoveredError` → caught → `refuseMissingBase`
  → `MissingBaseRevisionError` (pending dropped, cohort reconcile heals). Before, it restored in line
  while holding every block latch of the batch. The pinning test is in the 2.5 follow-up.
- **The vote path abstains instead of fetching.** `previewCommitDigest` catches the same error and
  returns `digest: undefined`. Previously an uncovered base triggered an inline restore on the vote
  path; now the member abstains on that block. Check `ClusterMember.validateCommitOperations`'s
  abstain handling is what we want under a cold member.
- **`commit` dedups `request.blockIds`.** `blockStorages` is `Array.from(new Set(request.blockIds))`
  in request order. A request with a duplicated id used to process the block twice (second pass as
  alreadyDone); now once. Change-event ordering for unique ids is unchanged.
- **`cancel` is now latched** per block (previously unlatched).
- **`commit`'s recovered-block collection lookup** (`storage.getBlock(request.rev)` /
  `getBlock(request.rev - 1)` after `recover()`) is still unwrapped, per the resolved design. A
  `RevisionNotCoveredError` there would fail the batch; judged unreachable because `recover()` only
  advances `latest` within recorded revisions, but nothing pins that.

## Known gaps / where the reviewer should push

- **Timing-based negative assertions.** The two rewritten invalidation "parked" tests use a 25 ms
  real-timer window (`delay(25)`), and the scope-overlap test a 10 ms window, to assert "has NOT
  completed". They can only false-**pass** under load (a slow unlatched write would look parked),
  never false-fail. The old versions had an injected probe; there is no injection point now. If a
  deterministic signal is wanted, a `LatchProbeStorage`-style raw-storage gate on the first write is
  the way, not a runner hook.
- **No deadlock test against `commit`'s multi-latch acquisition.** Every scoped caller holds at most
  one block latch and never calls into `StorageRepo` from inside a scope (audited by hand across
  `src/` and the specs). A reviewer should re-check the two scoped sites that call *out*:
  `readBlockHealing` (restore under latch — see tripwire below) and `applyInvalidation`
  (compute happens before the latch; only the write is inside).
- **Restore runs under the latch** (tripwire `NOTE:` at `readBlockHealing` in `storage-repo.ts`): a
  slow peer fetch queues every commit/pend/replica on that block behind one round-trip. Fine at
  today's rates; revisit condition is stated at the site.
- **`materializeBlock`'s read-path re-cache** is the one named write outside the latch. The `NOTE:`
  explaining why that is safe (same key, deterministic bytes) is in the 2.5 follow-up, not here.
- The `saveReplica` signature change (`source`, `proof` both positional-optional → explicit
  `undefined`) is the API-surface item most likely to bite an external caller; every in-repo call
  site was converted and typechecks, but `quereus-plugin-optimystic` / harnesses only *construct*
  `BlockStorage`, so nothing outside `db-p2p` exercises the new positional shape.

## Tripwires recorded

- `storage-repo.ts` `readBlockHealing`: `NOTE:` — restore fetches under the block write latch;
  revisit if restore latency ever shows up delaying commits.
