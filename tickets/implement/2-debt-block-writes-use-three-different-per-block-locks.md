description: Four different parts of the storage layer each write a block's bookkeeping record, but they do not all take the same lock first (one takes no lock at all), so two can run at once on the same block and silently undo each other's work. Both failures were reproduced: one loses a committed version entirely, the other files a version under the wrong change-id.
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/docs/storage.md
difficulty: hard
repro: verified
----

# One block, one write lock

## Root cause, restated

The existing rule is written over **`meta.latest`** — "every out-of-band writer of a block's
`meta.latest` must serialize on the per-block commit latch"
(`packages/db-p2p/docs/storage.md` §2, and `commitLatchKey`'s doc comment at
`storage-repo.ts:21-27`).

That is the wrong noun, and it is why the rule has holes. A block's metadata is stored as **one
blob** — `{ latest, ranges }` — read and written whole. Any path that does
read-metadata → modify → write-metadata overwrites `latest` **whether it means to change it or
not**. Two paths modify only `ranges` and consider themselves innocent bystanders; they are not.

So the invariant has to be stated over **the whole metadata blob**, not over `latest`:

> A block's metadata, revision records, action transforms, pending records, and stored proofs are
> only ever written while holding **one** named lock for that block.

## The four writers today

| Writer | Lock it takes |
|---|---|
| `StorageRepo.commit` / `saveReplicatedBlock` / `withBlockCommitLatch` | `StorageRepo.commit:<blockId>` |
| `BlockStorage.saveForwardRevision` (via `saveReplica` / `saveDeletion`) | `BlockStorage.saveReplica:<blockId>` |
| `BlockStorage.ensureRevision` (restore-a-missing-revision) | `BlockStorage.ensureRevision:<blockId>` |
| `BlockStorage.savePendingTransaction` (seeds metadata for a new block) | **none** |

`grep -rn "Latches.acquire" packages/db-p2p/src` — five sites, three distinct block key
expressions, at `block-storage.ts:304`, `block-storage.ts:391`, `storage-repo.ts:41`,
`storage-repo.ts:601`, `storage-repo.ts:887`.

The fourth row is new information the original ticket did not have.
`BlockStorage.savePendingTransaction` (`block-storage.ts:122-135`) reads metadata, and when the
block has none, writes `{ latest: undefined, ranges: [] }`. It takes no lock, and neither does its
only caller, `StorageRepo.pend` (`storage-repo.ts:530-540`) — deliberately, per the comment there
("Locking here … adds overhead. The current approach prioritizes letting the commit be the final
arbiter"). That reasoning is sound about the *conflict checks* and wrong about the *metadata
write*.

## Both failures, reproduced

Written as a throwaway `packages/db-p2p/test/zz-block-lock-race.repro.ts`, run under
`node --import ./register.mjs node_modules/mocha/bin/mocha.js`, then deleted. Both failed on
current `main`. Rebuild them as permanent regression tests (see TODO).

Interleaving is forced deterministically by subclassing `MemoryRawStorage` and pausing one accessor
on a promise the test releases — **pause after the underlying read returns**, so the racing writer
lands in the window the check has already looked past. Pausing before the read only re-reads the
new value and the guard correctly refuses.

### A — restore cross-writes a revision and regresses `latest`

Seed the block at rev 5 (coverage opens at E = 5, so rev 2 is a genuine gap). A peer answers the
pin at rev 2 with rev 2 **and volunteers rev 6** — allowed and normal: an honest peer serves a
contiguous span, and `vetRestoredArchive` writes entries above the pin while declining to *claim*
them as coverage. Gate `getRevision(blockId, 6)` so `noDivergentRewrite` observes rev 6 as absent
and then pauses. In that window, `saveReplica(six, { rev: 6, actionId: 'r6' })` runs to completion
under its *different* lock and returns `{ rev: 6, actionId: 'r6' }`. Release the gate.

Observed:

```
[A] getRevision(6) = x6   meta.latest = {"actionId":"a5","rev":5}   ranges = [[2,3],[5]]
```

Three corruptions from one interleave:

- **Revision cross-write.** Rev 6 names the peer's action `x6`, though the local write committed
  `r6` and told its caller so. `noDivergentRewrite` — added by
  `restore-trusts-any-archive-a-peer-returns` precisely to make this impossible — was defeated by
  timing alone.
- **`latest` regression, 6 → 5.** `ensureRevision` writes back the metadata snapshot it read before
  the replica landed. This is worse than the original ticket predicted: not a lost `ranges` merge
  but a **non-monotonic regression below a durably-committed revision**, exactly what the commit
  latch exists to prevent.
- **Announcement disagrees with storage.** `StorageRepo.saveReplicatedBlock` computed `advanced`
  and emitted a collection-change event for rev 6 / `r6` against a `latest` that has since been
  rolled back.

### B — a pend erases a committed `latest`

Fresh block, no metadata. Gate `getMetadata` to pause **after** returning `undefined` to
`savePendingTransaction`. In the window, `saveReplica(one, { rev: 1, actionId: 'r1' })` lands rev 1
durably. Release.

Observed:

```
[B] meta = {"ranges":[]}   getRevision(1) = r1
```

`latest` is gone. The revision record and materialization are durably on disk, but
`getLatest()` returns `undefined`, so the block reads as pending-only and the committed revision is
invisible. It self-heals only if something later calls `BlockStorage.recover()`, which happens on a
commit retry — not on the read path.

Reachable in normal operation: two clients racing an insert of the same block id. Client A pends
(metadata absent), commits; client B's pend, started earlier, reads metadata as absent and writes
its seed on top afterwards.

## Why the obvious repair deadlocks — four nesting sites, not one

Renaming all three keys to one deadlocks immediately. Every one of these holds the outer commit
latch and then calls something that takes an inner `BlockStorage` latch:

1. `StorageRepo.saveReplicatedBlock` (`:887`) → `saveReplica` → `saveForwardRevision` (`:304`).
2. `StorageRepo.commit` (`:601`) and `get`'s read-driven promotion (`withBlockCommitLatch`, `:41`)
   → `internalCommit` → `readCommitBase` (`:1219`) → `getBlock` → `ensureRevision` (`:391`).
3. `StorageRepo.commit`'s recovered-block collection lookup (`:734-735`) and `backFillProof`
   (`:1122`) → `getBlock` → `ensureRevision`.
4. `dispute/invalidation.ts` `applyInvalidation`'s `runLatched` (`:589-606`) →
   `saveReplica` / `saveDeletion` → `saveForwardRevision`.

The original ticket named only site 2. Any design must handle nesting generally.

Note also that `Latches` (`packages/db-core/src/utility/latches.ts`) is a plain FIFO mutex with no
owner tracking and no re-entrancy, and the codebase must stay cross-platform (browser, React
Native), so `AsyncLocalStorage` is not available to infer "am I already inside?".

## Design to build

**One key, one acquirer, a mandatory token on every write.** This makes "wrote without the lock"
unrepresentable in the type system rather than remembered in a comment, and makes the invariant
checkable by a one-line grep.

### New module `packages/db-p2p/src/storage/block-latch.ts`

```ts
export const blockWriteLatchKey = (blockId: BlockId): string => `Block.write:${blockId}`;

/** Opaque proof the bearer is inside `blockWriteLatchKey(blockId)`. Only this module mints one. */
export class BlockWriteLatch {
	private constructor(readonly blockId: BlockId) { }
}

/** Acquire a block's write latch. THE only `Latches.acquire` site for a block key. */
export async function acquireBlockWriteLatch(blockId: BlockId): Promise<{ latch: BlockWriteLatch; release: () => void }>;

/** Scoped sugar over the above. */
export async function withBlockWriteLatch<T>(blockId: BlockId, fn: (latch: BlockWriteLatch) => Promise<T>): Promise<T>;
```

`acquireBlockWriteLatch` (not only the scoped form) is required because `StorageRepo.commit` holds
N block latches simultaneously, acquired in sorted id order and released in `finally`.

Its own module rather than `storage-repo.ts` so `block-storage.ts` can import the key without an
import cycle. After this lands, `grep -rn "Latches.acquire" packages/db-p2p/src/storage` must
return **exactly one** hit — that grep *is* the invariant check.

### `IBlockStorage`: writes demand a token

Every writing method takes `latch: BlockWriteLatch` as a **required** parameter:
`savePendingTransaction`, `deletePendingTransaction`, `saveMaterializedBlock`, `saveRevision`,
`promotePendingTransaction`, `setLatest`, `saveBlockProof`, `pruneSupersededMaterialization`,
`saveReplica`, `saveDeletion`, `recover`, and the new `restoreRevision`. `BlockStorage` asserts
`latch.blockId === this.blockId` (cheap, catches a token for the wrong block).

### `getBlock` becomes local-only; restore becomes an explicit, latched call

```ts
/** Materialize from LOCAL records only. Never fetches from a peer, never writes metadata or records. */
getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined>;

/** Repair a genuine coverage gap at `rev` from peers. No-op when `ranges` already covers it. */
restoreRevision(rev: number, latch: BlockWriteLatch): Promise<void>;
```

`restoreRevision` is today's `ensureRevision` body minus its own `Latches.acquire`. It keeps the
re-read-and-recheck-`inRanges`-under-the-lock step, so a caller may invoke it unconditionally after
a short local read and it costs nothing when coverage already holds.

This is what makes deadlock **structurally impossible**: `withBlockWriteLatch` /
`acquireBlockWriteLatch` are the only acquirers, and nothing reachable from inside a token scope
acquires anything.

### Call-site changes

- `StorageRepo.get` — the one read that should heal. Local `getBlock`; if it comes up short,
  `withBlockWriteLatch(blockId, l => storage.restoreRevision(rev, l))` and re-read.
- `StorageRepo.pend` — wrap each block's `savePendingTransaction` in `withBlockWriteLatch`. Each
  parallel branch holds at most one latch and never nests, so it cannot deadlock against `commit`'s
  sorted multi-acquire. **Fixes repro B.**
- `StorageRepo.commit` — build one `IBlockStorage` per *unique, sorted* blockId up front (today it
  acquires by key first and builds storages afterwards from the unsorted `request.blockIds`),
  acquire each block's latch with `acquireBlockWriteLatch`, and thread the tokens through
  `internalCommit`.
- `saveReplicatedBlock` — `withBlockWriteLatch` bracketing `getLatest` → `saveReplica` →
  `backFillProof` as one critical section; pass the token down.
- `readCommitBase`, `backFillProof`, `commit`'s recovered-block collection lookup,
  `previewCommitDigest` — plain local `getBlock`. See *Behavior changes* below.
- `dispute/invalidation.ts` — delete `runLatched` and the optional `withBlockCommitLatch` capability
  from `InvalidationContext`; `dispute/cascade.ts` — same for `CollectionEnv`. The write methods now
  demand a token, and `withBlockWriteLatch` is a free function any host can call, so the "host
  supplied no runner, write runs unlatched" exception documented in
  `packages/db-p2p/docs/storage.md` §2 disappears rather than being re-documented.
- `dispute/invalidation.ts:434` (`computeRevertedBlock`) and `dispute/cascade.ts:147` — local
  `getBlock`. Both ask "what did *this node* observe/hold", so local-only is the more honest read.
- `saveForwardRevision` and `ensureRevision`/`restoreRevision` stop acquiring; they take the token.

### Behavior changes to make deliberately, and test

**The commit path no longer restores in line.** Today `readCommitBase` → `getBlock` → `ensureRevision`
can fetch a missing base from a peer while N block latches are held. After this change it cannot;
the read fails locally and `refuseMissingBase` raises `MissingBaseRevisionError`, which is the
documented healing route (`ClusterMember` reconciles the block from a cohort peer and the commit
retries — see `MissingBaseRevisionError`'s own doc comment). This also removes network I/O from
inside a multi-block critical section, which is a latency and availability improvement in its own
right. Write a test that a commit against an uncoverable base refuses with
`MISSING_BASE_REVISION_REASON` rather than hanging on a restore.

**`previewCommitDigest` keeps its "never take the latch" property, now structurally.** Its doc
comment already says taking the commit latch there would serialize voting behind commits; under a
unified key its current `getBlock` → `ensureRevision` *would* take it. Local-only reading preserves
the stated intent, and its documented `digest: undefined` fallback ("the base exists but cannot be
materialized locally") already covers the case.

### The one carve-out, to be stated by name

`materializeBlock`'s re-cache of a replayed materialization at a retained rev
(`block-storage.ts:479-484`, `saveMaterializedBlock`) runs on the read path and stays outside the
latch. Keep it, and add a `NOTE:` at that site saying so and why: it is keyed by
`(blockId, actionId)` and its value is a deterministic replay of retained transforms, so a
concurrent writer of that same key writes the same bytes. Do not silently leave it unmentioned — the
invariant text must name it as excluded, or the next reader will read the invariant as false.

Dropping the re-cache instead is *not* in scope: nobody has measured what cold historical reads cost
without it.

## Files and anchors

- `packages/db-p2p/src/storage/block-storage.ts` — `saveForwardRevision` (~283-380, latch at 304),
  `ensureRevision` (~385-425, latch at 391), `savePendingTransaction` (122-135),
  `materializeBlock`'s re-cache (~479-484), `saveRestored`, `vetRestoredArchive`,
  `noDivergentRewrite`.
- `packages/db-p2p/src/storage/storage-repo.ts` — `commitLatchKey` (28), `withBlockCommitLatch`
  (39-46), `get` (218+), `pend` (~530-540), `commit` (585+, latch 601), `saveReplicatedBlock` (884+,
  latch 887), `previewCommitDigest` (~960-1001), `internalCommit` (1019+), `backFillProof`
  (~1114-1127), `readCommitBase` (~1208-1226).
- `packages/db-p2p/src/storage/i-block-storage.ts` — the interface, and the Invariant P prose that
  must survive the signature churn.
- `packages/db-core/src/utility/latches.ts` — the FIFO mutex; unchanged, but read it before
  designing anything that assumes ownership tracking.
- `packages/db-p2p/docs/storage.md` §2 (lines ~53-90) — the invariant text to rewrite.
- Consumers whose call sites move with the signatures:
  `packages/db-p2p/src/testing/raw-storage-conformance.ts`,
  `packages/db-p2p/src/testing/mesh-harness.ts`,
  `packages/db-p2p/src/testing/reactivity-mesh-harness.ts`,
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`,
  `packages/db-p2p/src/libp2p-node-base.ts:843,1163`,
  `packages/db-p2p/src/cluster/block-transfer-service.ts:445`,
  `packages/db-p2p/src/cluster/reconcile-block.ts:400`.

Related but not blocking: `tickets/backlog/feat-cold-range-transform-offload.md` also touches
`block-storage.ts`, for cold-range offload. No overlap with the locking work; it will rebase.

## TODO

### Phase 1 — pin the failures

- Rebuild repro A as a permanent test in `packages/db-p2p/test/block-storage.spec.ts`: gated
  `getRevision` that pauses *after* the read; assert rev 6 still names `r6` and `latest` never
  regresses below the committed rev.
- Rebuild repro B likewise: gated `getMetadata` that pauses after returning `undefined`; assert a
  concurrent pend cannot erase a committed `latest`.
- Confirm both fail on the current tree before changing any source.

### Phase 2 — the latch module and the token

- Add `packages/db-p2p/src/storage/block-latch.ts` with `blockWriteLatchKey`, `BlockWriteLatch`,
  `acquireBlockWriteLatch`, `withBlockWriteLatch`.
- Add the required `latch` parameter to every writing method on `IBlockStorage`, with the
  `latch.blockId === this.blockId` assertion in `BlockStorage`.
- Split `getBlock` (local-only) from the new `restoreRevision(rev, latch)`; delete `ensureRevision`'s
  own `Latches.acquire`.
- Remove all three old key expressions; verify `grep -rn "Latches.acquire" packages/db-p2p/src/storage`
  returns exactly one hit.

### Phase 3 — call sites

- `StorageRepo.pend`: latch each `savePendingTransaction`.
- `StorageRepo.commit`: unique+sorted storages built up front, `acquireBlockWriteLatch` per block,
  tokens threaded through `internalCommit`.
- `StorageRepo.get`: local read → `withBlockWriteLatch(… restoreRevision …)` → re-read.
- `saveReplicatedBlock`: one `withBlockWriteLatch` scope over getLatest / saveReplica / backFillProof.
- `readCommitBase`, `backFillProof`, recovered-block collection lookup, `previewCommitDigest`:
  local-only reads.
- `dispute/invalidation.ts` + `dispute/cascade.ts`: delete `runLatched` and the optional
  `withBlockCommitLatch` capability; callers take the token directly. Local-only `getBlock` at
  `invalidation.ts:434` and `cascade.ts:147`.
- Delete `commitLatchKey` and `withBlockCommitLatch` from `storage-repo.ts` once nothing imports
  them.
- Update the testing harnesses, the conformance suite, and the quereus plugin factory for the new
  signatures.

### Phase 4 — state the invariant where a reader meets it

- Rewrite `packages/db-p2p/docs/storage.md` §2 over **metadata**, not `meta.latest`: name the single
  key, name `block-latch.ts` as the single acquirer, give the grep that checks it, and record the
  `materializeBlock` re-cache as the one named exclusion. Drop the now-removed "deliberate
  exception" paragraph about hosts that supply no latch runner.
- `NOTE:` at `materializeBlock`'s re-cache explaining why it is safely outside the latch.
- `NOTE:` at `readCommitBase` recording that the commit path deliberately no longer restores in
  line, and that healing is `MissingBaseRevisionError` → cohort reconcile → retry.

### Phase 5 — validate

- `yarn workspace @optimystic/db-p2p test` — the whole package, not only the two new tests. The
  storage specs (`block-storage.spec.ts`, `cascade.spec.ts`, the raw-storage conformance suite) are
  the ones this diff is most likely to disturb.
- `yarn build && yarn typecheck` from root — the token parameter crosses package boundaries into
  `quereus-plugin-optimystic`, whose specs import its own `dist/`.
- `yarn workspace @optimystic/quereus-plugin-optimystic test`.
- Add a commit-path test for the deliberate behavior change: a commit whose base is not locally
  coverable refuses with `MISSING_BASE_REVISION_REASON` instead of attempting an in-line restore.
