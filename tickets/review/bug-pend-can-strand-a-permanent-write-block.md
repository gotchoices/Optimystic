description: A storage node could be left holding a leftover "write in progress" marker for a write that already finished, which made the node refuse every future write to that block forever; this is now prevented in two ways and needs a review pass.
files:
  - packages/db-p2p/src/storage/storage-repo.ts (pend, ~line 501-660 — restructured into a latched two-pass form)
  - packages/db-p2p/src/storage/block-storage.ts (savePendingTransaction, ~line 158 — new rev param + refusal guard)
  - packages/db-p2p/src/storage/i-block-storage.ts (PendRevisionTakenError ~line 22; signature + docs ~line 95)
  - packages/db-p2p/src/storage/block-latch.ts (~line 93 — doc now names three callers)
  - packages/db-p2p/test/storage-repo.spec.ts (~line 2818+ — new "one atomic step" describe, 6 tests)
  - packages/db-p2p/test/block-storage.spec.ts (~line 1735+ — new seam describe, 5 tests)
  - packages/db-p2p/test/mid-ddl-crash.spec.ts (~line 330 — Crash-B assertions updated to the new sequential save)
  - docs/repository.md (Invariant P, ~line 132)
repro: verified
difficulty: medium
----

# Review: `pend` can no longer write a pending record that could never be promoted

## What was wrong

A storage node records a "this write is coming" marker (a **pending record**) for each block a
write touches, and later promotes it into a real committed revision. Promotion at commit is the
only thing that removes a marker on the success path.

`StorageRepo.pend` used to read each block's current revision **unlatched**, then write the markers
afterwards under per-block latches. A commit landing in that gap was invisible to the decision that
had already run, so a marker got written for a revision already taken. Nothing then removes it:
the follow-on commit routes the block to `alreadyDone` (or refuses it as stale) and never promotes,
and `cancel` only follows a *failed* write. From then on the node reports that marker as a
conflicting in-flight action to every later writer of the block — under the fail-on-pending policy
it refuses those writes outright, forever, while still serving reads and looking healthy.

## What was built

**Part 1 — `pend` classifies and saves under one multi-block latch hold.**
`checkPendValidation` (which can call a caller-supplied hook) stays outside. Then
`acquireBlockWriteLatches(blockIds)` wraps two passes: pass 1 does all the classification reads
(`getLatest` → satisfied / stale / pendable, plus `listPendingTransactions`), pass 2 writes the
records. All early returns (`missing`, policy `'f'`, policy `'r'`) sit inside the `try` and return
having written zero records; `finally { release() }` covers every path including the
`Missing action … for block …` throw. The old "Potential race condition …" and "Note: that this is
not atomic …" comment blocks are gone, replaced by a statement of the new property.

Two passes rather than one interleaved loop is deliberate: a single loop refused partway through
would leave records written for the earlier blocks, and retracting those under the hold could
delete a record an *earlier* pend of the same action legitimately left.

**Part 2 — the storage seam refuses an unpromotable record.**
`savePendingTransaction` gained a `rev: number | undefined` parameter (before the latch, per the
interface's latch-is-last convention) on both `IBlockStorage` and `BlockStorage`, and throws the new
`PendRevisionTakenError` when `rev !== undefined && meta?.latest !== undefined && meta.latest.rev >= rev`.
It reuses the metadata read that method already performed, so it costs one comparison and no I/O.
The `>=` deliberately collapses both unpromotable cases (own already-committed revision, and a
rival's win) — the seam asks "could this ever be promoted?", not "is this our own revision?", which
is why it does not use `isOwnRevision`.

## How to exercise it

- `yarn workspace @optimystic/db-p2p test` — **2426 passing, 0 failing** (was 2424 before this work).
- `yarn build` then `yarn typecheck` at the root — both clean.
- `yarn workspace @optimystic/db-p2p-storage-fs test` (76 passing), `-ns` (58), `-rn` (53),
  `@optimystic/quereus-plugin-optimystic` (690 passing + smoke), `@optimystic/db-core` (1459) — all clean.

New tests in `packages/db-p2p/test/storage-repo.spec.ts`, describe
**"StorageRepo.pend — classification and save are one atomic step"** (each drives a real
interleaving with a gate inside `MemoryRawStorage.getMetadata`):

- same-action commit landing in pend's window strands no record, and the commit demonstrably
  queues behind the pend rather than winning by luck;
- the block is still writable afterwards (a fresh `policy: 'f'` pend at the next revision succeeds
  — the user-visible consequence of the bug);
- different-action commit landing in the window → pend refused with `conflict: true` and
  `staleAt.rev`, no record for either action beyond the committed one;
- multi-block atomicity: a pend over `{X, Y}` where X is taken mid-window writes a record for
  neither;
- torn-action retry at exactly the committed rev is still waved through, still appears in the
  returned `blockIds`, still writes no record;
- a pend over `[X, Y]` and a commit over `[Y, X]` both settle.

New tests in `packages/db-p2p/test/block-storage.spec.ts`, describe
**"BlockStorage.savePendingTransaction — unpromotable-record refusal"**: refuses at own committed
rev; refuses below a rival's committed rev; allows one revision ahead; allows a rev-less pend on a
block with a committed `latest`; allows a fresh block and still seeds `{ latest: undefined, ranges: [] }`.
The pre-existing rev-less pend/replica race test (~line 1697) passes unchanged.

## Honest gaps — read these before signing off

- **The repro was confirmed to fail before the change.** Verified by temporarily swapping
  `storage-repo.ts` back to its `HEAD` `pend` (with `undefined` passed for the new `rev` argument, so
  the Part-2 seam guard stayed inert and Part 1 was isolated), running the new describe, and
  restoring. Result: **4 of the 6 new pend tests failed** — including "the commit must queue behind
  the pend" and "a fresh writer at the next revision must be accepted" (`false`, i.e. the block was
  genuinely wedged). The two that passed both ways are the satisfied carve-out and the deadlock
  test; those are regression guards, not repros, and that is expected.
- **The deadlock case got a real test only for the pend-vs-commit pair.** The
  pend-overlapping-`applyInvalidation` case named in the plan got **reasoning only**: all three
  multi-latch holders go through `acquireBlockWriteLatches`, which dedups and sorts, so no cycle
  exists. No test drives that pair.
- **Duplicate block ids got no test.** `blockIdsForTransforms` already builds its result through a
  `Set` (`packages/db-core/src/transform/helpers.ts:46`), so a duplicate is unrepresentable in
  `blockIds` and neither a double save nor a duplicated response entry is possible. That is read
  from the source, not asserted by a test.
- **A behaviour change outside the bug, in `mid-ddl-crash.spec.ts` Crash-B.** Pass 2 saves
  sequentially inside one hold, where the old code fanned out with `Promise.all`. So a crash on
  block b1 now also prevents b2's record from being written; previously b0 and b2 both persisted.
  Strictly fewer stranded records, and the test's real invariant ("does not permanently wedge any
  block") is unchanged — but it *is* observable, and I rewrote that test's assertions and its
  header comment to match. **Worth a second opinion that nothing else depended on the concurrent
  fan-out.** No other test or production caller was found that does.
- **`PendRevisionTakenError` is unreachable from `pend` by construction and only unit-tested
  directly at the `BlockStorage` level.** Nothing proves it *stays* unreachable; that is the design
  argument (every block reaching pass 2 was observed under the same held latch to satisfy
  `latest === undefined || latest.rev < rev`), not a test. It throws rather than returning a status
  precisely so a future check-then-act reintroduction fires loudly.
- **Latch-hold duration is not measured.** A pend now blocks concurrent commits on its blocks for
  the span of both passes, not just its writes. Parked as a `NOTE:` tripwire at the acquisition site
  in `storage-repo.ts` — everything inside is local I/O and `commit` already holds the same set for
  a comparable span, but the policy-`'r'` arm reads one transform per rival inside the hold and is
  the first thing to look at if pend latency on contended blocks ever shows up.
- **No mesh- or cluster-tier test was added.** `ClusterMember.validatePendOperations` still runs the
  same rival-pending scan; the change is entirely below it and every existing cluster test passes,
  but nothing new exercises the fix through consensus.
- **Residual stranding class is untouched and out of scope**: a client that dies between a stale
  pend result and its `cancel` still strands a record. That is pre-existing, already documented in
  `StorageRepo.commit`'s doc comment, and tracked by
  `backlog/debt-unpromotable-pending-records-need-a-sweep`.
- **Partially-overlapping pends** still see an approximate rival-pending picture across the blocks
  they do not share. Existing conservative behaviour, unchanged, and not what this fixed.

## Docs updated

`docs/repository.md` Invariant P now says how the pend-side obligation is *enforced* (the single
hold, and the seam refusal) rather than only asserting it. `block-latch.ts` names three multi-latch
callers instead of two — that comment carries the deadlock-freedom argument, so it is load-bearing.
`IBlockStorage.savePendingTransaction` documents the `rev` parameter, the refusal rule, and why it
is not an `isOwnRevision` check; `promotePendingTransaction`'s Invariant P block notes the pend side
is now enforced.
