description: When a queued change is sent again after an earlier attempt may have reached only part of the network, the collection now re-sends the recorded attempt exactly as it was instead of rebuilding it, so one change can no longer exist in two different versions on different machines under one identity.
architecture: docs/offline-sync.md#identity-across-attempts
files: packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/collection-segments.spec.ts, docs/offline-sync.md, docs/internals.md
difficulty: medium
repro: verified
----

## What changed

A head commit (the commit of a collection's oldest queued entry) opened with `resume` — the attempt an earlier cycle under the same action id recorded through the write-ahead hook — used to seed that attempt only for the opening refresh to finish a torn write from. When the refresh found nothing new, the cycle rebuilt the attempt at the same revision, minting new ids for the log data block the append creates and for the tree nodes a leaf division inserts. Storage accepts a retry of one `(action id, revision)` as the same write, so machines holding the first attempt would keep it while the rest stored the second: a permanent fork.

Now the `stage` step of the handle `Collection.headCommitHandle` returns answers the recorded attempt itself while `Collection.getNextRev()` equals `resume.rev` (`resumedAttempt` in `packages/db-core/src/collection/write-attempts.ts`, the inverse of `retainedAttempt`): a tracker over the handle's read cache seeded with a copy of the recorded transforms, carrying the recorded revision, tail id, block digests and base revisions. It deliberately skips re-judging base pins (a moved base is left to storage's base guard, as `Collection.completeOwnEntry`'s re-send already does) and the invented baseline (the recorded transforms carry those inserts); past the recorded revision a rival was adopted and the write is rebuilt. The coordinator's per-entry commit (`EntryParticipants` in `packages/db-core/src/transaction/entry-commit.ts`) calls the same `stage()` with `EntryCommit.resume`, so it shares the rule. Docs updated in `docs/internals.md` (head tracker bullet) and `docs/offline-sync.md` §Identity across attempts.

The regression test "a re-drive with resume at the revision the recorded attempt requested, after a refresh that found nothing new, re-sends the recorded attempt itself …" in `packages/db-core/test/collection-segments.spec.ts` failed before the change and passes now.

## Review findings

Read the implement diff (`ticket(implement): offline-sync-resumed-head-commit-rebuilds-the-attempt`) before the handoff.

- **Correctness — checked, no defect found.**
  - The equality rule depends on the queue handing back the attempt from the *latest* attempt, not the first: with an earlier record at R and a later, possibly-landed one at R+1, a resume at R would let the next cycle rebuild at R+1 and fork. Confirmed `OfflineQueue.recordAttempts` overwrites `entry.retained` per collection on every attempt, so it is the latest.
  - The copy in `resumedAttempt` is needed: `foldOwnCommit` hands `tracker.reset()`'s transforms to `CacheSource.transformCache`, and `refused()` retains the tracker's transforms; neither may alias the caller's record.
  - Nothing downstream of `stage()` reads the attempt tracker's pins (`Collection.send` passes transforms, digests and `baseRevs`; the coordinator reads `tailId`, `rev`, `blockDigests`, `baseRevs`), so a resumed tracker with empty pins is sufficient.
  - The refusal check still runs first (`committableHead` before `resumedAttempt`), and a refused resumed send followed by a refresh that adopts a rival moves the revision past `resume.rev`, so the next `stage()` builds normally.
  - The size check is not re-run on the resumed attempt; the recorded attempt passed it when first built, and the content is identical.
  - A new handle (after a restart) whose view is behind `resume.rev` builds normally, is refused, catches up, and then meets the resumed branch at `resume.rev` — the intended order.
- **Tradeoff comment — verified.** The doc comment on `resumedAttempt` states the skipped base-pin re-judging as a deliberate departure and names storage's base guard as what catches a moved base; it reads as a decision, not an oversight. No `NOTE:` was needed beyond it.
- **Tests — none added, none cut.** The one regression test is the bug's reproduction at the lowest layer. A second, multi-collection test through `commitEntry` was considered and declined: it would exercise the same `stage()` branch, i.e. the same behaviour tested twice.
- **Hygiene — no change.** The `segment` local in `stage()` is unused on the resumed branch but used on the build branch; `committableHead` must run first either way, so the shape is right. `write-attempts.ts` grew by one function; file sizes unchanged in any meaningful way.
- **Docs — checked.** `docs/internals.md` and `docs/offline-sync.md` describe the new rule and cite resolvable anchors; the doc comments on `HeadCommitOptions.resume`, `HeadCommitHandle.stage`, `Collection.openHeadCommit` and `headCommitHandle` agree with the code. No other doc describes the resume path.
- **Tripwires / tickets — none.** Nothing conditional surfaced.
- **Validation run:** `yarn test` in db-core (1980 passing), targeted `--grep` for sealed segments / `commitEntry` / `OfflineQueue` (72 passing), `npx tsc --noEmit` in db-core, `eslint` on the four changed source files, and `yarn lint:docs` from the root (all resolve).
