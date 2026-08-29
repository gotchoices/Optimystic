description: Four different parts of the storage layer each write a block's bookkeeping record, but they do not all take the same lock first (one takes no lock at all), so two can run at once on the same block and silently undo each other's work. Both failures were reproduced: one loses a committed version entirely, the other files a version under the wrong change-id.
files: packages/db-p2p/src/storage/block-latch.ts (new, DONE), packages/db-p2p/src/storage/i-block-storage.ts (DONE), packages/db-p2p/src/storage/block-storage.ts (DONE), packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/invalidation.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, packages/db-p2p/test/proof-keyspace-isolation.spec.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts
difficulty: hard
repro: verified
----

# One block, one write lock

<!-- resume-note -->
**Second run hit its token budget mid-Phase 2/3. The tree does NOT compile right now** — the
storage layer's interface changed but its callers have not been updated yet. Here is the exact
state; do not re-derive the design (everything under "Resolved design decisions" stands).

**Landed (uncommitted edits in the working tree; do not revert):**

- `test/block-storage.spec.ts` — new `describe('one block, one write lock')` appended at the end
  of the file with repros **A** and **B** exactly as specified below. Both were run on the
  unfixed tree and **fail as expected** (A: `expected 'r6' to equal undefined` — the replica lands
  mid-restore; B: `expected undefined to deeply equal { rev: 1, actionId: 'r1' }` — the pend's
  seed erases `latest`). They use only `StorageRepo.get` / `pend` / `saveReplicatedBlock`, so they
  need no churn.
- `src/storage/block-latch.ts` — **complete**: `blockWriteLatchKey`, `BlockWriteLatch` (private
  constructor, module-scoped `mint` assigned from a `static {}` block), `acquireBlockWriteLatch`,
  `withBlockWriteLatch`. Not yet exported from `src/index.ts`.
- `src/storage/i-block-storage.ts` — **complete**: every writer takes `latch: BlockWriteLatch`
  LAST; `saveReplica(block, source | undefined, proof | undefined, latch)`; `getBlock` doc is
  local-only; new `restoreRevision(rev, latch)`.
- `src/storage/block-storage.ts` — **complete** (compiles on its own): `Latches` import gone;
  `RevisionNotCoveredError` exported beside `BlockStorage`; private `assertLatch`; `getBlock` is
  local-only (throws `RevisionNotCoveredError` outside `meta.ranges`, `undefined` for no-metadata
  and for pending-only + no named rev); `restoreRevision(rev, latch)` replaces `ensureRevision`;
  every writer asserts the token; `saveForwardRevision` no longer acquires anything. One cosmetic
  leftover: its body is wrapped in a bare `{ … }` block where the old `try { … } finally { release() }`
  was, so it sits one indent deeper than it needs to — dedent when you touch it.

**NOT started (this is the remaining work — Phase 3 onward below):** `storage-repo.ts`,
`dispute/invalidation.ts`, `dispute/cascade.ts`, `libp2p-node-base.ts`, `src/index.ts`,
`src/testing/raw-storage-conformance.ts`, and all test churn. The `commitLatchKey` /
`withBlockCommitLatch` helpers and their `Latches` import still exist in `storage-repo.ts`.

Start by running `yarn workspace @optimystic/db-p2p typecheck`; every error it reports is a call
site the churn map below already lists.
<!-- /resume-note -->

## Root cause, restated

The existing rule is written over **`meta.latest`** — "every out-of-band writer of a block's
`meta.latest` must serialize on the per-block commit latch"
(`packages/db-p2p/docs/storage.md` §2, and `commitLatchKey`'s doc comment in `storage-repo.ts`).

That is the wrong noun. A block's metadata is stored as **one blob** — `{ latest, ranges }` — read
and written whole. Any read-modify-write of it overwrites `latest` whether it means to or not. So
the invariant has to be stated over **the whole metadata blob**:

> A block's metadata, revision records, action transforms, pending records, and stored proofs are
> only ever written while holding **one** named lock for that block.

## The four writers (before this ticket)

| Writer | Lock it took |
|---|---|
| `StorageRepo.commit` / `saveReplicatedBlock` / `withBlockCommitLatch` | `StorageRepo.commit:<blockId>` |
| `BlockStorage.saveForwardRevision` (via `saveReplica` / `saveDeletion`) | `BlockStorage.saveReplica:<blockId>` |
| `BlockStorage.ensureRevision` (restore-a-missing-revision) | `BlockStorage.ensureRevision:<blockId>` |
| `BlockStorage.savePendingTransaction` (seeds metadata for a new block) | **none** |

## Both failures, reproduced (now pinned by the two tests in `test/block-storage.spec.ts`)

**A — restore cross-writes a revision and regresses `latest`.** Seed block at rev 5 (coverage
`[[5]]`, so rev 2 is a genuine gap). Peer answers the pin at rev 2 with rev 2 **and volunteers
rev 6** (action `x6`). Gate `getRevision(blockId, 6)` so `noDivergentRewrite` sees rev 6 absent,
then pauses. In the window, `saveReplicatedBlock(six, { rev: 6, actionId: 'r6' })` completes under
its *different* lock. Observed: `getRevision(6) = x6`, `meta.latest = {rev 5}` (regressed from 6).

**B — a pend erases a committed `latest`.** Fresh block, no metadata. Gate `getMetadata` to pause
after returning `undefined` to `savePendingTransaction`. In the window,
`saveReplicatedBlock(one, { rev: 1, actionId: 'r1' })` lands rev 1. Release. Observed:
`meta = { ranges: [] }` — `latest` gone. Reachable by two clients racing an insert of the same id.

## Why renaming the three keys to one deadlocks (hence the token design)

Every one of these holds the outer commit latch and then calls something that took an inner
`BlockStorage` latch: `saveReplicatedBlock` → `saveReplica`; `commit` / `get`'s promotion →
`internalCommit` → `readCommitBase` → `getBlock` → `ensureRevision`; `backFillProof` → `getBlock`;
`applyInvalidation`'s `runLatched` → `saveReplica` / `saveDeletion`. `Latches`
(`packages/db-core/src/utility/latches.ts`) is a plain FIFO promise-chain mutex: no owner
tracking, no re-entrancy. Cross-platform constraint (browser, RN) rules out `AsyncLocalStorage`.

## Design: one key, one acquirer, a mandatory token on every write (LANDED — see resume-note)

`block-latch.ts` exports `blockWriteLatchKey`, `BlockWriteLatch`, `acquireBlockWriteLatch`,
`withBlockWriteLatch`. After landing, `grep -rn "Latches.acquire" packages/db-p2p/src/storage`
must return **exactly one** hit (it will once `storage-repo.ts` is converted).

`getBlock(rev?)` is **local-only**; restore is an explicit latched call `restoreRevision(rev, latch)`.

## Resolved design decisions (do not re-derive)

- **Latch parameter position: LAST on every method** (done in the interface).
- **`getBlock` local-only semantics** (done): no metadata → `undefined`; pending-only + `rev`
  undefined → `undefined`; target rev outside `meta.ranges` → throw `RevisionNotCoveredError`;
  covered → `materializeBlock` as before (its throws for missing materialization unchanged).
- **`restoreRevision(rev, latch)`** (done): one metadata read under the held latch, `inRanges` →
  return, else `restoreBlock` → `vetRestoredArchive` → `saveRestored` → merge coverage →
  `saveMetadata`. No metadata → throw.
- **Healing lives in `StorageRepo.get`, in one private helper** (call it `readBlockHealing`): try
  `getBlock(rev)`; on `RevisionNotCoveredError` → `withBlockWriteLatch(blockId, l => storage.restoreRevision(err.rev, l))`
  → re-read `getBlock(rev)`. If the restore throws: when `await storage.getLatest()` is `undefined`
  (pending-only block) log and return `undefined` — absence, not fault — otherwise rethrow (→ the
  existing `unavailable: 'unmaterializable'` catch). This preserves BOTH behaviors the old
  `getBlock` pending-only arm pinned: the restore is still *attempted* for a named rev on a
  pending-only block, and its failure reads as absent. The second read's `materializeBlock` throw
  (restored records with no materialization) still propagates as unmaterializable.
- **Every other `getBlock` caller is plain local-only** and its existing catch (or lack of one) is
  correct as-is: `readCommitBase` (any throw → `refuseMissingBase`), `backFillProof` (catch →
  withhold proof), `previewCommitDigest` (catch → `digest: undefined`), `commit`'s recovered-block
  collection lookup (unwrapped today, stays unwrapped), `invalidation.ts` `computeRevertedBlock`
  and `cascade.ts` re-evaluator (a `RevisionNotCoveredError` propagates — do NOT map it to
  `undefined` there: `undefined` means "write a delete tombstone" / "invalidate").
- **`StorageRepo.commit`:** acquire via `acquireBlockWriteLatch` per *unique, sorted* id (deadlock
  order), keep a `Map<BlockId, BlockWriteLatch>`, but build `blockStorages` in **request order,
  deduped** (`Array.from(new Set(request.blockIds))`) so change-event `blockIds` ordering is
  unchanged. Thread `latch` through `internalCommit` (put it before the optional `proof`),
  `backFillProof`, `persistProofIfContentMatches`, `refuseMissingBase`, `readCommitBase`,
  `dropUnpromotablePendings` (entries carry `latch`), `storage.recover(latch)`.
- **`StorageRepo.pend` and `cancel`:** `Promise.all` over blocks, each branch
  `withBlockWriteLatch(blockId, l => storage.savePendingTransaction(..., l))` /
  `deletePendingTransaction(..., l)`. One latch per branch, never nested. Fixes repro B.
- **`saveReplicatedBlock`:** one `withBlockWriteLatch` scope over `getLatest` → `saveReplica(block, source, verifiedProof, l)` → `backFillProof`. **`recoverBlock`:** `withBlockWriteLatch(id, l => storage.recover(l))`.
- **`dispute/invalidation.ts`:** delete `runLatched` and `InvalidationContext.withBlockCommitLatch`;
  import `withBlockWriteLatch` from `../storage/block-latch.js`; each compensating write is
  `withBlockWriteLatch(blockId, l => storage.saveDeletion({ rev, actionId: revertActionId }, l))` /
  `saveReplica(computation.block, { rev, actionId: revertActionId }, undefined, l)`.
  **`cascade.ts`:** delete `CollectionEnv.withBlockCommitLatch` (type + doc) and its pass-through in
  the `applyInvalidation` call.
- **`libp2p-node-base.ts`** — the dead alias `const blockCommitLatch = withBlockCommitLatch; void blockCommitLatch;`
  and its comment block: delete, and drop `withBlockCommitLatch` from the import.
- **Delete** `commitLatchKey` and `withBlockCommitLatch` from `storage-repo.ts`; drop `Latches`
  from its `@optimystic/db-core` import; import `RevisionNotCoveredError` from `./block-storage.js`
  and the latch helpers from `./block-latch.js`. Update the comments in `get` / `internalCommit` /
  `recoverBlock` / `saveReplicatedBlock` that name the "commit latch" to say "block write latch".
- **`src/index.ts`:** add `export * from "./storage/block-latch.js";` beside the other storage exports.
- **`materializeBlock`'s re-cache** stays outside the latch — the one named exclusion; its comment
  already says so (the `NOTE:` proper is in the follow-up ticket).
- `raw-storage-conformance.ts` — the `BlockStorage saveReplica → saveDeletion` parity test calls
  `bs.saveReplica(...)` / `bs.saveDeletion(...)` directly: wrap each in
  `withBlockWriteLatch(blockId, l => ...)` (import from `../storage/block-latch.js`).
  `mesh-harness.ts` / `reactivity-mesh-harness.ts` / quereus `collection-factory.ts` only
  *construct* `BlockStorage` — unaffected.

## Test churn map (mechanical — fan out to sub-agents once `typecheck` is clean for `src/`)

Wrap each multi-call seed sequence in ONE scope:
`await withBlockWriteLatch(blockId, async l => { await s.savePendingTransaction(a, t, l); await s.saveMaterializedBlock(a, b, l); await s.saveRevision(1, a, l); await s.promotePendingTransaction(a, l); await s.setLatest({...}, l); })`.
`withBlockWriteLatch` / `blockWriteLatchKey` import from `'../src/storage/block-latch.js'`.

- `test/storage-repo.spec.ts` — ~15 seed sequences (around lines 144-148, 169-173, 193-197,
  292-296, 341-345, 404-408, 929-933, 963-967, 1019-1023, 1103-1107, 1158-1167, 1198-1211,
  1514-1518, 1590-1594, 2414); `commitLatchKey` at lines 2, 1038, 1169 → `blockWriteLatchKey`.
- `test/block-storage.spec.ts` — every direct `savePendingTransaction` / `saveReplica` /
  `saveDeletion` / `saveMaterializedBlock` / `saveRevision` / `promotePendingTransaction` /
  `recover` call on a `BlockStorage` gains the latch (`grep -n` for them; ~40 sites). The
  `SkipPruneStorage` override of `pruneSupersededMaterialization` (~line 1128) gains the latch
  param. Restore-path tests that call `storage.getBlock(rev)` expecting a restore (lines ~76-110,
  128-200, 618-960 incl. `expectRestoreRefused` ~640, 1086, 1159) become
  `withBlockWriteLatch(id, l => storage.restoreRevision(rev, l))` then `getBlock(rev)` — or go
  through `StorageRepo.get` with `context: { rev, committed: [] }`, which exercises the real
  healing helper. The 'restore comes back empty reads absent' and 'restore not short-circuited'
  tests (~76, ~128) are about the *StorageRepo.get* nuance now — move them to the repo level. The
  "named rev on a pending-only block with NO restoreCallback reads absent" test (~110) likewise
  goes through `StorageRepo.get` (direct `getBlock(1)` now throws `RevisionNotCoveredError`).
  **Rewrite** the ~434 'saveReplica and saveDeletion are mutually exclusive (shared latch)' test
  as "two `withBlockWriteLatch` scopes on one block never overlap" (same `LatchProbeStorage`).
  Repros A and B (already at the end of the file) must pass unchanged.
- `test/invalidation.spec.ts` — imports at lines 7-8; `commitLatchKey` at ~741 and ~843 →
  `blockWriteLatchKey`; the `probe`/`gatedLatch` runners injected via `withBlockCommitLatch` no
  longer have an injection point — rewrite ~731 and ~826 to hold `blockWriteLatchKey(blockId)`
  externally via `Latches.acquire` (test-side only) and assert apply parks / commit queues.
  **Delete** ~780 'WITHOUT the latch, a concurrent commit clobbers the invalidation (documents the
  lost update)' — the unlatched write it documents is now unrepresentable (say so in the handoff).
  ~888, ~900-901 `saveDeletion` gain the latch.
- `test/commit-proof.spec.ts` ~459-461, `test/proof-keyspace-isolation.spec.ts` ~115, 132-133,
  `../db-p2p-storage-fs/test/file-storage.spec.ts` ~108 (`blockStorage.recover(l)`).
- `test/cascade.spec.ts` constructs `CollectionEnv` literals — drop any `withBlockCommitLatch` key
  if present (grep).

## TODO

### Phase 3 — call sites (NOT started)
- `storage-repo.ts`: `get` (promotion scope + `readBlockHealing`), `pend`, `cancel`, `commit`,
  `recoverBlock`, `saveReplicatedBlock`, `internalCommit`, `backFillProof`,
  `persistProofIfContentMatches`, `readCommitBase`, `refuseMissingBase`,
  `dropUnpromotablePendings`. Delete `commitLatchKey` / `withBlockCommitLatch`.
- `dispute/invalidation.ts`, `dispute/cascade.ts`, `libp2p-node-base.ts`, `src/index.ts`,
  `src/testing/raw-storage-conformance.ts`.
- Verify `grep -rn "Latches.acquire" packages/db-p2p/src/storage` → exactly one hit, and
  `grep -rn "commitLatchKey\|withBlockCommitLatch\|ensureRevision" packages --include=*.ts --exclude-dir=dist --exclude-dir=node_modules`
  → only doc prose / test files left (docs are the follow-up ticket's; tests are Phase 4).

### Phase 4 — tests
- Apply the churn map (sub-agents per file are fine; give them the line lists above).
- Repros A and B now pass.

### Phase 5 — validate
- `yarn workspace @optimystic/db-p2p test` (whole package).
- `yarn workspace @optimystic/db-p2p-storage-fs test`.
- `yarn build && yarn typecheck` from root (the token crosses into `quereus-plugin-optimystic`,
  whose specs import its own `dist/`), then `yarn workspace @optimystic/quereus-plugin-optimystic test`.

### Handoff
- Write the `review/` ticket: use cases = repros A/B, the deleted "documents the lost update"
  test, the `getBlock` local-only behavior change (commit path never fetches — the follow-up
  ticket `block-write-latch-docs-and-commit-path-test` adds the test for that), and the
  `saveReplica` signature change (two `undefined` positionals) as the reviewer's API-surface check.
