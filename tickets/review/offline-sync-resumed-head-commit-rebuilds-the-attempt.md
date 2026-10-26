description: When a queued change is sent again after an earlier attempt may have reached only part of the network, the collection now re-sends the recorded attempt exactly as it was instead of rebuilding it, so one change can no longer exist in two different versions on different machines under one identity.
architecture: docs/offline-sync.md#identity-across-attempts
files: packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/struct.ts, packages/db-core/test/collection-segments.spec.ts, docs/offline-sync.md, docs/internals.md
difficulty: medium
repro: verified
----

## What changed

A head commit (the commit of a collection's oldest queued entry) can be opened with `resume`, the attempt an earlier cycle under the same action id recorded through the write-ahead hook. Before this change, `resume` only seeded the retained attempt, so the cycle's opening refresh could finish a torn attempt from it. When that refresh found nothing new, the cycle built a fresh attempt at the same revision, and the rebuild minted new ids for the log data block the append creates and for the tree nodes a leaf division inserts. Storage accepts a retry of one `(action id, revision)` as the same write, so machines holding the first attempt would keep it while the rest stored the second: a permanent fork.

Now the `stage` step of the handle `Collection.headCommitHandle` returns answers the recorded attempt itself while `Collection.getNextRev()` equals `resume.rev`:

- `resumedAttempt` in `packages/db-core/src/collection/write-attempts.ts`, beside `retainedAttempt` (its inverse): returns `undefined` unless the attempt is given and its revision equals the requested one; otherwise a `StagedAttempt` whose tracker is over the handle's read cache, seeded with `copyTransforms(attempt.transforms)`, with its own pins, carrying the recorded `rev`, `tailId`, `blockDigests` and `baseRevs` (absent → `{}`). Its doc comment states the three deliberate departures: keyed on `resume` rather than on the retained attempt (no base-pin re-judging, a moved base is left to storage's base guard, as `Collection.completeOwnEntry`'s re-send already does); no invented baseline (the recorded transforms carry those inserts); only equality switches it on (past it a rival was adopted and the write is rebuilt; below it is unreachable within one process, and after a restart the ordinary build runs).
- `Collection.openHeadCommit` passes `resume` into `headCommitHandle`; `stage()` still calls `committableHead` first, so a recorded refusal is still thrown ahead of the resumed attempt.
- The coordinator's per-entry commit (`EntryParticipants` in `packages/db-core/src/transaction/entry-commit.ts`) opens its handles with `EntryCommit.resume` through the same `openHeadCommit` and calls the same `stage()`, so it gets the rule with no change of its own.

Docs: the `docs/internals.md` bullet "The attempt runs on a head tracker, built once per revision", the `docs/offline-sync.md` §Identity across attempts paragraph on `resume` (now naming the three outcomes of the opening refresh), and the doc comments on `HeadCommitOptions.resume`, `HeadCommitHandle.stage`, `Collection.openHeadCommit` and `headCommitHandle`.

## Tests

- No new test. The regression test already in the tree, "a re-drive with resume at the revision the recorded attempt requested, after a refresh that found nothing new, re-sends the recorded attempt itself …" in `packages/db-core/test/collection-segments.spec.ts`, failed at HEAD and passes now. It asserts the second cycle's pend deep-equals the recorded transforms, that the hook sees the same attempt again, and that the head commits once.
- Ran: `yarn test --grep "Collection sealed segments"` (29 passing), `--grep "commitEntry"` (5), `--grep "OfflineQueue"` (13), the whole db-core `yarn test` (1980 passing), `npx tsc --noEmit`, and `yarn lint:docs` from the root (all resolve). Rebuilt db-core `dist` so dependent packages' freshness guard does not refuse.

## For the reviewer

- **Coordinator path not exercised by a test of this exact shape.** No spec in `packages/db-core/test/coordinator-entry-commit.spec.ts` re-drives `commitEntry` with `EntryCommit.resume` after a refresh that finds nothing new. It shares `stage()`, so the reasoning holds, but whether one multi-collection case is worth adding is a call for review (it would be the same behaviour, a second test of it).
- **Within one cycle, a refused resumed attempt at the same revision is answered again by the next `stage()`** — the same content, which `refused()` retains again; intended.
- **The resumed branch never re-judges base pins.** If a base under the recorded attempt moved without the revision moving, the recorded attempt goes out unchanged and storage's base guard refuses it on the machines whose base moved; the refusal then follows the ordinary refused path. That is the stated tradeoff, not an oversight; verify the comment reads that way.
- The `segment` local in `stage()` is unused on the resumed branch; `committableHead` is called there only for its refusal check.
