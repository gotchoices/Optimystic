description: Four different parts of the storage layer each write a block's bookkeeping record, but they do not all take the same lock first (one takes no lock at all), so two can run at once on the same block and silently undo each other's work. Both failures were reproduced: one loses a committed version entirely, the other files a version under the wrong change-id.
files: packages/db-p2p/src/storage/block-latch.ts (new), packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, packages/db-p2p/test/proof-keyspace-isolation.spec.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts
difficulty: hard
repro: verified
----

# One block, one write lock

<!-- resume-note -->
A prior run spent its whole budget on investigation and made **no source changes**. The tree is
clean at `07a2dac9`. Everything below the "Resolved design decisions" heading is what that run
worked out; start from Phase 1 with those decisions already made — do not re-derive them. The
docs/NOTE/commit-path-test phase was split out into
`block-write-latch-docs-and-commit-path-test` (same stage, `prereq:` this ticket).
<!-- /resume-note -->

## Root cause, restated

The existing rule is written over **`meta.latest`** — "every out-of-band writer of a block's
`meta.latest` must serialize on the per-block commit latch"
(`packages/db-p2p/docs/storage.md` §2, and `commitLatchKey`'s doc comment at
`storage-repo.ts:21-27`).

That is the wrong noun. A block's metadata is stored as **one blob** — `{ latest, ranges }` — read
and written whole. Any read-modify-write of it overwrites `latest` whether it means to or not. So
the invariant has to be stated over **the whole metadata blob**:

> A block's metadata, revision records, action transforms, pending records, and stored proofs are
> only ever written while holding **one** named lock for that block.

## The four writers today

| Writer | Lock it takes |
|---|---|
| `StorageRepo.commit` / `saveReplicatedBlock` / `withBlockCommitLatch` | `StorageRepo.commit:<blockId>` |
| `BlockStorage.saveForwardRevision` (via `saveReplica` / `saveDeletion`) | `BlockStorage.saveReplica:<blockId>` |
| `BlockStorage.ensureRevision` (restore-a-missing-revision) | `BlockStorage.ensureRevision:<blockId>` |
| `BlockStorage.savePendingTransaction` (seeds metadata for a new block) | **none** |

`grep -rn "Latches.acquire" packages/db-p2p/src` — five sites at `block-storage.ts:304`,
`block-storage.ts:391`, `storage-repo.ts:41`, `storage-repo.ts:601`, `storage-repo.ts:887`.

## Both failures, reproduced (on `main`, throwaway script since deleted)

Interleaving forced by subclassing `MemoryRawStorage` (extends `KvRawStorage`; override
`getMetadata(blockId)` / `getRevision(blockId, rev)`) and pausing **after the underlying read
returns**, so the racing writer lands in the window the check has already looked past.

**A — restore cross-writes a revision and regresses `latest`.** Seed block at rev 5 (coverage
`[[5]]`, so rev 2 is a genuine gap). Peer answers the pin at rev 2 with rev 2 **and volunteers
rev 6** (action `x6`). Gate `getRevision(blockId, 6)` so `noDivergentRewrite` sees rev 6 absent,
then pauses. In the window, `saveReplicatedBlock(six, { rev: 6, actionId: 'r6' })` completes under
its *different* lock. Release. Observed: `getRevision(6) = x6`, `meta.latest = {rev 5}` (regressed
from 6), `ranges = [[2,3],[5]]`, and the replica path already emitted a change event for rev 6/`r6`.

**B — a pend erases a committed `latest`.** Fresh block, no metadata. Gate `getMetadata` to pause
after returning `undefined` to `savePendingTransaction`. In the window,
`saveReplicatedBlock(one, { rev: 1, actionId: 'r1' })` lands rev 1. Release. Observed:
`meta = { ranges: [] }` — `latest` gone; revision durable but invisible to `getLatest()`.
Reachable by two clients racing an insert of the same block id.

## Why renaming the three keys to one deadlocks

Every one of these holds the outer commit latch and then calls something that takes an inner
`BlockStorage` latch:

1. `StorageRepo.saveReplicatedBlock` (`:887`) → `saveReplica` → `saveForwardRevision` (`:304`).
2. `StorageRepo.commit` (`:601`) and `get`'s read-driven promotion (`:249`) → `internalCommit` →
   `readCommitBase` (`:1219`) → `getBlock` → `ensureRevision` (`:391`).
3. `commit`'s recovered-block collection lookup (`:734-735`) and `backFillProof` (`:1122`) →
   `getBlock` → `ensureRevision`.
4. `dispute/invalidation.ts` `applyInvalidation`'s `runLatched` (`:591-606`) →
   `saveReplica` / `saveDeletion` → `saveForwardRevision`.

`Latches` (`packages/db-core/src/utility/latches.ts`) is a plain FIFO promise-chain mutex: no owner
tracking, no re-entrancy. Cross-platform constraint (browser, RN) rules out `AsyncLocalStorage`.

## Design: one key, one acquirer, a mandatory token on every write

### New module `packages/db-p2p/src/storage/block-latch.ts`

```ts
export const blockWriteLatchKey = (blockId: BlockId): string => `Block.write:${blockId}`;

/** Opaque proof the bearer is inside `blockWriteLatchKey(blockId)`. Only this module mints one. */
export class BlockWriteLatch {
	private constructor(readonly blockId: BlockId) { }
	static { mint = (blockId) => new BlockWriteLatch(blockId); }   // see "minting" below
}

/** THE only `Latches.acquire` site for a block key. Non-scoped form: commit holds N at once. */
export async function acquireBlockWriteLatch(blockId: BlockId): Promise<{ latch: BlockWriteLatch; release: () => void }>;

export async function withBlockWriteLatch<T>(blockId: BlockId, fn: (latch: BlockWriteLatch) => Promise<T>): Promise<T>;
```

Own module so `block-storage.ts` can import without a cycle. Export from `src/index.ts`. After
landing, `grep -rn "Latches.acquire" packages/db-p2p/src/storage` must return **exactly one** hit.

### `IBlockStorage`: every writing method takes a required `latch: BlockWriteLatch`

`savePendingTransaction`, `deletePendingTransaction`, `saveMaterializedBlock`, `saveRevision`,
`promotePendingTransaction`, `setLatest`, `saveBlockProof`, `pruneSupersededMaterialization`,
`saveReplica`, `saveDeletion`, `recover`, and new `restoreRevision`. `BlockStorage` asserts
`latch.blockId === this.blockId` (private `assertLatch`). The Invariant P prose on
`promotePendingTransaction` / `saveReplica` / `saveDeletion` must survive.

`getBlock(rev?)` becomes **local-only**; restore is an explicit latched call:

```ts
getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined>;
restoreRevision(rev: number, latch: BlockWriteLatch): Promise<void>;
```

## Resolved design decisions (from the investigation run — do not re-derive)

- **Latch parameter position: LAST on every method.** `saveReplica` becomes
  `saveReplica(block, source: ActionRev | undefined, proof: BlockCommitProof | undefined, latch)` —
  the two optionals become required-but-`undefined`-able positionals so the token can stay last.
  `restoreRevision(rev, latch)`, `recover(latch)`, `savePendingTransaction(actionId, transform, latch)`,
  etc.
- **Minting the token without a cast.** `tsconfig.base.json` targets ES2022, so use a class
  `static { }` initialization block that assigns a module-scoped `let mint: (id: BlockId) => BlockWriteLatch`
  from inside the class (where the private constructor is callable). Type-checked, no `as`, nothing
  outside the module can construct one.
- **`getBlock` local-only semantics.** No metadata → `undefined` (unchanged: never-seen blocks are
  acquired by `CoordinatorRepo`, never fetched here — keep that comment). Metadata present and the
  target rev (named, or `latest.rev`) is outside `meta.ranges` → throw a new exported
  `RevisionNotCoveredError(blockId, rev)` (define beside `BlockStorage`). Covered → `materializeBlock`
  as today (its throws for missing materialization are unchanged). Pending-only (`latest`
  undefined) + `rev` undefined → `undefined`.
- **`restoreRevision(rev, latch)`** = today's `ensureRevision` body minus its `Latches.acquire`:
  one metadata read under the held latch, `inRanges` → return (no-op), else `restoreBlock` →
  `vetRestoredArchive` → `saveRestored` → merge coverage → `saveMetadata`. No metadata → throw
  (a never-seen block is not restored here; same reasoning as `getBlock`'s early return).
- **Healing lives in `StorageRepo.get`, in one private helper** (call it `readBlockHealing`): try
  `getBlock(rev)`; on `RevisionNotCoveredError` → `withBlockWriteLatch(blockId, l => storage.restoreRevision(err.rev, l))`
  → re-read `getBlock(rev)`. If the restore throws: when `await storage.getLatest()` is `undefined`
  (pending-only block) log and return `undefined` — absence, not fault — otherwise rethrow (→ the
  existing `unavailable: 'unmaterializable'` catch). This preserves BOTH behaviors the current
  `getBlock` pending-only arm pins (`block-storage.ts:62-97`): the restore is still *attempted* for
  a named rev on a pending-only block, and its failure reads as absent. Move that comment block to
  the helper. The second read's `materializeBlock` throw (restored records with no materialization)
  still propagates as unmaterializable.
- **Every other `getBlock` caller is plain local-only** and its existing catch (or lack of one) is
  correct as-is: `readCommitBase` (any throw → `refuseMissingBase`), `backFillProof` (catch →
  withhold proof), `previewCommitDigest` (catch → `digest: undefined`), `commit`'s recovered-block
  collection lookup (unwrapped today, stays unwrapped), `invalidation.ts:434 computeRevertedBlock`
  and `cascade.ts:147` (a `RevisionNotCoveredError` propagates — do NOT map it to `undefined`
  there: `undefined` means "write a delete tombstone" / "invalidate", which would turn a coverage
  gap into a wrong compensating write).
- **`StorageRepo.commit`:** build `{ blockId, storage, latch }` per *unique, sorted* id via
  `acquireBlockWriteLatch`; deduping `request.blockIds` is behavior-preserving (a duplicate today
  partitions as already-done on its second pass). Thread `latch` through `internalCommit`,
  `backFillProof`, `persistProofIfContentMatches`, `refuseMissingBase`, `dropUnpromotablePendings`,
  `storage.recover(latch)`.
- **`StorageRepo.pend` and `cancel`:** `Promise.all` over blocks, each branch
  `withBlockWriteLatch(blockId, l => storage.savePendingTransaction(..., l))` /
  `deletePendingTransaction(..., l)`. One latch per branch, never nested → no cycle against commit's
  sorted multi-acquire. Fixes repro B.
- **`saveReplicatedBlock`:** one `withBlockWriteLatch` scope over `getLatest` → `saveReplica` →
  `backFillProof`. **`recoverBlock`:** `withBlockWriteLatch(id, l => storage.recover(l))`.
- **`dispute/invalidation.ts`:** delete `runLatched` and `InvalidationContext.withBlockCommitLatch`;
  each compensating write is `withBlockWriteLatch(blockId, l => storage.saveDeletion({...}, l))` /
  `saveReplica(block, { rev, actionId }, undefined, l)`. **`cascade.ts`:** delete
  `CollectionEnv.withBlockCommitLatch` and its pass-through at `:357`.
- **`libp2p-node-base.ts:444-445`** is a dead alias (`const blockCommitLatch = withBlockCommitLatch; void blockCommitLatch;`) — delete it and the import.
- **Delete** `commitLatchKey` and `withBlockCommitLatch` from `storage-repo.ts`; drop the `Latches`
  import from both `storage-repo.ts` and `block-storage.ts`.
- **`materializeBlock`'s re-cache** (`block-storage.ts:479-484`) stays outside the latch — the one
  named exclusion (its `NOTE:` is in the follow-up ticket; leave a one-line placeholder comment).
- `raw-storage-conformance.ts` / `mesh-harness.ts` / `reactivity-mesh-harness.ts` /
  `quereus-plugin-optimystic` `collection-factory.ts` only *construct* `BlockStorage` — unaffected
  except the conformance suite's `bs.saveReplica` / `bs.saveDeletion` at `:535,540`. The quereus
  plugin specs that `override saveRevision(...args)` subclass `MemoryRawStorage`, not
  `BlockStorage` — unaffected.

## Test churn map (mechanical — fan out to sub-agents once the interface compiles)

Wrap each multi-call seed sequence in ONE scope:
`await withBlockWriteLatch(blockId, async l => { await s.savePendingTransaction(a, t, l); await s.saveMaterializedBlock(a, b, l); await s.saveRevision(1, a, l); await s.promotePendingTransaction(a, l); await s.setLatest({...}, l); })`.

- `test/storage-repo.spec.ts` — ~15 seed sequences (`:144-148, 169-173, 193-197, 292-296, 341-345,
  404-408, 929-933, 963-967, 1019-1023, 1103-1107, 1158-1167, 1198-1211, 1514-1518, 1590-1594, 2414`);
  `commitLatchKey` at `:2, 1038, 1169` → `blockWriteLatchKey` from `block-latch.js`.
- `test/block-storage.spec.ts` — all `savePendingTransaction` / `saveReplica` / `saveDeletion` /
  `saveMaterializedBlock` / `saveRevision` / `promotePendingTransaction` / `recover` sites
  (`:68, 99, 121, 140, 190, 350, 365-366, 387, 391, 404, 408, 421-422, 465-466, 493, 497, 527-531,
  544-545, 560-565, 581-591, 1287`). The `SkipPruneStorage` override at `:1128` gains the latch
  param. Restore-path tests that call `storage.getBlock(rev)` expecting a restore (`:76-110,
  128-200, 618-960 incl. `expectRestoreRefused` at `~:640`, `:1086, 1159`) become
  `withBlockWriteLatch(id, l => storage.restoreRevision(rev, l))` then `getBlock(rev)` — or go
  through `StorageRepo.get` with `context: { rev, committed: [] }`, which exercises the real
  healing helper. The 'restore comes back empty reads absent' and 'restore not short-circuited'
  tests (`:76, 128`) are about the *StorageRepo.get* nuance now — move them to the repo level.
  **Rewrite** `:434` 'saveReplica and saveDeletion are mutually exclusive (shared latch)' as "two
  `withBlockWriteLatch` scopes on one block never overlap" (same `LatchProbeStorage`).
- `test/invalidation.spec.ts` — imports at `:7-8`; `:741` and `:843` `commitLatchKey` →
  `blockWriteLatchKey`; the `probe`/`gatedLatch` runners injected via `withBlockCommitLatch` no
  longer have an injection point — rewrite `:731` and `:826` to hold `blockWriteLatchKey(blockId)`
  externally via `Latches.acquire` (test-side only) and assert apply parks / commit queues.
  **Delete** `:780` 'WITHOUT the latch, a concurrent commit clobbers the invalidation (documents the
  lost update)' — the unlatched write it documents is now unrepresentable (say so in the handoff).
  `:888, 900-901` `saveDeletion` gain the latch.
- `test/commit-proof.spec.ts:459-461`, `test/proof-keyspace-isolation.spec.ts:115, 132-133`,
  `../db-p2p-storage-fs/test/file-storage.spec.ts:108` (`blockStorage.recover(l)`),
  `src/testing/raw-storage-conformance.ts:535, 540`.

## Regression tests to add (Phase 1 — write FIRST, against the unchanged public API, confirm they fail)

Both go in `test/block-storage.spec.ts` under a new `describe('one block, one write lock')`, and
use only `StorageRepo.get` / `pend` / `saveReplicatedBlock`, whose signatures do not change, so
they run (and fail) on the current tree before any source edit.

- **A.** `class GatedRaw extends MemoryRawStorage { override async getRevision(id, rev) { const r = await super.getRevision(id, rev); if (id === B && rev === 6 && !tripped) { tripped = true; signalParked(); await gate; } return r; } }`.
  Seed rev 5 via `repo.pend` + `repo.commit` (insert at collection rev 5). `restoreCallback` answers
  pin 2 with `{ 2: {...}, 6: { action: { actionId: 'x6', rev: 6, ... }, block } }`, `range: [2, 7]`.
  Start `repo.get({ blockIds: [B], context: { rev: 2, committed: [] } })`; `await parked`; start
  `repo.saveReplicatedBlock(B, six, { rev: 6, actionId: 'r6' })`; `await delay(10)`; assert
  `raw.getRevision(B, 6) === undefined` (replica is queued, not landed); release gate; await both.
  Assert `raw.getRevision(B, 6) === 'r6'` and `(await raw.getMetadata(B)).latest` deep-equals
  `{ rev: 6, actionId: 'r6' }` — never below 6. (Either serialization order yields this: restore
  first → replica overwrites the volunteered `x6` above its own `latest`; replica first → the
  archive refuses on `noDivergentRewrite`.)
- **B.** Gate the **first** `getMetadata(B)` to pause after returning `undefined`. Pend with an
  `updates`-only transform and no `rev` (so `pend` makes no `getLatest` call of its own and the
  gated read is the one inside `savePendingTransaction`); `await parked`; start
  `repo.saveReplicatedBlock(B, one, { rev: 1, actionId: 'r1' })`; release; await both. Assert
  `(await raw.getMetadata(B)).latest` deep-equals `{ rev: 1, actionId: 'r1' }` and the pending
  record is present.

## TODO

### Phase 1 — pin the failures
- Add repros A and B as above; run
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/block-storage.spec.ts --grep "one block, one write lock"`
  from `packages/db-p2p` and confirm both fail on the current tree.

### Phase 2 — the latch module and the token
- Add `block-latch.ts` (key, token with static-block minting, `acquireBlockWriteLatch`,
  `withBlockWriteLatch`); export from `src/index.ts`.
- `IBlockStorage`: `latch` last on every writing method; `getBlock` local-only doc; add
  `restoreRevision`. Add `RevisionNotCoveredError`.
- `BlockStorage`: `assertLatch`; split `getBlock` / `restoreRevision`; `saveForwardRevision` takes
  the token; delete both `Latches.acquire` sites.

### Phase 3 — call sites
- `storage-repo.ts`: `get` (promotion scope + `readBlockHealing`), `pend`, `cancel`, `commit`,
  `recoverBlock`, `saveReplicatedBlock`, `internalCommit`, `backFillProof`,
  `persistProofIfContentMatches`, `refuseMissingBase`, `dropUnpromotablePendings`. Delete
  `commitLatchKey` / `withBlockCommitLatch`.
- `dispute/invalidation.ts`, `dispute/cascade.ts`, `libp2p-node-base.ts:17,444-445`.
- `src/testing/raw-storage-conformance.ts:535,540`.
- Verify `grep -rn "Latches.acquire" packages/db-p2p/src/storage` → exactly one hit, and
  `grep -rn "commitLatchKey\|withBlockCommitLatch\|ensureRevision" packages --include=*.ts --exclude-dir=dist --exclude-dir=node_modules`
  → only doc prose left (the follow-up ticket cleans `README.md:264`, `docs/storage.md:164`).

### Phase 4 — tests
- Apply the churn map (sub-agents per file are fine; give them the exact line lists above).
- Repros A and B now pass.

### Phase 5 — validate
- `yarn workspace @optimystic/db-p2p test` (whole package).
- `yarn workspace @optimystic/db-p2p-storage-fs test`.
- `yarn build && yarn typecheck` from root (the token crosses into `quereus-plugin-optimystic`,
  whose specs import its own `dist/`), then `yarn workspace @optimystic/quereus-plugin-optimystic test`.
