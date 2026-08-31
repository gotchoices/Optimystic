description: When several machines race to make the first write to a shared list, each one can commit half of its own work and then lose the race on the other half — and afterwards it can never finish, because it mistakes its own half-finished write for a competitor's and refuses itself forever.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts:1240-1285 (ClusterMember.validatePendOperations — the stale-revision vote; add the own-action carve-out its sibling checks already have)
  - packages/db-p2p/src/storage/storage-repo.ts:505-548 (StorageRepo.pend — the same bare `latest.rev >= request.rev` rule at consensus-apply; this is the site that actually refuses, the vote above only mirrors it)
  - packages/db-p2p/src/storage/storage-repo.ts:659-700 (StorageRepo.commit — the `alreadyDone` partition; the already-correct commit-tier sibling to copy)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1458-1500 (CoordinatorRepo.classifyStaleRejection — mirror; and confirmCommitRivalAgainstLocal at 1745+ is the shape to follow)
  - packages/db-core/src/collection/collection.ts:483-505 (Collection.updateInternal — the entry loop that replays pending actions the committed log already shows landed under this sync's own actionId)
  - packages/db-core/src/collection/collection.ts:786-800 (Collection.syncInternal — where the in-flight actionId is minted, once per sync, reused by every retry)
  - packages/db-core/src/transactor/network-transactor.ts:682-740 (NetworkTransactor.commit — header/tail/sweep ordering; DO NOT reorder, see "Rejected direction" below. One dead filter clause to delete.)
  - packages/db-p2p/test/cluster-commit-staleness.spec.ts (the harness to copy for the new pend-tier vote spec)
  - packages/db-p2p/test/storage-repo.spec.ts (where the StorageRepo.pend arm belongs)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (mesh-tier spec that asserts no duplicates; extend for the tail-committed-then-later-block-conflict shape)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 ("should handle concurrent writes from multiple nodes" — the intermittent end-to-end reproducer; do not weaken it)
difficulty: hard
repro: verified
----

# A torn action must recognize its own durable work

## The one rule that is missing

A write transaction touches several blocks. Its blocks are pended, then committed, one
group at a time — so a transaction can end up with SOME of its blocks durably committed
and the rest refused. Call that a **torn action**.

Every commit-tier check in the system already asks the right question about a torn
action — *who holds the revision I want?* — and answers "me" differently from "a rival":

| site | at `latest.rev === request.rev` | asks who? |
|---|---|---|
| `StorageRepo.commit` (`alreadyDone` partition) | same action ⇒ idempotent no-op | yes |
| `ClusterMember.validateCommitRevisions` | same action ⇒ abstain/approve | yes |
| `CoordinatorRepo.confirmCommitRivalAgainstLocal` | same action ⇒ `'own-durable'`, never `conflict` | yes |
| **`StorageRepo.pend`** | **refuses — stale** | **no** |
| **`ClusterMember.validatePendOperations`** | **votes reject — stale** | **no** |
| **`CoordinatorRepo.classifyStaleRejection`** | **confirms it as a lost race** | **no** |

The pend tier never asks. It compares revision numbers only. So a torn action's retry —
which reuses the SAME actionId, because `Collection.syncInternal` mints the id once
outside its retry loop — is refused by its own already-committed half.

That is the whole root cause. Everything below follows from it.

## Reproduced (deterministic, vote tier)

A throwaway spec built on `cluster-commit-staleness.spec.ts`'s harness, driving one pend
record through a `ClusterMember` whose storage reports `latest = { rev: 1, actionId: A }`
and whose pend request is `{ actionId: A, rev: 1 }`:

```
own-action re-pend vote => {"type":"reject","rejectReason":"stale revision: block own-orphan-block at rev 1, requested rev 1"}
rival  re-pend vote     => {"type":"reject","rejectReason":"stale revision: block own-orphan-block at rev 1, requested rev 1"}
```

Byte-identical verdicts for "my own commit" and "a rival's commit" — and the reason string
matches the wedge trace from the reference-peer run recorded on the source ticket exactly.
That spec was deleted after the run; recreate it as the first task below.

## How that becomes a permanent wedge (verified end-to-end)

Three nodes append the first entry to a fresh diary. Each append touches two blocks: the
shared collection header (contested by all three) and a fresh private chain-node block
holding the entry (unique per writer).

1. All three pend both blocks at rev 1. All pends reach consensus — header contention is
   only discovered at commit.
2. `NetworkTransactor.commit` commits the TAIL (the fresh private block) before the sweep
   that carries the header. Each writer's private block becomes durable on all 3 members.
3. Each writer's header commit then loses the conflict race — and with three contenders
   the members' votes can split so that *every* contender is told it lost. Nobody wins;
   the header is never committed by anyone.
4. Each writer cancels and re-drives. Because nobody won, `update()` finds the collection
   unchanged, so the retry re-stages an identical transform: same private block id, same
   rev 1, same actionId.
5. The re-pend meets **this same action's own** rev-1 commit from step 2 and is refused as
   stale. Forever. Ten attempts, then `SyncRetryExhaustedError`, zero entries in the diary.

The wedge needs both ingredients — the all-lose round (so retries regenerate an identical
transform) and the torn commit (so the writer's own orphan poisons them). When a winner
exists, losers re-drive against the winner's advanced chain, their transform differs, and
the orphaned private block is harmless garbage.

## The second symptom, same root (static)

Same function, other order: when `NetworkTransactor.commit` commits the header and tail
and then a LATER block in the sweep comes back as a confirmed conflict, it returns a stale
failure (`network-transactor.ts:714-737`). Refusing is right — acknowledging a torn action
would be worse — but header and tail are already durable. The writer cancels, re-drives,
and `Collection.updateInternal` now sees the log advanced with **its own action's entry
already committed**. It does not check the actionId: `updateInternal` filters `this.pending`
only through `doFilterConflict` (default: keep everything), then `replayActions` re-stages
the lot. The action re-appends content its own committed tail already carries — a
**duplicate entry**. Same missing rule, different tier.

## Rejected direction: do not reorder the commit

The obvious alternative is "commit the contested blocks first, so losing leaves nothing
durable behind". Do not do this. Tail-first is a load-bearing protocol guarantee, not an
accident:

- `Collection.bootstrapContext` documents it in so many words —
  *"The tail is always committed first (commit protocol guarantee), so it's readable with
  context=undefined."* Context bootstrap is what makes pending non-tail blocks visible to a
  chain walk.
- Tail-last would let a committed header point at a tail that was never committed anywhere
  — a dangling pointer, strictly worse than the orphan block tail-first can leave.

There IS one real defect in that ordering code, and it is a small one: in
`NetworkTransactor.commit`, `remainingBlocks`'s second filter clause

```ts
!(request.headerId && bid === request.headerId && !request.blockIds.includes(request.headerId))
```

is dead — `bid` is drawn from `request.blockIds`, so `blockIds.includes(headerId)` is
necessarily true whenever `bid === headerId`, and the clause never excludes anything.
Delete it and say plainly in a comment that the header commits first only when it is NOT
in `blockIds`, and otherwise commits last in the sweep. Do not change the order itself.

## Design of the fix

**Only the `latest.rev === request.rev` case is carved out.** Do not extend the carve-out
to `latest.rev > request.rev`, and do not reach for `IRevisionActionReader` at the pend
tier. If history has moved past the requested revision, the follow-on commit takes
`StorageRepo.commit`'s `missedCommits` branch (whose idempotent arm requires
`latest.rev === request.rev`) and refuses anyway — approving such a pend would only defer
the refusal by one round trip. `latest.actionId` off the same `get` already answers the
`===` case; nothing new is needed.

**At `StorageRepo.pend`, an own-action-already-committed block is *satisfied*, not merely
non-stale.** Skip the stale branch for that block AND skip recording a pending transaction
for it. This matters: `StorageRepo.commit`'s `alreadyDone` arm `continue`s past
`internalCommit`, which is the only thing that promotes (and thereby removes) a pending
record — so a pending saved for an already-committed block would never be cleared, and
would sit there as a permanent durable reservation that the rival-pending checks refuse
every future writer against. That would be a strictly worse wedge than the one being
fixed. The block still belongs in the pend result's `blockIds` so `cancel` covers it
(`deletePendingTransaction` on an absent record is already a no-op).

**At `Collection.updateInternal`, an action that finds its own actionId in the committed
log must consume it, not replay it.** `getFrom` returns `ActionEntry`s carrying `actionId`,
and `addActions(pending, actionId, …)` wrote exactly the snapshot list under that id, so
the count matches. Thread the in-flight actionId from `syncInternal` into `updateInternal`
(an optional parameter — `update()`'s public no-arg shape must keep working) and drop the
matching prefix of `this.pending` when an entry's actionId equals it. This is what closes
the duplicate arm, and it closes it independently of commit ordering.

**At `CoordinatorRepo.classifyStaleRejection`, mirror the exclusion.** A block whose
requested revision is held by THIS action is not a confirmed loss and must not seed
`staleAt`; if no rival is confirmed across any block, the rejection stays a throw, exactly
as it does today when nothing is confirmed. Follow `confirmCommitRivalAgainstLocal`'s
shape. With the two sites above fixed this path should no longer be reachable for the
own-action shape — mirror it anyway so the three pend-tier sites agree on one rule.

## What must NOT change

- Acknowledged-means-durable. Nothing here may re-introduce acknowledging a torn action;
  the non-tail sweep must still return the stale failure it returns today.
- The rival case. Every carve-out is gated on `actionId` equality; a different action
  holding the revision must still be refused with the identical prose reason (these
  reasons are fed to `computeSigningPayload` and carried as `Signature.rejectReason` —
  changing the text changes signed bytes).
- The lagging-member tolerance (`latest.rev < request.rev`, or no latest at all → abstain).
- `packages/reference-peer/test/distributed-diary.spec.ts` keeps its current shape and
  strength — no widened timeouts, no raised retry counts.

## Notes for whoever picks this up

- `tickets/fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits a
  different arm of `validatePendOperations`. Expect a textual conflict for whoever lands
  second; the two are otherwise independent.
- `tickets/backlog/feat-sync-fail-fast-on-hopeless-revision` proposes giving up EARLIER on
  a repeated same-revision rejection. It is adjacent but opposite in direction: this ticket
  makes one class of those rejections stop happening. Do not implement that ticket here.
- An all-lose conflict round is still possible after this fix; it just costs one retry
  cycle per writer instead of wedging, because the aged retry priority
  (`clampPriority(consecutiveFailures)`) plus jittered backoff separates the contenders on
  the next round. That is a tripwire, not work: leave a `NOTE:` where the loss is
  classified rather than filing a ticket.

## TODO

Phase 1 — pin the defect

- Recreate the deterministic vote-tier repro as a permanent spec (new file, harness copied
  from `packages/db-p2p/test/cluster-commit-staleness.spec.ts`): a pend record at
  `{ actionId: A, rev: 1 }` against a member holding `latest = { rev: 1, actionId: A }`
  must APPROVE; the same shape with a rival's actionId must still REJECT with the current
  prose reason; a lagging member (`latest.rev < rev`) and a never-seen block must still
  approve.
- Add a `StorageRepo.pend` arm in `packages/db-p2p/test/storage-repo.spec.ts`: commit block
  B at rev 1 under action A, then pend B at rev 1 under action A — must succeed, must NOT
  be reported in `missing`, and must leave `listPendingTransactions(B)` EMPTY. The rival
  variant must still return `conflict: true` with `missing` populated.
- Confirm both specs fail against unmodified sources before changing anything.

Phase 2 — the pend-tier carve-out (db-p2p)

- `StorageRepo.pend`: when `latest.rev === request.rev && latest.actionId === request.actionId`,
  treat the block as satisfied — no stale entry, no `savePendingTransaction`, still listed
  in the result's `blockIds`. Comment it against `commit`'s `alreadyDone` partition and say
  why the pending must not be recorded (it would never be promoted, hence never cleared).
- `ClusterMember.validatePendOperations`: same carve-out on the stale-revision vote, worded
  to match the self-exclusion already documented on the pending-rival check directly below
  it. The reject prose for the rival case is unchanged.
- `CoordinatorRepo.classifyStaleRejection`: exclude own-action-held blocks from
  confirmation, following `confirmCommitRivalAgainstLocal`.

Phase 3 — the duplicate arm (db-core)

- Thread the in-flight actionId from `Collection.syncInternal` into `updateInternal`;
  `update()`'s public signature keeps working with no argument.
- In `updateInternal`'s entry loop, drop the pending actions a log entry shows already
  committed under that same actionId, instead of handing them to `doFilterConflict` and
  replaying them.
- Add a `db-core` collection spec: a sync whose action lands in the log but whose sync
  reports a stale failure must, on the next `updateInternal`, NOT re-stage that action.

Phase 4 — dead code and mesh coverage

- Delete the dead `remainingBlocks` filter clause in `NetworkTransactor.commit` and comment
  the actual header/tail/sweep order (including that the order is deliberate and why
  header-first was rejected). No behavioural change.
- Leave a `NOTE:` tripwire where an all-lose conflict round is classified, recording that
  every contender can be told it lost and that convergence then rests on aged priority plus
  jittered backoff.
- Extend `packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts` with the
  tail-committed-then-later-block-conflict shape it does not currently exercise, asserting
  no duplicate entry.

Phase 5 — validate

- `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/db-core test`.
- `yarn workspace @optimystic/reference-peer test` — the diary spec must pass; run it
  several times, and at least once with DEBUG logging on (that is what shifted the
  interleaving into the wedge), reporting honestly if it is still flaky for a different
  reason.
- `yarn build` then `yarn typecheck` from the root.
