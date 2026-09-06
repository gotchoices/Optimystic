description: A brief network fault used to fail a write permanently, because the cleanup message that undoes a half-finished write was sent once over the same broken connection and its failure went unnoticed. Cleanup now checks that it actually worked and retries briefly, and reports failure loudly when it cannot.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transactor/transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts, docs/repository.md
difficulty: medium
----

# Review: a failed attempt must discharge its own pend

Implements `implement/1-a-failed-attempt-must-discharge-its-own-pend`. All four arms of the fix
landed, plus one extra latent gap found on the way (see *Beyond the ticket*).

## What changed

**`NetworkTransactor.dischargeCancel` (new private helper).** One loop that both public cancel
paths now go through. Per round: build batches, `processBatches`, then compute which blocks actually
got an ANSWER; narrow to the ones that did not; back off; repeat. Ends on discharge, on
`MAX_CANCEL_ROUNDS` (6), or on the `abortOrCancelTimeoutMs` deadline — whichever trips first — and
on exhaustion throws an aggregate naming the action id and the blocks whose records are still
standing, in the same shape `pend` builds (`formatBatchStatuses` + `firstBatchError`, `.cause` and
`.errors` populated). Backoff is the shared `jitteredBackoffMs` (baseMs 50, capMs 500) via
`abortableDelay`.

**`NetworkTransactor.cancel`** is now four lines that delegate to it.
**`NetworkTransactor.cancelBatch`** delegates too, seeding round 0 from the peers the failed pend
actually talked to.
**`NetworkTransactor.pend`'s failure path** awaits its cancel inside a try/catch instead of firing
it as `void Promise.resolve().then(...)`.
**`TransactorSource.transact`'s two cancel sites** each catch and log; the `!commitResult.success`
site still RETURNS the `StaleFailure`, and the `catch (e)` site still throws `e`, with the cancel
failure attached as `e.cancelError`. `TransactorSource` gained a `createLogger('transactor-source')`
logger for this.
**`TransactionCoordinator.cancelPhase`'s log line** now carries the action id and the block ids, so
a stranded pend can be identified from the log alone. Control flow untouched.
**`ITransactor.cancel`'s doc comment** now states the contract the fix relies on: returning means
discharged; an implementation that could not remove the records must throw.
**`docs/repository.md`** — the "a pending record's lifetime is bounded by its writer" section gained
two paragraphs on the checked/retried cancel, why time-shaped and peer-shaped faults need different
retries, and the caller rule that a cancel failure must not displace the verdict it is cleaning up
after.

## Two deliberate divergences from the implement ticket

1. **Completeness is measured per BLOCK, not per batch.** The ticket specified
   `everyBatch(batches, b => b.request?.isResponse === true)`. I used the union of answered batches'
   payloads instead (`dischargedBlocks`, module-scope in `network-transactor.ts`). It is the same
   test when nothing is outstanding, but it also tells the loop *which* blocks to re-cancel, so a
   partially successful round narrows instead of re-issuing everything. That is what keeps the RPC
   count proportionate — the prototype's 39 RPCs was measured without it.
2. **A round cap alongside the deadline** (the ticket said "consider"). `MAX_CANCEL_ROUNDS = 6`
   spans roughly 0.9–1.5 s of retrying. Recorded as a `NOTE: accepted tradeoff` on the constant with
   its revisit condition (faults longer than ~1.5 s but shorter than the abort budget stranding
   records in practice). **Worth a reviewer's opinion** — it is the one number here that is a
   judgment call rather than a derivation, and it means a 3-second fault now fails where a
   deadline-only loop would have ridden it out.

## Beyond the ticket: a latent gap the completeness check exposed

`cancelBatch` derives its peer mapping from each pend batch's ANCHOR block id (`b.blockId`). When
`consolidateCoordinators` collapses several blocks onto one coordinator, the anchor is one of them —
so the non-anchor blocks used to get **no cancel at all** on the pend failure path, silently. The
new outstanding-set check notices and the next round resolves them live. Documented on
`cancelBatch`. Not separately tested: the in-process meshes make every node responsible for every
block, so consolidation collapses to a single batch and the multi-batch case is structurally
unreachable there — the same limitation `cancelAbandonedSweepBlocks`' existing NOTE already records
for its `confirmed` filter. **A reviewer should decide whether this deserves its own ticket** for a
mesh with disjoint responsibility sets; it is the same missing test fixture in both places.

## Tripwire recorded

- `NOTE:` on `MAX_CANCEL_ROUNDS` — the accepted tradeoff above, with revisit condition.
- `NOTE:` inside `dischargeCancel`'s doc comment — a fault outlasting both bounds still strands the
  record and nothing node-side reclaims it; points at backlog
  `debt-unpromotable-pending-records-need-a-sweep`, which already carries an arm for exactly this.

## Testing, validation, usage

New spec: `packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts`. 3-node mesh,
`clusterSize` 3, `superMajorityThreshold` 0.67, driving `TransactorSource.transact` (the production
caller) through a client transport that can be taken down per RPC kind for a bounded window. Four
arms, all passing:

| arm | injection | asserts |
| --- | --- | --- |
| A | `commit` + `cancel` down for 150 ms | the write survives; no attempt is refused with a *pending conflict* naming a predecessor from its own retry loop; the winner is committed on all 3 members; no stranded records |
| B (control) | `commit` down only, cancel transport clean | still survives — this arm passed BEFORE the fix and proves the repair is "the cancel must actually run", not "retry harder" |
| C | first attempt's pend reaches the server, loses only its reply | attempt 2 lands (exactly 2 attempts) — a third attempt means the cancel was not awaited |
| D | `cancel` down permanently, `transactor.cancel` called directly | it THROWS, names the action and the block, the records really are still standing, and a later clean cancel discharges them |

**Discrimination was verified, not assumed** (this is the part worth re-checking if you touch the
loop):
- Neutering the fix (`MAX_CANCEL_ROUNDS = 1`, throw replaced by a log) reproduced the reported chain
  verbatim: `armA-2/3/4:refused(pending conflict: block(s) held by unresolved rival action(s)
  armA-1)`, and arm D returned `undefined` instead of throwing. Arms A and D failed; B and C passed.
- Reverting only the awaited cancel in `pend` produced
  `armC-2:refused(pending conflict … armC-1) | armC-3:committed` — the wasted attempt the ticket
  measured. Arm C failed.
- Both neuterings were reverted and the full suites re-run green afterwards.

Full runs (db-core built first, since db-p2p resolves `@optimystic/db-core` through its `dist/`):
- `yarn workspace @optimystic/db-core build` → clean
- `yarn workspace @optimystic/db-core test` → **1594 passing**
- `yarn workspace @optimystic/db-p2p test` → **2551 passing, 49 pending**
- `yarn workspaces foreach -A --topological-dev run build` → clean across all 11 packages

The cancel/pend-adjacent specs the ticket named (`torn-commit-cancels-abandoned-blocks`,
`coordinator-repo-cancel-solo-cohort`, `cluster-abandonment-e2e`, `race-resolution`,
`pend-validation`, `cluster-pend-staleness`) are inside those runs and pass. No pre-existing
failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps — treat the tests as a floor

- **Timing-shaped arms.** A, B and C turn on a 150 ms fault window against an in-process mesh. Arm B
  needs a 250 ms caller backoff between attempts (documented in the spec) because nothing on its
  failure path waits; A and C deliberately retry with zero delay, which is what makes them
  discriminating. On a heavily loaded machine these could in principle flake — they ran at 297 ms /
  273 ms / 60 ms locally, so the margins are wide, but the arms are wall-clock-dependent and a
  reviewer should say whether that is acceptable in this suite.
- **`MAX_CANCEL_ROUNDS` is unexercised as a bound in the passing arms.** Only arm D reaches it
  (1054 ms, which is the round cap tripping, not the deadline). Nothing tests the
  `abortOrCancelTimeoutMs` bound tripping first — that needs a mesh whose cancel RPCs hang rather
  than reject.
- **The consolidated-batch case is untested**, per *Beyond the ticket* above.
- **`e.cancelError`** (the attached cancel failure on `TransactorSource.transact`'s throw path) has
  no assertion anywhere. Nothing reads it today; it exists so a log names both faults. If a reviewer
  wants it load-bearing it needs both a consumer and a test.
- **No multi-block cancel test.** Every arm cancels a single block, so the per-block narrowing in
  `dischargeCancel` (the divergence in point 1 above) is exercised only in its degenerate
  one-element form.
- **`TransactionCoordinator.cancelPhase`** got a log-line change only, with no test. It is a log
  string; verified by reading, not by running.
