description: Give the tree three guard variants that accept a row another machine already changed the same way (already deleted, already equal to what we write) instead of refusing, and let the offline queue report whether a committed entry still changed anything.
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/action.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/segments.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/entry.ts, packages/db-core/src/offline/status.ts, packages/db-core/test/tree-guard.spec.ts, packages/db-core/test/offline-queue.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, docs/internals.md
difficulty: hard
----

Stage 10 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), the db-core half, implemented. The plugin half is `offline-sync-already-applied-writes-in-the-plugin` (stages the variants from SQL, passes `effect` through to the plugin's status, teaches the outlook the kinds, updates docs/offline-sync.md). The design is [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured); the implementation is described in [docs/internals.md §Conflict replay re-makes the uniqueness decision](../../docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards) (the variants paragraph) and under *The offline queue* (the hook paragraph).

## What was built

**Three guard kinds** beside the four in `TreeEntryGuard` (`TreeAlreadyAppliedGuard` in `packages/db-core/src/collections/tree/struct.ts`), each with the outcome its base kind lacks, the element skipped as already applied:

| Kind | Element | Writes when | Skips when | Refuses with |
|---|---|---|---|---|
| `absentOrEqual` | upsert | key absent | present entry equals the element's own `entry` | `TreeKeyTakenError` |
| `unchangedOrEqual` (`expected`) | upsert | present entry equals `expected` | present entry equals the element's own `entry` (checked second) | `TreeEntryChangedError` on absent or any other entry |
| `unchangedOrAbsent` (`expected`) | delete | present entry equals `expected` | key absent | `TreeEntryChangedError` on any other entry |

`TreeUpsertElement.guard` is now `TreeUpsertGuard` (every kind but `unchangedOrAbsent`) and `TreeDeleteElement.guard` is `TreeDeleteGuard` (`unchanged` or `unchangedOrAbsent`). The handler narrows both at runtime: a delete with an upsert-only kind throws `TreeDeleteGuardKindError` (message now names both delete kinds), an upsert with `unchangedOrAbsent` throws the new `TreeUpsertGuardKindError`; both outside the `TreeGuardRefusedError` hierarchy. The `TreeUnchangedGuard` note that proposed `unchangedOrAbsent` now points at it.

**The tally.** `AlreadyAppliedTally` (`{ alreadyApplied, applied }`), `ZeroTally` and `addTallies` live in `packages/db-core/src/collection/action.ts`, not in the tree's struct as the ticket named, because the collection layer needs the runtime helpers and must not import the tree module; the tree imports them. The `replace` handler counts only elements carrying one of the three kinds. `CollectionInitOptions.modules` handlers return `AlreadyAppliedTally | void`; `Collection.stageInto` sums, treating `undefined` as zero (`Diary` is unchanged). `Collection.replayActions` and `Collection.buildHeadTracker` record the sum on `SealedSegment.applied` (set directly, no version bump); a staging that refuses leaves the previous value, which nothing reads.

**The hook.** `HeadCommitOptions.onCommittedHead` and `OpenHeadCommitOptions.onCommittedHead`; `EntryCommit.onCommittedHead(collectionId, applied)`, threaded into each handle by `EntryParticipants.open` like `resume`. The collection stores the hook with the cycle's head entry (`headCommitEntry` became `headCommit: { entryId, onCommitted? }`) and calls it from `Collection.reportCommittedHead` at the two places a head segment is dropped as committed: the handle's `fold` and `Collection.consumeHead`. A missing tally logs `collection:committed-head-tally-missing` and answers zero; a throwing hook logs `collection:committed-head-callback-threw`.

**The queue.** `Entry.applied: Map<CollectionId, AlreadyAppliedTally>`, set by the hooks the queue passes in `send` (one segment per collection is dropped once, so a set rather than a sum). `EntryStatus`'s `committed` arm has `effect: CommittedEffect` (`'applied' | 'already-applied'`, `packages/db-core/src/offline/status.ts`), computed by `effectOf` in `packages/db-core/src/offline/entry.ts`: `already-applied` exactly when the sums over every collection have `alreadyApplied > 0` and `applied === 0`. The journal hears the same status object.

**Plugin, type-only.** The plugin's `unchanged` helper now returns `TreeUnchangedGuard`, and `moveGuard` and `uniquePrefixGuard` are typed `TreeUpsertGuard`, because the element guards narrowed. No behaviour change; the plugin's own status types were unaffected.

## Things the reviewer should weigh

- **The ticket's `{2, 0}` scenario is unreachable as specified.** Two writes of one key in one entry (insert `absentOrEqual` of X, update `unchangedOrEqual` to Y) against a rival that did the same insert and update: the row is Y, and `absentOrEqual` compares against the element's own entry X, so the insert is refused with `TreeKeyTakenError`. The ticket expected both elements to skip. Pinned in `tree-guard.spec.ts` as a refusal with a comment, so the plugin ticket stages an insert-then-update of one key as one element (the final image under `absentOrEqual`) rather than meeting this in a failed drain. If the reviewer wants the ticket's reading instead, the kind would have to compare against the entry's final image of the key, which needs a within-action lookahead the table does not describe.
- **`effect` says what became of the guarded elements, not whether any row changed.** Per the ticket, elements with no guard or a base kind (`absent`, `unchanged`, `keepExisting`, `absentRange`) are not counted, so an index tree's segments never make an already-applied entry read `applied`. The cost: an SQL transaction with a plain `absent` insert beside an `unchangedOrEqual` update a rival already applied reports `already-applied` although the insert landed, which contradicts the ticket's own "a host reading `already-applied` as 'nothing of mine landed' must be right". A remedy that keeps index trees out: count `absent` and `unchanged` (the main-table kinds, which write by construction and never appear on index trees) as `applied`. Not done, because the ticket says explicitly not to; stated in the internals doc.
- **Tallies are in memory only.** A restart between a partial commit and the remainder's commit loses the committed half's tally, and the entry then reports `applied`, the conservative direction. Journaling the tally in the drive record is a one-field addition if the plugin ticket wants it exact.
- **Which staging's tally the fold reports.** The segment's tally is overwritten by every replay (`replayActions` runs on refresh, `dropSealed`, `restoreSealed`, `unstage` and `restorePending`'s replay arm) and by `buildHeadTracker`. The argument that the value at fold time is from a staging over the committed state the attempt committed over: a reader's refresh that adopts a rival makes the attempt stale, so its refusal rebuilds the head tracker and re-records; a refresh that walks into the in-flight entry defers. Worth a second read against `Collection.restageIfBasesMoved`, whose replay at an unchanged revision also re-records.
- **db-p2p's suite was not run.** Nothing in db-p2p changed; `packages/db-p2p/test/offline-queue-mesh.spec.ts` only reads the committed status, and a new required field on a type it reads cannot break it. The plugin suite was run because its source changed.

## Tests

`packages/db-core/test/tree-guard.spec.ts`, new `already-applied variants` block. Each accepting case stages, seals and commits the head segment through `Collection.commitHead` and reads the tally off `onCommittedHead`, since over a raw tree a skip and a write end in the same state; each refusing case syncs and reads the error.

- `absentOrEqual`: writes when absent (tally `{0, 1}`); skips when a rival committed an equal entry (`{1, 0}`); refuses a different entry with `TreeKeyTakenError`, not `TreeEntryChangedError`.
- `unchangedOrEqual`: writes when the entry equals `expected`; skips when it equals the element's own entry; a no-op update whose `expected` equals its entry writes and counts applied; refuses when the row was deleted (`actual` undefined); refuses any other entry.
- `unchangedOrAbsent`: deletes when the entry equals `expected`; skips when the key is absent; refuses when the row was changed.
- Two writes of one key: rival inserted the equal row → `{1, 1}`, final state the update's; rival inserted and updated → refused (see above).
- Malformed kinds: a delete carrying `absentOrEqual` (live) and `unchangedOrEqual` (JSON-replayed `[key, null, guard]`) throw `TreeDeleteGuardKindError`; an upsert carrying `unchangedOrAbsent` throws `TreeUpsertGuardKindError`; neither is a `TreeGuardRefusedError`; nothing stays staged. Type-level `@ts-expect-error` on both shapes.
- JSON round trip over all three kinds in one entry against a rival that made every change: `{3, 0}`.
- Class lattice extended with `TreeUpsertGuardKindError`; the existing delete-kind message assertion updated.

`packages/db-core/test/offline-queue.spec.ts`:

- First drain test asserts `effect: 'applied'` for plain writes.
- An entry over USERS and ITEMS (an `unchangedOrEqual` update and an `unchangedOrAbsent` delete) whose every element a rival had already applied reports `already-applied`; the journal's settled status is the same object; both logs hold the entry.
- The same entry with only the USERS rival reports `applied` (all, not any).
- The existing torn-first-drive test now carries an already-applied element beside its plain insert: the second drive's refresh consumes the head from the recorded attempt (no new attempt built) and the effect is `already-applied`, which pins the `consumeHead` hook site.

## Validation run

`yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-core test` (2016 passing), `yarn build && yarn typecheck` from the root, `yarn lint`, `yarn lint:docs` (all resolve), and `yarn workspace @optimystic/quereus-plugin-optimystic test` (1159 passing, 14 pending). Logs in `tickets/.logs/offline-sync-already-applied-guards-in-db-core.test.log` and `.plugin-test.log`.
