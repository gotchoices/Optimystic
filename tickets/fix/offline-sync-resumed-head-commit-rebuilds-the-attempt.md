description: When a queued change is sent again after an earlier attempt may have reached only part of the network, the collection rebuilds the attempt from scratch instead of re-sending the recorded one, so two different versions of the same change can exist on different machines under one identity.
architecture: docs/offline-sync.md#identity-across-attempts
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/write-attempts.ts, packages/db-core/test/collection-segments.spec.ts, docs/offline-sync.md, docs/internals.md
difficulty: hard
repro: static
----

Found reviewing `ticket(implement): offline-sync-head-commit-handle`, which added `HeadCommitOptions.resume`: the attempt a caller recorded through `recordAttempt` on an earlier cycle and hands back when it re-drives the entry under the same action id.

## What goes wrong

The rule in [docs/offline-sync.md §Identity across attempts](../../docs/offline-sync.md#identity-across-attempts) is that an entry in doubt "is re-sent only under the action id and revision of the attempt that may have landed", and the rule it rests on, "A write's log append is a fixed function of the write and the revision it is requesting" in [docs/internals.md §Consensus Execution](../../docs/internals.md#consensus-execution), is that two attempts of one action at one revision send byte-identical transforms, because storage identifies a saved block revision by `(action id, revision)` and accepts a retry of the same pair: a machine that landed the first attempt keeps what it has, a machine that missed it stores what the retry sent.

Within one cycle the collection meets that rule in two ways: the head tracker is reused across attempts at one revision (so the tree nodes the actions insert keep their ids) and `Collection.logAppendBlockIds` remembers the log data block an append minted at that revision. Both memories die with the cycle: `beginInFlightAction`'s disposer clears `mintedLogBlockIds`, and the head tracker lives in the handle closure (`Collection.headCommitHandle`). A later cycle under the same action id, opened with `resume`, meets three cases:

- The opening refresh finds the attempt's own log entry with blocks missing: finished from `resume` (`Collection.completeOwnEntry`). Correct.
- The refresh adopts a rival's entry at the attempt's revision: the next attempt is at a higher revision, which is a genuinely different write. Correct.
- The refresh finds nothing new. The earlier attempt's tail may still sit on a minority of its cohort, hidden from this refresh by a coordinator lagging its cohort (the shape the offline-sync design names as the reason in-doubt is sticky). The cycle then calls `stage()`, which builds a FRESH head tracker: the action handlers mint new ids for every tree node they insert, and the log append, with nothing remembered, mints a new log data block if the tail is full. The attempt is sent under the same `(action id, revision)` with different content. Wrong: on the machines that hold the first attempt the retry is "already done" and keeps the first content, the rest store the second, and the log (parent node, `nextId` on the old tail, `tailId` on the header) forks permanently, exactly the divergence `logAppendBlockIds` exists to close.

Seeding `mintedLogBlockIds` from `resume` is not enough: the tree node ids differ too, since they come from a rebuilt tracker. The in-line loop before the handle had the same gap for a re-drive under an old id; `resume` is what makes it closable.

## Expected behaviour

While `resume` is given and the revision the next attempt would request equals `resume.rev`, `stage()` answers the recorded attempt itself rather than building one: a `StagedAttempt` whose tracker is a `Tracker` over the handle's read cache seeded with a copy of `resume.transforms`, with `resume.rev`, `resume.tailId`, `resume.blockDigests` and `resume.baseRevs`. `fold` (`Collection.foldOwnCommit` takes the tracker's transforms), `refused` (retains it again) and the write-ahead hook (records the same attempt again; the record is idempotent by content) all work on it unchanged. Once a refresh moves the revision past `resume.rev`, the recorded attempt is proven lost at that revision and the ordinary rebuild applies. The same `stage()` serves the coordinator's lock-step driver (`offline-sync-coordinator-entry-commit`), so the rule needs one site.

Two things the verbatim re-send deliberately skips, to be stated at the site: the base-pin re-judging the head tracker gets before each attempt (`Collection.headTrackerFor`), since the recorded attempt IS the attempt that may have landed and storage's own base guard refuses it on any machine whose base moved, the same exception `Collection.completeOwnEntry`'s re-send already takes; and the invented-baseline question, which does not arise, since the recorded transforms already carry the baseline's inserts.

## Reproduction to build

A spec in `packages/db-core/test/collection-segments.spec.ts` beside the resume cases. A transactor double whose `commit` lands NOTHING but answers `commit-not-durable` (the attempt is in doubt, nothing is visible), driven with `maxAttempts: 1` and a `recordAttempt` hook, over a collection whose log tail is full (seed 32 entries, `EntriesPerBlock`) so the append mints a log block. Re-drive with `resume` under the same action id with the double switched off. Assert the transforms the second cycle sends (observable through the double's `pend` argument) deep-equal the recorded attempt's, log block id and tree node ids included. Today they differ.

## What confirms the static reading

`Collection.headCommitHandle`'s `stage` closure always calls `headTrackerFor(segment, head)` with `head` undefined on a new handle, and `buildAttempt` with `mintedLogBlockIds` cleared by the previous cycle's disposer. Nothing consults the retained `inFlightAttempt` outside `completeOwnEntry`.
