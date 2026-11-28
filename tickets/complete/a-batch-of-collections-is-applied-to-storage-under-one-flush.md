description: A write that covers several collections at once now waits for the disk twice instead of twice per collection, so such writes should be several times faster on slow disks and phones. Reviewed; four failing tests found and fixed, and the duplicated two-path plumbing collapsed into one helper.
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/storage-repo.ts (`applyInOneGroup`, `applyAsOneGroup`, `LocalApplyGroup`, `ILocalApply`, `pendInGroup`, `commitInGroup`, `runPostFlush`, `endGroup`), packages/db-p2p/src/repo/coordinator-repo.ts (`applyPendsInOrder`, `applyCommitsInOrder`, `applyCommitsAfterConsensus`), packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusPends`, `applyConsensusPend`, `applyConsensusCommits`, `applyCommitToStorage`, `captureConsensusCommitCert`), packages/db-p2p/test/support/intercept-commits.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/floored-read-consults-a-lagging-coordinator.spec.ts, packages/db-p2p/test/superseded-own-write-is-saved.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts, packages/db-p2p/docs/storage.md, docs/internals.md
----

# A batch of collections is applied to storage under one flush

## What shipped

A machine applying one consensus record now flushes its store **once for the record's pends and once for its commits**, however many collections the record covers — two flushes instead of two per collection.

`StorageRepo.applyInOneGroup(apply, body)` runs `body` as one write group. Each `group.pend` / `group.commit` the body makes takes and releases that request's own block latches exactly as a lone apply does; when the body settles the group flushes once, with the caller's sync window, and then every request's post-flush steps run in request order — a pend's group note and HLC `stored` mark, a commit's collection change events. `StorageRepo.pend` and `commit` are groups of one through the same method, so a lone apply and a batched one share one implementation.

The five apply loops that walk a record's operations run inside it: `CoordinatorRepo.applyPendsInOrder`, `applyCommitsInOrder` (the solo commit), `applyCommitsAfterConsensus` (the fallback after consensus ran without this node's member), and `ClusterMember.applyConsensusPends` / `applyConsensusCommits`. No loop's control flow changed — the coordinator still stops at the first refusal, the member still applies every operation and handles each one's divergence, behind-reconcile and durable verdict itself.

`ILocalApply.applyInOneGroup` is optional, because a plain `IRepo` test double cannot ignore a method it has to be called on, and many suites pass one. The absent case is written **once**, in the free function `applyAsOneGroup`: a storage without the group gets the same loop body against a handle that forwards each request to its `pend` / `commit` on its own. No caller probes for itself.

Durability ordering is unchanged in substance: nothing a request reports as landed is acted on before the group's flush — change events, pend-group notes and the record's answer all follow it. What widened is the already-documented *visible before durable* span: a concurrent reader can see a not-yet-durable write for the length of the record's whole apply rather than one apply. That is recorded in `packages/db-p2p/docs/storage.md` §6.

## Review findings

### Found and fixed in this pass

**Four tests were failing at the implement commit, all from one root cause.** The batched apply reaches storage through `applyInOneGroup` → `commitInGroup`, **not** through the public `commit`, so a wrapper placed on `StorageRepo.commit` is walked straight past on the batched path. Three mesh specs inject faults that way and stopped reproducing them:

- `packages/db-p2p/test/floored-read-consults-a-lagging-coordinator.spec.ts` — "B missed A's commit" (the member applied it for real).
- `packages/db-p2p/test/superseded-own-write-is-saved.spec.ts` — two cases, "node A missed the writer's data-block commit" (same).

Fixed with a shared `packages/db-p2p/test/support/intercept-commits.ts`: one `interceptCommits(node, intercept)` that covers both seams, used by both specs. Each now reproduces its fault again. The implement handoff ran a selected subset of suites and did not see these.

**The same seam, plus a real semantic consequence, in `packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts`** (the GitHub #47 control case). Extending its index-lag gate to the group proved the scenario's table and index travel in **one** consensus record: gating the index's commit inside the group stalls the whole group. So for a one-record action the #47 race is now *structurally unreachable* — neither event fires until the single flush, by which time both collections have landed — and the control's premise ("without the hold, the table's event wakes before the index lands") is false no matter where the gate sits. The control was re-aimed to pin what is now true and is still a real guard: with the change hold disabled the wake still finds the row through the index, which fails the moment a record's collections go back to a flush and an emission each. Its own fallback drops from 10 s to 400 ms. The spec's doc comment records that the race is no longer reproducible there, that the hold still closes it where an action's collections travel as **separate** records (pinned at the storage tier in `action-change-hold.spec.ts` and `storage-repo.spec.ts`), and what it would take to reproduce it end to end again.

**The two-path plumbing was written five times.** Every call site carried its own `storage.applyInOneGroup === undefined` probe plus a `*EachInOrder` wrapper method whose only purpose was to share the loop between the two paths — and the two statements had already drifted cosmetically (the member spread `{ proof, ...apply }` on one path and passed `proof` separately on the other). Collapsed into `applyAsOneGroup`; the five wrapper methods are gone and their loops are back inside the methods that own them. Net 17 lines fewer across two files that are already 4k+ lines, and the group/no-group equivalence is now stated once.

**The "no storage read" claim was wrong.** Measured with a counting probe over `MemoryRawStorage`: a 3-collection batched commit does 1 flush and then 2 extra `getPendingTransaction` reads — the first emission's `closeAbandonedGroups` scan of the record's other pend groups, which finds none still pending and closes them all. Still *fewer* reads than the sequence it replaces (one read per remaining group at every emission, with every event held until the last collection landed), so the direction of the claim was right and its absoluteness was not. Corrected in `applyInOneGroup`'s doc, `docs/internals.md`, and the new test's comment.

**Two stale comments.** `captureConsensusCommitCert` asserted that `StorageRepo.commit` "emits the CollectionChangeEvent synchronously at the end of the call" — no longer the mechanism; rewritten so the ordering constraint it states is still true (the earliest an event can fire is the group's first post-flush step). `storage.md` said "four callers" over a list of five methods, and its "callers probe for it" sentence now describes the helper.

**One doc addition.** `storage.md` §6 now states the interception hazard plainly: a wrapper on `pend` / `commit` of a live `StorageRepo` is bypassed on the batched path and has to cover `applyInOneGroup` too, with both covering specs named — while a repo *decorator* is unaffected, since it carries no `applyInOneGroup` and so takes the fallback through its own methods.

### Checked, nothing wrong

- **`endGroup` losing its `flush` parameter.** Verified every remaining caller (`cancel`, `recoverBlock`, `saveReplicatedBlock`, `deleteBlockIfNotAdvanced`, a `get` that took a write latch) passed no window before, so the parameter was dead. The `wrote` gating in both arms is identical to the old code, checked against `d47f5dd1^`.
- **The member's pend-refusal retention moved to before the flush.** Inert, but not for the reason the handoff gave (a rejecting flush latching the store is about flush *failure*). It is inert because retiring a refusal early exposes exactly the documented *visible before durable* window: the pend **is** in the store when the refusal is retired, only its sync is outstanding, and a crash that loses the write loses the in-memory retention with it. No note added — §6 already records the widened span.
- **`durableCommitVerdict` read inside the group.** Stronger than the handoff claimed: `retainCommitVerdicts` runs after `applyAsOneGroup` returns, so the retained verdict does not exist until after the flush and nothing can read it earlier. The reasoning moved onto the call site.
- **A flush that rejects after the body returned** emits nothing and propagates, matching the lone-apply contract. On the coordinator's fallback arm this is an improvement: a mid-loop flush rejection used to be caught by that loop's `catch` and reported as divergence.
- **HLC `stored` deferral.** `PendHlcIntake.stored` is `clock.observe`, order-insensitive, and `receive`'s skew measurement reads wall time rather than clock state. The store-then-observe window already spanned the flush; it now also spans the record's remaining applies, and nothing reads the clock in between.
- **`runPostFlush`'s throw paths.** Every step is non-throwing in practice: listener dispatch is isolated and logged (`fireChangeListeners`), `closeAbandonedGroups` swallows its read faults, `notePendGroup` is in-memory. The normal-path rethrow is dead defensiveness that preserves the lone-commit contract; left as it is.
- **Nested flushes inside the group** — the behind-reconcile's `saveReplicatedBlock`, and `holdsCommittedRevision`'s fallback `get` on the rare path where it promotes — are strict flushes that merely hasten the group's earlier writes (rule 4). Covered by the existing `NOTE:` at `applyCommitToStorage`.
- **Latching.** No latch is held across requests; the group body is caller code running between holds, never inside one. No new lock ordering.
- **Production wiring.** `CoordinatorRepo` and `ClusterMember` are handed the concrete `StorageRepo` (`libp2p-node-base.ts`, `optimystic-node.ts`, `mesh-harness.ts` all type it so), and `served-repo-proxy.ts` is not on these paths. `StorageRepo` already declares `implements ILocalApply`, so the optional member cannot drift from the interface unnoticed.
- **The implementer's two tests both earn their keep** — one pins the flush count and the post-flush emission order (the ticket's whole claim), the other the fault arm's emission guarantee across a group. Neither restates the implementation. Nothing cut, and no test added: the one defect found was already caught by existing tests, which is the outcome to want.

### Tickets filed: none

Every finding resolved inline. Nothing here names a class-level invariant that a ticket would carry better than the code does, and the one latent trap — the interception seam — is now documented at the seam and covered by a shared helper that every spec needing it uses.

### Tripwires parked

- The spec-doc `NOTE:` in `two-node-index-wake-consistency.spec.ts` recording that #47's race is no longer reproducible there and what it would take to reproduce it again.
- The interception-hazard paragraph in `storage.md` §6 (architectural, no single code site).

### Not measured

The source ticket's wall-clock figure — about 2.1 s for a 35-collection party founding, two thirds of it in flushes — is Sereus's measurement and was **not** reproduced, here or at implement. Reproducing it needs a scenario this repo's suites do not build, and no agent-runnable timing of it exists. What is pinned is the flush count (2 per record rather than 2N, by test) and the read reduction above. Nobody has timed the improvement.

## Validation

```
# packages/db-p2p
yarn build                       # exit 0
yarn typecheck                   # exit 0
yarn test                        # 3973 passing, 104 pending, 0 failing
yarn test:integration            # 60 passing, 2 pending, 0 failing

# packages/quereus-plugin-optimystic (dependent on db-p2p)
yarn build; yarn typecheck       # exit 0
yarn test                        # 1465 passing, 16 pending, 0 failing

# repo root
yarn lint                        # exit 0
yarn lint:docs                   # 49 documents, all citations resolve
```

`yarn lint:deps` not run: no manifest changed, and the one import added (`applyAsOneGroup`) is from a module both files already import. `yarn check:rn` not run: no import was added in code that ships to React Native.
