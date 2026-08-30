description: Fixed a bug where a database commit could record itself under the wrong revision number if another write snuck in at the same time; the fix holds a per-collection lock for the whole commit and threads the correct revision number through instead of recomputing it late. Reviewed, tested, and documented.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/test/collection.spec.ts
  - packages/db-core/test/coordinator.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
  - docs/internals.md
----

# Complete: coordinator commit-latch + revision threading

Lineage: `2-coordinator-mutates-collections-outside-their-latch` (design) →
`2-coordinator-commit-latch-and-rev-threading` (implement) →
`2-coordinator-commit-latch-validate-and-handoff` (validate) → this review pass.

## What shipped

Two related defects with one root cause: `TransactionCoordinator` read and wrote a
collection's revision state outside any lock on that collection, so a concurrent refresh
could make a commit record itself at a revision storage never assigned it.

**Instance-scoped latch held across the commit span.** `Collection` carries a public
`instanceTag` (four random bytes, base64url) generated before construction in `open` /
`createOrOpen`; its latch key is `Collection:${id}#${instanceTag}` rather than the old
process-global `Collection:${id}`. `Collection.acquireLatch()` exposes it.
`commitOnce` and `execute` acquire every participant's latch in ascending collection-id
order and hold it for the whole commit body, releasing in a `finally`. Instance scope
(not id scope) is required: `Latches` is non-reentrant, so a process-global key would
deadlock the coordinator's whole-span hold against a rival writer driving a second
`Collection` instance of the same id.

**Revision threaded, not recomputed.** `applyActionsToCollection` returns the revision it
stamped on the log entry; a `pendedRevs` map carries it through `coordinateTransaction`,
`pendPhase`, `commitPhase`, and both `recordCommitted` call sites.
`Collection.recordCommitted(actionId, rev)` now takes the revision explicitly and throws
if it disagrees with `getNextRev()` — the tripwire for any future path that bypasses the
latch.

## Review findings

### Verified sound (no change needed)

- **Lock ordering.** Both acquisition sites sort ascending by collection id over a set
  with no duplicate ids (`commitOnce` iterates the coordinator's `Map`, so ids are
  unique by construction; `execute` dedupes with a `Set` first). One consistent global
  order, so two commits over overlapping participants cannot invert. Confirmed by
  reading both sites, not by test.
- **No re-entrancy inside the held span.** The only latched `Collection` members are
  `act`, `update`, `sync`, `updateAndSync`. Every member the span touches
  (`snapshotPending`, `getPendingActions`, `recordCommitted`, `applyCommittedToCache`,
  `restorePending`, `clearPendingActions`, `tracker.reset`, `getNextRev`) is latch-free,
  and `applyActionsToCollection` works on the tracker directly. The retry loop's blanket
  `collection.update()` runs after release.
- **Release on every path.** `execute` has early `return`s inside the try; the `finally`
  covers them, as it does the throw paths in `commitOnce`.
- **Revision consumers are complete.** All four places that previously re-read
  `getNextRev()` (pend request, commit request, success fold, partial-commit fold) now
  take the threaded value. No remaining `getNextRev()` call downstream of the log append.
- **Construction sites.** Only two `new Collection(...)` calls exist, both in
  `Collection` itself, and both pass a tag — no path can construct an untagged instance
  that would silently share a key.

### Minor — fixed in this pass

- **The diff shipped no test for either behavior it introduced.** `coordinator.spec.ts`
  changed only to update call signatures; nothing asserted the revision-mismatch throw
  or the instance scoping of the latch key. Added four tests to
  `packages/db-core/test/collection.spec.ts` (`commit-span latch and pended-revision
  guard`): recording at the pended revision advances the context; recording at a stale
  revision throws and leaves the context untouched; two handles on one collection id get
  different tags and do not block each other's `acquireLatch()`; and a held commit-span
  latch does block `act()` on the same instance until release.
- **A claim the diff itself wrote was false.** The audit comment in
  `optimystic-module.ts` asserted "one connected table = one instance, so this is the
  same serialization as before". `OptimysticCollectionFactory.getCachedCollection` caches
  a collection only while a transaction is active, so outside a transaction every scan
  resolves its own fresh instance — strictly *less* serialization than the old global
  key gave. The safety conclusion still holds, but for a different reason: separate
  instances share no mutable collection state. Comment rewritten to say that.
- **`docs/internals.md` was stale.** It described `collection.update()` as serializing
  behind "db-core's per-collection latch"; that key is now per-instance, and the
  coordinator's commit-span hold was undocumented. Rewritten with the same in/out of
  transaction distinction as above. No other doc mentions the changed surface —
  `docs/debugging.md`'s two `recordCommitted` references remain accurate, and no doc
  describes coordinator internals at all.
- **Dead parameter field.** `commitOnceLatched` declared a `transforms` field on its
  `collectionData` parameter that its body never reads. Narrowed to the two fields it
  uses.

### Tripwires — recorded at the site, not filed as tickets

- `coordinator.ts` `commitOnce`: participant selection reads each tracker *before* the
  latches are acquired, so a stage landing in that window is silently left out of the
  commit. Harmless while a session stages and commits on one call path. `NOTE:` at the
  filter.
- `coordinator.ts` `commitOnce`: the span covers the pend/commit consensus round trips,
  so `act`/`update`/`sync` on a participant queue for as long as the transactor takes.
  `NOTE:` at the acquisition, naming the bounded-hold alternative if a stalled peer is
  ever seen wedging readers.
- `coordinator.ts` `rollback`: still resets and replays into participant trackers without
  their latches. Unreachable concurrently with a commit today because a session drives
  abort and commit from one call path. `NOTE:` at the method.

### Major findings

None. No defect was found that warranted a new ticket.

### Deliberately out of scope

A direct property test that a second commit on one collection instance blocks until the
first's `finally` releases is owned by the still-open sibling
`2.2-coordinator-interleaving-spec` in `tickets/implement/`. The new
`acquireLatch`-blocks-`act` test added here covers the latch mechanism but not the
coordinator's use of it end to end.

### Accepted tradeoffs encountered

None — no `NOTE: accepted tradeoff` marker sits at any site this review touched.

## Validation

- `yarn lint` (root, eslint): clean.
- `yarn build` and `yarn typecheck` (root, all workspaces): pass.
- `yarn test` (root, all workspaces, foreground): **1440 + 2334 + 683 + 72 + 58 + 53 +
  52 + 125 + 12 + 5 passing**. db-core is 1440, up from 1436 by the four tests added
  here. Zero `recordCommitted` revision-mismatch throws anywhere in the output.
- One failure, pre-existing and already tracked:
  `packages/reference-peer/test/distributed-diary.spec.ts` > "should handle concurrent
  writes from multiple nodes" times out. It is listed in `tickets/.pre-existing-known.md`
  against `bug-concurrent-create-commits-two-actions-at-one-revision`, which sits in
  `tickets/fix/`, so it was not re-reported. Worth noting for whoever picks that up: the
  implement-stage handoff diagnosed it as a mocha per-test timeout-budget mismatch, but
  the later triage pass identified a real revision-collision bug — take the triage
  diagnosis, not the handoff's.
