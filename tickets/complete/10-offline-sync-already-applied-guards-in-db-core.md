description: Give the tree three guard variants that accept a row another machine already changed the same way (already deleted, already equal to what we write) instead of refusing, and let the offline queue report whether a committed entry still changed anything.
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/action.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/segments.ts, packages/db-core/src/collection/head-commit.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/entry-commit.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/offline/entry.ts, packages/db-core/src/offline/status.ts, packages/db-core/test/tree-guard.spec.ts, packages/db-core/test/offline-queue.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, docs/internals.md, docs/debugging.md
difficulty: hard
----

Stage 10 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), the db-core half, implemented in `ticket(implement): offline-sync-already-applied-guards-in-db-core` and reviewed here. The plugin half is `offline-sync-already-applied-writes-in-the-plugin` (stages the variants from SQL, passes `effect` through to the plugin's status, teaches the outlook the kinds, updates docs/offline-sync.md). The design is [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured); the implementation is described in [docs/internals.md §Conflict replay re-makes the uniqueness decision](../../docs/internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards) (the variants paragraph) and under *The offline queue* (the hook paragraph).

## What was built

**Three guard kinds** beside the four in `TreeEntryGuard` (`TreeAlreadyAppliedGuard` in `packages/db-core/src/collections/tree/struct.ts`), each with the outcome its base kind lacks, the element skipped as already applied:

| Kind | Element | Writes when | Skips when | Refuses with |
|---|---|---|---|---|
| `absentOrEqual` | upsert | key absent | present entry equals the element's own `entry` | `TreeKeyTakenError` |
| `unchangedOrEqual` (`expected`) | upsert | present entry equals `expected` | present entry equals the element's own `entry` (checked second) | `TreeEntryChangedError` on absent or any other entry |
| `unchangedOrAbsent` (`expected`) | delete | present entry equals `expected` | key absent | `TreeEntryChangedError` on any other entry |

`TreeUpsertElement.guard` is `TreeUpsertGuard` (every kind but `unchangedOrAbsent`) and `TreeDeleteElement.guard` is `TreeDeleteGuard` (`unchanged` or `unchangedOrAbsent`). The handler narrows both at runtime: a delete with an upsert-only kind throws `TreeDeleteGuardKindError`, an upsert with `unchangedOrAbsent` throws `TreeUpsertGuardKindError`; both outside the `TreeGuardRefusedError` hierarchy.

**The tally.** `AlreadyAppliedTally` (`{ alreadyApplied, applied }`), `ZeroTally` and `addTallies` live in `packages/db-core/src/collection/action.ts`, since the collection layer needs the runtime helpers and must not import the tree module. The `replace` handler counts `alreadyApplied` for each variant element skipped, and `applied` for each element written under a variant kind or under `absent` or `unchanged` (the review widened the count to those two, see findings). `keepExisting`, `absentRange` and unguarded elements are not counted. `CollectionInitOptions.modules` handlers return `AlreadyAppliedTally | void`; `Collection.stageInto` sums; `Collection.replayActions` and `Collection.buildHeadTracker` record the sum on `SealedSegment.applied`.

**The hook.** `HeadCommitOptions.onCommittedHead` and `EntryCommit.onCommittedHead(collectionId, applied)`, threaded into each handle by `EntryParticipants.open`. The collection stores the hook with the cycle's head entry (`Collection.headCommit`) and calls it from `Collection.reportCommittedHead` at the two places a head segment is dropped as committed: the handle's `fold` and `Collection.consumeHead`. A missing tally logs `collection:committed-head-tally-missing` and answers zero; a throwing hook logs `collection:committed-head-callback-threw`.

**The queue.** `Entry.applied: Map<CollectionId, AlreadyAppliedTally>`, set by the hooks the queue passes in `send`. `EntryStatus`'s `committed` arm has `effect: CommittedEffect` (`'applied' | 'already-applied'`), computed by `effectOf` in `packages/db-core/src/offline/entry.ts`: `already-applied` exactly when every collection the entry wrote reported a tally and the sums have `alreadyApplied > 0` and `applied === 0`. The journal hears the same status object.

**Plugin, type-only.** The plugin's `unchanged` helper returns `TreeUnchangedGuard`; `moveGuard` and `uniquePrefixGuard` are typed `TreeUpsertGuard`. No behaviour change.

## Review findings

**What was checked.** The whole implement diff, read before the handoff: the three variant branches of `enforceUpsertGuard` and the new `enforceDeleteGuard` against the design table (including the `expected`-first ordering for `unchangedOrEqual` and absent-counts-as-changed for every upsert kind); `BTree.at` on a not-found path answering `undefined`; the tally's four paths (`replayActions`, `buildHeadTracker`, the handle's `fold`, `consumeHead`) and the implementer's "which staging's tally the fold reports" concern, traced through the latch-release window, the refresh deferral on the in-flight entry, and `restageIfBasesMoved`'s same-revision replay (the head is first in the replay list and stages over the same baseline and read cache as the head tracker, so a same-revision replay records the same tally; a moved base refuses the in-flight attempt at storage before any fold); the hook threading through `openHeadCommit`, `EntryParticipants.open` and `OfflineQueue.send`; `effectOf`; the type narrowing and the package exports; every consumer of the `committed` status in the plugin and db-p2p (type-only exposure); docs/internals.md, docs/offline-sync.md and docs/debugging.md against the code. Ran: db-core build and suite, root build, typecheck, lint, lint:docs, the db-p2p offline-queue mesh spec, and the plugin suite.

**Found and fixed inline (minor).**

- **A restart could make `effect` lie in the non-conservative direction.** `effectOf` summed only the tallies present on the entry. After a restart between a partial commit and the remainder's commit the committed half's tally is lost, so a remainder that was wholly already applied reported the entry `already-applied` although the committed half had changed rows; the same for a collection a restore found already committed. The handoff claimed this case reported `applied`. Reproduced by extending the "restore of a partly committed entry" case in `packages/db-core/test/offline-queue.spec.ts` (fails against the old function with `already-applied`, passes now); `effectOf` now answers `applied` whenever any collection the entry wrote has no tally. Doc comments on `Entry.applied` and `CommittedEffect`, and the internals paragraph, say so.
- **A plain insert beside an already-applied update read as `already-applied`.** The implementer flagged this as contradicting the ticket's own "a host reading `already-applied` as nothing of mine landed must be right" and left it per the ticket's "base kinds are not counted". Widened: a write under `absent` or `unchanged` now counts as `applied` (`countsWrite` in `packages/db-core/src/collections/tree/tree.ts`). Both are exact-key kinds that write whenever they do not refuse, and the SQL layer stages them on every main-table element and never on an index tree (checked: the only sites are the `unchanged` helper and two `absent` literals in `optimystic-module.ts`, all main collection), so the index-tree concern the ticket raised is untouched: `keepExisting`, `absentRange` and unguarded elements stay uncounted. Two tests in `tree-guard.spec.ts` pin which elements count (`{1, 1}` with an `absent` insert beside; `{1, 0}` with an unguarded and an `absentRange` upsert beside). Docs updated in `action.ts`, `status.ts`, internals.md; the plugin ticket's "same change plus a different one" bullet amended so it does not plan against the old rule.
- **debugging.md** did not list the two new `collection:` log lines; added to its namespace table.

**Tripwires (recorded, no ticket).**

- The ticket's `{2, 0}` two-elements-of-one-key scenario is unreachable as the kinds are specified; the implementer pinned it as a refusal with a comment in `tree-guard.spec.ts` that tells the plugin ticket to stage an insert-then-update of one key as one element. Left as is; that comment is the site.
- Tallies are in memory only. With the `effectOf` fix a restart can only make the effect read `applied`, never falsely `already-applied`. Journaling the tally in the drive record would make it exact; the plugin ticket may add it if the host wants that, and nothing here needs it.
- An unguarded element on a raw `Tree` (no SQL) beside a variant element still leaves the entry `already-applied`; the rule is stated at `countsWrite` and in `AlreadyAppliedTally`'s doc. The SQL layer guards every main-table element, so it does not meet this.

**Tests.** None cut: each of the implementer's cases pins a row of the specification table or a path the hook takes, and none restates the implementation or verifies a mock. Added the three cases above (one extension, two new).

**Tickets filed.** None. Both defects were fixed in this pass and their class is covered by the stated rule and its tests; nothing was found that serves a later-release anchor.

**Accepted tradeoffs met.** None at the sites touched.

**Not run.** The full db-p2p suite; nothing in db-p2p changed, and its one reader of the committed status (`offline-queue-mesh.spec.ts`) was run by name and passes. The pre-existing known-failures ledger was not consulted since no failure surfaced.

## Validation run

`yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-core test` (2018 passing), `yarn build && yarn typecheck`, `yarn lint`, `yarn lint:docs` (all resolve), `yarn workspace @optimystic/db-p2p test --grep offline` (3 passing), `yarn workspace @optimystic/quereus-plugin-optimystic test` (1159 passing, 14 pending). Logs in `tickets/.logs/offline-sync-already-applied-guards-in-db-core.review.test.log` and `.review.plugin-test.log`.
