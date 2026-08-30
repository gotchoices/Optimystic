description: A collection can be refreshed by a reader at the same moment a transaction is committing it, and nothing stops the two from interleaving — the commit then records the write as having landed at a revision number that the storage layer gave to somebody else. That is the most likely explanation for the two machines that permanently disagree about what a shared index contains.
files:
  - packages/db-core/src/transaction/coordinator.ts (commitOnce / pendCollection / the two recordCommitted loops — the seam that takes no collection latch)
  - packages/db-core/src/collection/collection.ts (latchId and its four holders; recordCommitted; advanceContext — the divergence report)
  - packages/db-core/src/collection/action.ts (ActionContext / actionIdAt)
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts:383,444 (findByIndex / range scan — every index seek refreshes the index tree)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:2944-2952 (the concurrency audit whose "serializes behind the collection's own latch" premise this violates)
  - packages/db-core/test/coordinator.spec.ts, packages/db-core/test/transaction.spec.ts (where the new spec belongs)
  - docs/debugging.md:253-345 (the three collection diagnostic lines, documented)
difficulty: hard
repro: static
----

# The commit path mutates collections without holding their latch

## Where this came from

A downstream project (`sereus`) runs two machines that insert rows under one shared secondary-index
value and then read back through that index; each machine sees only its own row, permanently. Six
attempts to reproduce that in this repository all converged
(`tickets/blocked/secondary-index-repro-exhausted-upstream`), so a diagnostic was added instead:
`collection:lineage-divergence`, which fires when a collection's own record of "which action
produced revision N" disagrees with what storage says. On 2026-08-29 it fired, twice, on the index
collection only:

```
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=1 held=63cJ50MoBCietBFJBvxWeQ read=vPYEKDif1s1ItefiE-5DQw
collection:lineage-divergence id=default/FormationUsage/index/FormationUsageByToken rev=2 held=W0vdcSKMif20MB6UYylCjQ read=NEJ50gSY7mr9KGV5QUKQDw
collection:context-not-lowered id=default/FormationUsage/index/FormationUsageByToken held=4 read=3
```

Re-measured after `read-cache-dedupe-by-store-identity` landed: unchanged, with fresh action ids.
So the fork is not "two caches over one store".

Read plainly, those three lines say: this machine believes it produced revisions 1 and 2 of that
collection, storage says somebody else did, and the machine is now one revision ahead of storage
(4 against 3) so the guard that refuses to move a collection backwards keeps it there forever.

## The mechanism

`Collection` protects its own state with a per-collection latch (`Collection:<id>`, taken by
`act`, `update`, `sync` and one internal path — `collection.ts:287,316,630,753`).
`TransactionCoordinator` **never takes that latch**, yet its commit path reads and writes the same
state:

| step (`coordinator.ts`) | what it touches on the collection |
|---|---|
| `commitOnce` — build `collectionData` | reads `collection.tracker.transforms` and keeps the reference |
| `applyActionsToCollection` | `Log.open(collection.tracker, …)` then `log.addActions(…)` — mutates the tracker |
| `pendCollection` | `collection.getNextRev()` — reads the held revision, sends it as `PendRequest.rev` |
| …network round trips (pend, then commit)… | |
| success / partial-commit loops | `collection.recordCommitted(transaction.id)` — which **recomputes** `getNextRev()` |

Meanwhile any concurrent `collection.update()` — which *does* hold the latch, and therefore
believes it is safe — runs `advanceContext` (moves the held revision) and, when it sees a conflict,
`replayActions()` (`collection.ts:776`), which calls `this.tracker.reset()`.

Two independent bad outcomes follow, both from the same seam:

**A. A revision number that nobody assigned.** `pendCollection` pends at `getNextRev()`; the success
loop records at `getNextRev()` computed *again*, after the network round trips. If a refresh moved
the held revision in between, the collection appends `{actionId: <our transaction id>, rev: <held+1>}`
to its committed list for a revision the storage layer never gave us. From then on this copy names
its own action at a revision storage attributes to another writer — which is exactly what
`collection:lineage-divergence` prints — and its held revision runs ahead of storage, which is
exactly what `collection:context-not-lowered held=4 read=3` prints. Nothing corrects it, because
`advanceContext` is deliberately one-way.

**B. The pend can carry transforms that were rewritten under it.** The coordinator captured
`collection.tracker.transforms` before the round trips; `replayActions()` resets that tracker
mid-flight. The bytes pended and the bytes the collection thinks it staged can differ.

## Why the index collection and not the main table

Because the index tree is refreshed far more often, and by *readers*. Every index seek and every
index range scan calls `tree.update()` before scanning
(`index-manager.ts:383` and `:444`). The main table is refreshed by the writer's own path, on the
writer's own cadence. So the index is the collection where a reader-driven refresh is most likely
to fall inside a writer's in-flight commit — and it is the only collection that forked.

The module's own concurrency audit (`optimystic-module.ts:2944-2952`) states the assumption this
breaks: *"a live scan's `collection.update()` serializes behind the collection's own per-collection
latch"*. It does serialize against other `update`/`act`/`sync` calls. It does **not** serialize
against a coordinator commit, because the coordinator takes no latch at all. That sentence should
be corrected as part of this work.

## Status of the claim

The downstream divergence is measured. This explanation of it is **read from the code, not yet
observed** — no test drives the interleaving today. Part A below exists to settle that: if the new
spec reproduces a recorded revision that does not match the pended revision, the cause is named and
fixed; if it does not, the remaining suspect is two machines resolving different storage cohorts for
one brand-new collection at genesis, which is the family already tracked by
`backlog/more-design/6.5-partition-healing` (an arm recording this observation has been appended
there).

## Shape of the fix

Two rungs, both worth taking:

**Make the bad state unrepresentable.** `Collection.recordCommitted(actionId)` recomputes the
revision it is recording. It should instead be *given* the revision that was actually pended —
`recordCommitted(actionId, rev)` — with the coordinator threading the single value it sent in
`PendRequest.rev` through pend → commit → record. A collection then cannot append a revision
that no pend claimed. Where the passed revision does not equal `getNextRev()`, that is a real
interleaving and should throw rather than log: it means the two sides of this commit disagree about
what the collection is, and continuing manufactures the fork.

**Close the seam.** The coordinator should hold each participating collection's latch for the span
in which it reads and mutates that collection's tracker, context and pending queue — acquired in
sorted collection-id order across all participants to avoid deadlock, matching how
`storage-repo.ts` orders its block write latches. That also closes outcome B. Note that
`Collection.update()` is called *from inside* the coordinator's own stale-loss retry loop
(`coordinator.ts:201`), which must therefore run outside the held span, not inside it.

## The report has to say more before the next downstream run

`collection:lineage-divergence` currently cannot be acted on by the person reading it, for four
reasons — all in `Collection.advanceContext`:

- **It does not say which of its two call sites fired**, and the two mean opposite things. From
  `updateInternal` it compares this instance's copy against the stored log — a forked replica. From
  `attachToLog` it compares the tail block's recorded latest action against a walk of that tail's
  own chain — which indicts storage, not a replica. The class doc says so; the log line does not.
- **It reports only the current revision.** The earliest revision at which the two committed lists
  disagree is the fork point, and it is the single most useful number available. Both lists are
  short and the whole comparison is `debug`-gated, so scanning them costs nothing on a normal run.
- **`context-not-lowered` carries two revision numbers and no action ids**, so "a fork just got
  sealed" and "this node is simply behind" print identically. It should carry the held and read
  action ids at both revisions.
- **Nothing distinguishes two `Collection` instances for one id in one process**, so a merged log
  cannot be split by instance.

None of this changes behaviour. The behaviour question the class doc parks — whether a detected
divergence should also drop the read cache, or throw — stays parked: it belongs with
`backlog/more-design/6.5-partition-healing`, not here.

## TODO

### Part A — reproduce the interleaving

- Add a spec (`packages/db-core/test/coordinator-latch-interleaving.spec.ts`) that drives a
  `TransactionCoordinator.commit()` over a collection whose transactor blocks inside `pend`, runs
  `collection.update()` to completion while the pend is parked, then releases it. Assert that the
  revision recorded by `recordCommitted` equals the revision sent in `PendRequest.rev`, and that
  the collection's committed list never names the local transaction id at a revision storage
  attributed to another action.
- Add the sibling case for outcome B: `replayActions()` resetting the tracker while the coordinator
  holds the transforms it is about to pend. Assert the pended transforms match what the collection
  believes it staged.
- Record in the ticket handoff whether each case reproduces. A negative here is a real result — say
  so plainly rather than adjusting the test until it fails.

### Part B — thread the pended revision

- Change `Collection.recordCommitted(actionId: ActionId, rev: number): number` to take the revision
  rather than recompute it; throw when it does not equal `getNextRev()`, with a message naming the
  collection, both revisions and the action id.
- Thread the value through `TransactionCoordinator`: capture the `rev` used in `pendCollection`,
  carry it to both `recordCommitted` call sites (the success loop and the partial-commit loop).
- Update the inline revision bump in `Collection.syncInternal` so the two paths still mirror each
  other, and the doc comment on `recordCommitted` that says so.

### Part C — hold the collection latches across the commit span

- Acquire `Collection:<id>` for every participating collection in sorted id order at the top of
  `commitOnce`, release in a `finally`. Document the ordering rule at the acquisition site and say
  which existing latch discipline it mirrors.
- Keep the stale-loss retry loop's `collection.update()` (`coordinator.ts:201`) outside the held
  span — it takes the same latch and would otherwise deadlock. Verify that against whatever
  reentrancy `Latches` does or does not provide; if `Latches` is not reentrant, a test that commits
  and retries must be part of this ticket, not left to review.
- Correct the concurrency audit comment at `optimystic-module.ts:2944-2952`: state that the
  serialization claim now holds because the coordinator takes the same latch, rather than leaving
  the sentence asserting something that was untrue when written.

### Part D — make the divergence report answerable

- Give `advanceContext` a call-site discriminator (`'refresh' | 'attach'`) and print it as
  `site=`; the two callers already exist and the class doc already explains what each means.
- Report the EARLIEST divergent revision across the two committed lists, not only the current one:
  print `forkRev=`, `held=`, `read=`, plus `heldRev=`/`readRev=` for the two contexts' own revisions.
- Add the held and read action ids to `collection:context-not-lowered`.
- Add a short per-instance tag to `Collection` (same shape as
  `CollectionFactory.nodeTag()` in `quereus-plugin-optimystic`) and print it on all three lines.
- Update `docs/debugging.md` §"Did the refresh itself fail to close the gap?" (lines 253-345) for
  the new fields, including a worked reading of the three lines quoted at the top of this ticket.
- Extend `packages/db-core/test/collection.spec.ts` (the divergence tests around lines 1509-1670)
  to pin `site=` for both callers and the earliest-divergent-revision behaviour.

### Wrap-up

- `yarn build && yarn typecheck && yarn test` from root; the two-node sweep in
  `quereus-plugin-optimystic` is part of `yarn test` and must stay green.
- The review handoff must state plainly whether Part A reproduced anything. If it did not, the
  downstream fork is still unexplained and the handoff should say the next evidence has to come from
  a `sereus` run carrying the Part D fields.
