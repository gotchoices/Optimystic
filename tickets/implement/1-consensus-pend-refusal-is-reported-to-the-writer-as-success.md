description: When several machines write to the same collection at the same instant, the losing writer is told its write succeeded even though every machine in the group refused to store it, so the data silently vanishes. The write should be told it lost and retried, the way losing writers already are on the paths that work.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts:1493-1506 (applyConsensusOperation — the `pend` branch that logs `consensus-pend-diverged` and returns void, discarding storage's refusal)
  - packages/db-p2p/src/cluster/cluster-repo.ts:333 (wasTransactionExecuted — the boolean the coordinator mistakes for "the operation succeeded")
  - packages/db-p2p/src/repo/cluster-coordinator.ts:248-321 (executeClusterTransaction — returns `{ record, localExecuted }`; `localExecuted` is that boolean)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1362-1384 (CoordinatorRepo.pend — hardcodes `success: true` on `localExecuted`; contrast the `peerCount <= 1` path at 1351-1353, which returns storage's real result)
  - packages/db-p2p/src/cluster/cluster-repo.ts:1171-1232 (validatePendOperations — the promise-phase check; sees only committed `latest.rev`, never a concurrently-pending rival)
  - packages/db-p2p/src/cluster/cluster-repo.ts:840-858 (getTransactionPhase — the commit-signing branch whose NOTE predicted this exact lost update and named the cure)
  - packages/db-p2p/src/cluster/cluster-repo.ts:1796-1851 (findConflict — the reservation table that is cleared at pend-consensus, before commit-consensus)
  - packages/db-p2p/src/storage/storage-repo.ts:455-568 (StorageRepo.pend — the layer that DID detect the conflict, via listPendingTransactions at :490)
  - packages/db-core/src/transactor/transactor-source.ts:146 (the pend that asks for policy 'r' — "refuse and return the conflicting pendings")
  - packages/db-core/src/transactor/network-transactor.ts:587-620 (pendPhase — already turns any `success:false` into a cancel + retryable conflict)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (the failing reproducer, "should handle concurrent writes from multiple nodes")
  - packages/db-p2p/src/testing/mesh-harness.ts:492-520 (buildNetworkTransactor / buildNetworkTransactors — for the cheap mesh-tier regression test)
  - packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts (the sibling spec for the COMMIT arm of this seam; the pend arm has no equivalent)
  - docs/correctness.md (Theorem 9 / quorum intersection — the safety argument this defect does not violate but does out-scope)
difficulty: hard
----

# A pend that every machine refused is reported to the writer as a success

## What is wrong, in plain terms

Three machines each open the same diary by name and immediately append one entry. All three
appends return success. Afterwards the entries never converge: one machine's entry is simply not
there, on any machine, and never will be.

The lost write was not dropped by accident. **Every machine in the group explicitly refused to
store it, and the refusal was then thrown away** before the answer got back to the writer.

## Reproduced at HEAD

```
cd packages/reference-peer
DEBUG='optimystic:db-core:collection,optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-core:network-transactor,optimystic:db-p2p:coordinator*' \
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
  --reporter spec --timeout 60000 --grep "concurrent writes"
```

Fails on `3579f3d5` (a full `yarn build` first — `packages/db-p2p/dist` was stale against `src`).
Test console:

```
   ✅ Node 1 write succeeded
   ✅ Node 2 write succeeded
   ✅ Node 3 write succeeded
Verifying all writes succeeded...
Error: waitForValue timed out after 30000ms: Node 1 should converge on all successful concurrent writes
```

Three acknowledged writes, two entries. (The captured trace is
`tickets/.logs/1-bug-concurrent-create.repro.log`; the runner prunes that directory after 14 days,
so every line this ticket depends on is quoted below.)

## The exact causal chain

Three writers, one collection id, blocks = the header block `concurrent-test-…` plus a log-tail
block. Writer 1 = `hptDg…`, writer 2 = `5-d1Ow…`, writer 3 = `_6RJMp…`. Times are `52.xxx` seconds.

**Writer 1 wins cleanly.** Its pend record reaches consensus at `52.265` and is immediately removed
from every member's reservation table:

```
52.265 cluster-member:phase-propagating { messageHash: 'zBHTw…' }
52.265 cluster-member:state-clear       { messageHash: 'zBHTw…' }
52.265 cluster-member:clear-done        { messageHash: 'zBHTw…', remaining: [] }
```

Its pending record is then written to storage — `52.289` on the first member, `52.374` / `52.376`
on the other two. Its **commit** does not reach storage until `52.530`.

**Writer 2 arrives inside that window and is approved by the cohort.** At `52.322` its record
reaches a member, `findConflict` finds an empty reservation table, and `validatePendOperations`
reads the block's committed revision — which is still absent, because writer 1 has not committed
yet — so the staleness branch (`latestRev !== undefined && latestRev >= pendRequest.rev`) does not
fire. The member approves:

```
52.322 cluster-member:phase { messageHash: 'zFUdz7…', phase: 1, promises: [], commits: [] }
52.329 cluster-member:action-promise-complete { messageHash: 'zFUdz7…', promises: [ '12D3KooWM9ZR…' ] }
```

**Every member then refuses it at storage — and the refusal is discarded.** On consensus-apply,
`StorageRepo.pend` runs its `listPendingTransactions` scan, finds writer 1's pending record on the
same blocks, and (policy `'r'`, as `TransactorSource` always sends) returns
`{ success: false, conflict: true, pending: [...] }` **without ever saving writer 2's transform**.
All three members log the swallow:

```
52.501 cluster-member:consensus-pend-diverged { messageHash: 'zFUdz7…', actionId: '5-d1Ow…', hasMissing: false, hasPending: true }
52.516 cluster-member:consensus-pend-diverged { … same … }
52.530 cluster-member:consensus-pend-diverged { … same … }
```

**The coordinator reports success anyway:**

```
52.537 coordinator-repo:pend-cluster-complete { actionId: '5-d1Ow…', localExecuted: true }
52.537 network-transactor pend:done actionId=5-d1Ow… ms=246
52.537 network-transactor commit  actionId=5-d1Ow… rev=1 blockIds=2
```

**The commit then lands nothing, and still returns success.** The log-tail block has no pending
record to promote, and the header block has already moved to revision 1 under writer 1:

```
52.667 storage-repo commit actionId=5-d1Ow… rev=1 → 'Pending action 5-d1Ow… not found for block(s): K9cbw…'   (×3 members)
52.916 storage-repo commit actionId=5-d1Ow… rev=1 → commit:stale missed=1                                      (×3 members)
52.928 network-transactor commit:done actionId=5-d1Ow… ms=391
```

`Diary.append` resolves. The entry does not exist anywhere.

**Writer 3 is the control, and it works.** It arrived while writer 2's *cluster record* was still
reserved, so it was refused with a real answer, and the existing retry machinery did the right
thing end to end:

```
52.423 coordinator-repo:pend-error { actionId: '_6RJMp…', error: 'Conflict race lost: 2/3 member(s) hold a conflicting winner (1/2 approvals)' }
52.424 network-transactor pend:cancel actionId=_6RJMp…
52.424 network-transactor pend:stale  actionId=_6RJMp… staleCount=1
…
52.977 network-transactor pend   actionId=_6RJMp… rev=2   ← refreshed and rebased
53.089 network-transactor commit:done actionId=_6RJMp…
```

That is exactly the outcome writer 2 must get.

## Root cause

Two defects at one seam — the admission of a `pend` through cluster consensus. They compose, and
the second is what converts a correctly-detected conflict into a silently lost write.

### Arm A — the block reservation does not span pend → commit

A write is two separate cluster transactions: one carrying the `pend` operation, one carrying the
`commit`. `ClusterMember` reserves a block only for as long as the *pend* record sits in
`activeTransactions`, and clears it the instant that record reaches consensus (`shouldPersist =
false`, `cluster-repo.ts:840-858`). But the thing a later writer is checked against —
`latest.rev`, read in `validatePendOperations` at `cluster-repo.ts:1201-1202` — only advances when
the separate *commit* record reaches consensus. Between the two, the block is held by nothing that
the promise phase can see.

The NOTE already sitting at `cluster-repo.ts:849-858` describes this window precisely and names the
cure — *"If a lost-update between commit-signing and consensus-apply ever shows up, hold the
reservation until `handleConsensus` instead of releasing it here."* **That tripwire has now
tripped**, and the trace above shows the cure as stated is not sufficient on its own: writer 2 was
approved at `52.322`, before writer 1's apply had even reached two of the three members, so a
reservation held only until `handleConsensus` would still have been released too early on the
member that applied first.

This arm is **not specific to creating a collection.** For a collection already at revision N, two
rivals both request N+1; `latestRev (N) >= N+1` is false for both, so both are approved by exactly
the same branch. Creation is merely where the window is widest, because the very first commit has
the furthest to travel.

### Arm B — the refusal is discarded, and the writer is told it won

`applyConsensusOperation`'s `pend` branch (`cluster-repo.ts:1493-1506`) calls
`this.storageRepo.pend(...)`, logs `consensus-pend-diverged` when it fails, and **returns `void`**.
The method's contract cannot carry a per-operation verdict, so `ClusterMember` retains only a
boolean — "did we run apply" (`wasTransactionExecuted`, `cluster-repo.ts:333`) —
`executeClusterTransaction` surfaces that boolean as `localExecuted`
(`cluster-coordinator.ts:319-320`), and `CoordinatorRepo.pend` reads it as "it succeeded":

```ts
// packages/db-p2p/src/repo/coordinator-repo.ts:1378-1384
// Local cluster already executed - return success
return {
	success: true,
	pending: [],
	blockIds: allBlockIds
};
```

The `peerCount <= 1` path twelve lines above returns `await this.storageRepo.pend(request, options)`
verbatim — the real result. So the single-node path is already correct, and the cluster path
fabricates a success the single-node path would never produce. That divergence is the defect.

The surrounding comment justifies tolerating an apply failure on the grounds that consensus is
authoritative cluster-wide and a local storage fault must not reset the stream. That reasoning is
sound for a *local* divergence (this member is behind; the block is unmaterializable here). It does
not hold for a **pending-conflict refusal**, which is neither local nor a fault: it is the
optimistic-concurrency verdict, it was reached identically by 3 of 3 members, and it means the pend
did not take anywhere.

## What the fix must do

**The invariant: a `pend` that no member stored must never return `success: true`.** Equivalently —
the answer a writer gets is the answer storage gave, on the cluster path exactly as on the
single-node path.

Arm B is the load-bearing half and satisfies the acceptance criteria on its own: once
`CoordinatorRepo.pend` returns the real `{ success: false, conflict: true, pending: [...] }`,
`NetworkTransactor.pendPhase` (`network-transactor.ts:587-620`) already cancels the partial pend and
reports a retryable conflict, and `Collection.syncInternal` already refreshes and rebases — the path
writer 3 demonstrably took. Nothing new has to be invented downstream.

Arm A should land with it. Without it the cohort keeps voting yes on writes it will refuse, so every
concurrent creator burns a full consensus round before losing, and the losing writer's partial
pending records have to be cancelled. With it, the loser is refused during the promise phase like
writer 3 was.

Prefer the boundary invariant over patching the diary path: every collection type is created this
way, and `Diary` is not involved in either arm.

### Shape suggested by the diagnosis (the implementer may find better)

- **Arm A** — give `validatePendOperations` the durable reservation that already exists.
  `StorageRepo` keeps a per-block pending-transaction record from pend-apply until commit or cancel;
  that record spans exactly the window `activeTransactions` does not, and survives restart. Reading
  it (the same `listPendingTransactions` scan `StorageRepo.pend:490` already does) and rejecting a
  pend whose blocks are held by a *different* unresolved action moves the check the storage layer
  already performs into the phase where the cohort votes on it. The verdict then aggregates across
  members exactly like the stale-revision verdict, and a member that has not yet applied the rival's
  pend simply abstains from that reason — which is correct, not a hole, because arm B still catches
  the residual.
- **Arm B** — make the swallowed verdict unrepresentable rather than merely logged. Have the apply
  path retain the local `PendResult` per `messageHash` and thread it out through
  `executeClusterTransaction`, so `CoordinatorRepo.pend` returns storage's own result instead of a
  literal. Keep the distinction the current code correctly draws for *commits*: a refusal carrying
  `pending` is an optimistic-concurrency loss and must reach the client as `conflict: true`; a
  refusal carrying `missing`, or a materialization fault, stays local divergence and stays tolerated.

Both arms edit `validatePendOperations` / its immediate neighbours. `fix/4-debt-pend-validation-is-
skipped-instead-of-failing-closed` edits the *other* half of the same method (the optional
custom-validator guard at `cluster-repo.ts:1218-1225`). Different root causes, so they stay separate
tickets — but whoever lands second should expect a textual conflict there.

## Constraints

- **Do not widen a timeout.** Convergence never happens; the budget is not the problem.
- **Keep the per-instance `Collection` latch key** (`collection.ts:132`). It is correct — the old
  process-global key serialized unrelated instances by accident and only ever masked this race
  inside a single-process test. Reverting it restores a green test and leaves the production defect
  in place while destroying the only reproduction.
- **The failing test stays as-is in shape and strength.** Do not skip it, do not weaken
  `expect(finalEntries.length).to.equal(successfulWrites)`, and do not seed the diary with a
  throwaway entry before the concurrent phase — a seed inflates the count so the `>= successfulWrites`
  poll passes while a node's own entry is still missing. That is a masked failure.
- **Acknowledged means durable.** A write that returns success must be present in the lineage every
  reader converges on, or it must fail loudly. Serializing the writers, or dropping a loser's write
  while still reporting success, is not a fix.
- **`Collection.advanceContext`'s no-lower guard stays** (`collection.ts:236-253`). It is a seal, not
  a cause; relaxing it trades this bug for stale-read rewinds.
- **What to do once two lineages already exist stays parked** in
  `backlog/more-design/6.5-partition-healing`'s "Forked (conflict)" arm. This ticket is about not
  producing the second lineage.

## Cross-cutting obligations

- **Wire format: unchanged, and it should stay that way.** `PendRequest` / `PendResult`
  (`db-core/src/network/struct.ts`) need no new field for either arm — arm A is a local storage read,
  arm B is an in-process return value inside `db-p2p`. If the implementation finds it cannot avoid a
  wire change, flag it: `PendRequest` is shared by every transport.
- **Signed reject reasons are prose-only.** `validatePendOperations`' reason string is fed to
  `computeSigningPayload` and carried as `Signature.rejectReason`. A new arm-A reason must stay
  plain prose, exactly like the existing `stale revision: …` one; do not add structured fields.
- **Storage format: unchanged.** No new durable record — arm A reuses the pending-transaction record
  that already exists, so the raw-storage conformance suite
  (`db-p2p/src/testing/raw-storage-conformance.ts`) needs no new pin.
- **No determinism-edition bump, byte-format vector, or migration** is anticipated.

## Corrections to the prior write-up of this bug

Recorded so the next reader does not chase a shape that this run did not produce:

- **This run produced a lost acknowledged write, not two lineages.** `collection:lineage-divergence`
  did **not** fire; writer 2's pend was refused everywhere and its transform was never stored, so
  there was no second lineage to diverge onto. The earlier trace in the fix ticket showed two
  actions committing revision 1 plus a divergence line. Both symptoms come out of the same window —
  which one appears depends on where in it the rival lands (if the rival's pend *is* stored on some
  members, both can commit revision 1 on disjoint subsets). Treat the fork as a second symptom of
  the same cause, not as an independently confirmed fact.
- **The link to the reported index fork is plausible but not proven here.** Index sub-collections are
  created on demand, so two nodes writing one index key concurrently do enter this same window,
  which fits the observation that the fork was only ever seen on the index sub-collection and never
  on the main table. But this run produced the lost-write symptom, not the fork symptom, so the
  link is not established. **What would confirm it:** re-run the downstream index reproducer with
  the fix applied, or capture a run of this test in which two actions do both reach
  `storage-repo commit … rev=1` on disjoint member subsets. Say which happened, either way.
- **The `NOTE:` in `Collection.advanceContext` about divergence never having been reproduced remains
  accurate for this run.** Do not edit it on the strength of this ticket alone; edit it if and when
  the fork symptom is captured.
- **The board notes about work in flight are stale.** `2-coordinator-commit-latch-and-rev-threading`
  and `2.2-coordinator-interleaving-spec` have both completed; `implement/` and `review/` were empty
  when this was written. Nothing is racing this ticket.

## Named but explicitly out of scope

`Diary` / `Collection` cannot commit a header without also appending an entry — `createOrOpen`'s
`collection:invented` branch (`collection.ts:154-169`) only *stages* one. That is why the test's
stated intent ("create on Node 1 first, then have other nodes open it") is unachievable and why all
three machines walk into the create window every run. It is a real ergonomic gap and worth naming,
but it is **not** part of this fix: the race is reachable by any two writers on any existing
collection (arm A above), so closing the API gap would hide this reproducer without fixing anything.
Leave the test's premise unmet and fix the race.

## TODO

- Reproduce first and keep the trace: run the `--grep "concurrent writes"` command above after a
  full `yarn build`, and confirm you see `consensus-pend-diverged` with `hasPending: true` from all
  three members followed by `pend-cluster-complete { localExecuted: true }`. If you do not see that
  pairing, stop and re-diagnose before changing anything.
- Arm B: retain the local apply outcome for a `pend` operation instead of discarding it at
  `cluster-repo.ts:1493-1506`, and thread it out through `wasTransactionExecuted` /
  `executeClusterTransaction` so `CoordinatorRepo.pend` can return it.
- Arm B: replace the hardcoded `success: true` at `coordinator-repo.ts:1378-1384` with the real
  local `PendResult`, preserving the existing split — `pending` ⇒ `conflict: true` to the client;
  `missing` or a materialization fault ⇒ tolerated local divergence, as today for commits.
- Arm B: check the equivalent `localExecuted` uses for `cancel` (`coordinator-repo.ts:1500`) and
  `commit` (`coordinator-repo.ts:1532`) for the same fabricated-success shape, and say in the
  handoff whether they have it. Fix them if they do; if they do not, say why not.
- Arm A: teach `validatePendOperations` to reject a pend whose blocks are held by a different
  unresolved pending action, using the pending-transaction records `StorageRepo` already keeps. Keep
  the reject reason plain prose.
- Update the now-tripped NOTE at `cluster-repo.ts:849-858` to record that the predicted lost update
  was observed, what was done about it, and what residual (if any) remains.
- Add a mesh-tier regression test in `packages/db-p2p/test/` using
  `buildNetworkTransactors` (`src/testing/mesh-harness.ts:514`): N nodes concurrently
  `Diary.createOrOpen(name)` then `append`, asserting that **every** fulfilled append is present
  after convergence and that any rejected one is a conflict. The reference-peer test stands up real
  libp2p sockets and takes ~34s; this should be seconds. Model it on
  `test/coordinator-repo-commit-divergence.spec.ts`, which covers the commit half of this seam.
- Verify the index-fork link (see *Corrections* above) and record the result either way in the
  review handoff.
- Run `packages/reference-peer` `yarn test` and confirm "should handle concurrent writes from
  multiple nodes" passes with the per-instance latch key retained, then `yarn check` from root
  (lint + build + typecheck + test + test:integration).
- In the review handoff, state explicitly whether the general (non-creation) concurrent-write race
  is now closed or only narrowed, and on what evidence.
