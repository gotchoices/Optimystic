description: The storage docs now describe the single per-block write lock that replaced three older locks, the one place that deliberately writes outside it is marked in the code, and tests prove a commit no longer reaches out to other machines for missing history while it is holding locks.
files: packages/db-p2p/docs/storage.md, packages/db-p2p/readme.md, packages/db-p2p/src/storage/block-latch.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md, docs/repository.md, packages/db-p2p-storage-ns/src/ns-opener.ts
----

# What landed

Documentation, in-code `NOTE:`s, and behaviour-pinning tests — the parts
`debt-block-writes-use-three-different-per-block-locks` deferred after it landed the code
(`block-latch.ts`, the `BlockWriteLatch` token on every `IBlockStorage` write, local-only
`getBlock`, explicit `restoreRevision`). **No runtime behaviour changed in this ticket** — every
source edit is a comment; the only executable additions are tests.

## The invariant, as documented

`packages/db-p2p/docs/storage.md` §2 is now "Every write to a block holds that block's single write
latch", stated over the **whole metadata blob** (`{ latest, ranges }` is read and written whole, so
any read-modify-write rewrites `latest` whether it meant to or not) plus revision records,
transforms, pending records and stored proofs. It names the one key (`Block.write:<blockId>`,
`blockWriteLatchKey`), names `block-latch.ts` as the single acquirer, gives the two enforcement
mechanisms (a required `BlockWriteLatch` parameter on every writing method, so an unlatched write
does not type-check; plus the grep below), and records `materializeBlock`'s re-cache as the one
named exclusion.

The old "Known deliberate exception" paragraph — about hosts supplying no latch runner to
`InvalidationContext.withBlockCommitLatch` / `CollectionEnv.withBlockCommitLatch` — is deleted;
those optional capabilities no longer exist.

## The check the docs make

```bash
grep -rnE "Latches\.acquire\(" packages/db-p2p/src
```

The escaped-regex spelling does not contain the literal call text, so prose stating the check is
not itself a hit (the naive unescaped form is self-matching, which is why it was replaced). The
same corrected check is in `block-latch.ts`'s header comment.

## `NOTE:`s at the two code sites

- `block-storage.ts`, `materializeBlock`'s `saveMaterializedBlock` after the retention check — the
  one write outside the latch, with why it is safe, why taking the latch there is not an option
  (a lock acquisition on every cold historical read, and self-deadlock against the commit path,
  which reaches `materializeBlock` via `getBlock` while holding the latch), and that dropping the
  re-cache is out of scope until someone measures the cold historical-read cost without it.
- `storage-repo.ts`, `readCommitBase` — the commit path deliberately does not restore in line.
  Names the calling context (`commit` holds every batch block's latch across this call), the
  refusal (`MissingBaseRevisionError`), the healing route (cohort reconcile → `saveReplicatedBlock`
  → retry), the pinning test, and where a future fetch would have to go instead (before the
  latches, not underneath them).

## The tests

`packages/db-p2p/test/storage-repo.spec.ts`, describe **"commit reads its base locally (no peer
fetch inside the latched critical section)"** — 5 tests. A `restoreCallback` that *can* answer for
rev 3 is wired into the `BlockStorage` factory and counts every call.

- **control: the READ path DOES fetch this same base from the peer** — same metadata, same wiring,
  through `repo.get()`. Keeps the "0 restore calls" assertions from being vacuous.
- **refuses a commit whose base is not locally covered, without calling the restore callback** —
  `{ latest: { rev: 3 }, ranges: [] }`. Asserts the refusal reason, zero restore calls, the pending
  record dropped, and `latest` untouched.
- **the refusal really is gated on the block write latch** *(added in review — see findings)*.
- **refuses the same way … when history under a claimed range is truncated** — `ranges: [[3]]` with
  no revision records: different throw inside `getBlock`, same refusal path, same zero fetches.
- **a multi-block batch refuses without a fetch, with every block in the batch latched** — the
  shape that made the old in-line restore expensive.

## Validation

```
yarn lint                                   # clean
yarn workspace @optimystic/db-p2p build     # clean
yarn workspace @optimystic/db-p2p test      # 2305 passing, 44 pending, 0 failing
yarn test                                   # all workspaces, 0 failing
```

The 44 pending are pre-existing skips elsewhere in the suite; this ticket added no `.skip`/`.only`.

# Review findings

Reviewed the implement diff (`5ed4c03b`) against the source before reading the handoff, then
verified every factual claim the diff makes rather than accepting it.

## Verified — claims that hold

- **The documented grep check.** Re-ran `grep -rnE "Latches\.acquire\(" packages/db-p2p/src` →
  exactly one line, `block-latch.ts:71`. The handoff's correction of the ticket's originally
  specified (self-matching) check is right.
- **The `IBlockStorage` writing-method list in storage.md is exact** — 12 methods listed, 12
  methods in the interface take a `BlockWriteLatch`, same set. And all 12 implementations call
  `assertLatch` (12 call sites in `block-storage.ts`).
- **The invariant is complete inside `BlockStorage`, not just at its interface.** Mapped every
  `this.storage.{save,delete,promote}` call in `block-storage.ts` to its enclosing method: all are
  inside latched public methods or private helpers (`saveForwardRevision`, `saveRestored`) reached
  only from them — with `materializeBlock:493` the single exception, exactly as documented. The
  static "does not type-check" guarantee holds at the `IBlockStorage` boundary; the raw-storage
  writes inside `BlockStorage` are covered by inspection, and this is the check that covers them.
- **storage.md §2's list of latch-taking writers is complete.** Enumerated every
  `withBlockWriteLatch`/`acquireBlockWriteLatch` call in `src`: `pend`, `cancel`, read-driven
  promotion in `get`, `restoreRevision`, `recover`, `saveReplicatedBlock`, `commit`, and
  invalidation's `saveDeletion`/`saveReplica`. No writer is missing from the doc. (The one caller
  not listed is `src/testing/raw-storage-conformance.ts`, a test harness, not a production writer.)
- **"Sorted block-id order" is real** — `storage-repo.ts:620` sorts `blockIds` and acquires in that
  order up front, and `commit` is indeed the only multi-latch caller.
- **The six renames the handoff flagged as scope creep are correct, not merely plausible** —
  checked each against the code, including `internals.md:786`, which reasons about a deadlock using
  the key by name: `saveReplicatedBlock` does take `Block.write:<blockId>`, so the deadlock argument
  survives the rename intact. `internals.md:167` (`previewCommitDigest` is read-only and takes no
  latch), `repository.md:198` (prune runs inside `commit`, under the latch), `ns-opener.ts:145`
  (same-block promote is latched), and the two `ensureRevision`→`restoreRevision` renames at
  `internals.md:981/986` (that is the method that vets restored archives) all check out.
- **The stale-terminology sweep is clean.** Independently swept `commitLatchKey`,
  `withBlockCommitLatch`, `StorageRepo.commit:`, `ensureRevision`, `savePendingAction`,
  `promotePendingAction`, `per-block commit latch`, and prose describing multiple locks, across all
  `.md` and `.ts` outside `tickets/` and `dist/`. The only surviving `ensureRevision` mentions are
  two test comments that explicitly describe the *pre-change* behaviour — accurate history, not rot.

## Found and fixed in this pass (minor)

- **`materializeBlock`'s NOTE overclaimed its own safety argument.** It said "a concurrent writer
  racing on the same key writes the same bytes". Not exhaustively true: the racer that does *not*
  is `pruneSupersededMaterialization`, which writes `saveMaterializedBlock(..., undefined)` — a
  delete at the same `(blockId, actionId)` key. Losing that race resurrects a materialization the
  checkpoint sweep just removed. Content is never wrong (the resurrected bytes are a correct
  materialization of that rev), so the consequence is a bounded storage leak, and the adjacent
  fresh-`retentionMeta` read narrows the window but cannot close it — a commit can land and prune
  between that read and the save. Qualified the claim at the call site and in storage.md; the
  residual race is recorded as a tripwire, below.
- **No test proved `commit` actually takes the latch** — the premise the entire change rests on.
  The four shipped tests prove no fetch happens, but would have passed equally against a `commit`
  that took no latch at all, which would make "no network I/O in the critical section" vacuous.
  Added **"the refusal really is gated on the block write latch"**: holds `Block.write:<blockId>`
  externally, starts the commit, asserts it parks (no result, pending record still present) across
  a bounded window, releases, then asserts the refusal lands with still zero restore calls. Uses
  the same held-mutex pattern as the two existing latch-bypass regressions in this file
  (`storage-repo.spec.ts:1052`, `:1172`), including their release-in-`finally` discipline — the
  latch is a process-global mutex and a leaked hold would wedge every later test. This closes the
  gap the handoff flagged honestly as "a genuine coverage gap".
- **storage.md §"4. Restoration System" was stale and contradicted §Core Components.** Its bullets
  still read as if reads restore implicitly ("Lazy Loading: Restores data only when needed"), which
  is precisely the behaviour this change removed. Rewrote to state that restoration is explicitly
  triggered only via `restoreRevision`, that `getBlock` reports the gap and returns, and that
  `StorageRepo.get` is the only caller that heals. This is the doc section the diff *should* have
  touched and didn't.
- **Two unwrapped lines** in the new storage.md prose (98 and 111 columns against the file's ~76)
  rewrapped, and a clause added noting the grep is scoped to `src` on purpose because tests do
  acquire the key directly, to hold it against the code under test — otherwise a reader running an
  unscoped grep gets five extra hits and thinks the invariant is broken.

## Tripwires recorded (not filed as tickets)

- **Unlatched re-cache vs. the checkpoint sweep.** `materializeBlock`'s unlatched
  `saveMaterializedBlock` can lose a race to `pruneSupersededMaterialization` and resurrect a
  materialization the sweep removed — bounded storage growth, never wrong content. Parked as a
  `NOTE:` at the call site in `block-storage.ts` (with the two ways to close it: re-check retention
  inside the raw driver's save, or re-run the sweep after the read) and one sentence in storage.md
  §2. Conditional on materialization storage being observed to grow under read load; no work today.

## Considered and not filed

- **The synthetic seeded state** the handoff flags (`{ latest: { rev: 3 }, ranges: [] }` written
  straight to raw storage, because no code path produces it today). Not a defect in the tests: the
  second arm, `ranges: [[3]]` with truncated history, *is* a reachable state and drives the same
  refusal path, so the coverage is not hypothetical. The first arm exercises the
  `RevisionNotCoveredError` branch that `readCommitBase`'s pre-existing NOTE calls currently
  unreachable — testing a defensive branch is legitimate and cheap, and the test docblock says
  plainly what it is standing in for.
- **A `BlockStorage` double throwing from `getBlock`** as the alternative to that seeding. It trades
  realism of storage state for realism of the failure and would not test more; the current shape
  exercises the real `BlockStorage` throw sites, which is the better half of the trade.

## Not found

No correctness defect, no resource leak, no type-safety gap, and no dead or duplicated code in this
diff — which is expected for a change whose only source edits are comments, and is stated here as a
result rather than as an absence of looking: the substantive checks were the invariant-completeness
sweep and the claim verification above, and those are where the four fixes came from.

## Source hygiene

`block-latch.ts` is 95 lines and reads well. `storage-repo.ts` (1335) and `block-storage.ts` (778)
are large but this ticket added only comments to them, and the comment-to-code ratio at
`readCommitBase` and `materializeBlock` is high by the deliberate house style — these are the two
sites where a future contributor is most likely to reintroduce the bug the previous ticket removed,
and the prose is load-bearing rather than decorative. Not flagged.
