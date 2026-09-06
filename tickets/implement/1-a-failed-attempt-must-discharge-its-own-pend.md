description: When a brief network fault interrupts a write, the cleanup message that should undo the half-finished write is sent once over the same broken connection, and its failure is never noticed or reported. The leftover "write in progress" marker then blocks every retry, so a fault that should have been ridden out fails the write for good.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/utility/batch-coordinator.ts (context — processBatches never rethrows), packages/db-core/src/transaction/coordinator.ts (cancel-phase caller), packages/db-p2p/src/testing/mesh-harness.ts (repro harness), packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts (sibling spec to model the new one on), docs/repository.md
difficulty: medium
repro: verified
----

# A failed attempt must discharge its own pending record

Supersedes `fix/a-reset-attempt-leaves-a-pend-the-retry-collides-with` (research complete). The
cause is traced, and both halves of the fix were prototyped and measured against a reproducing
spec before this ticket was written.

Sibling of `torn-commit-must-cancel-the-blocks-it-abandoned` (complete). That ticket made the
*sweep* arm of `NetworkTransactor.commit` cancel what it abandoned, and recorded as a deliberate
exclusion that "the tail's own failure path still leaves the cancel to its caller". The caller
turns out to already issue that cancel — `TransactorSource.transact` does, on both of its abort
paths. The defect is that **the cancel cannot tell whether it worked, and never tries again**.

## The traced cause

`NetworkTransactor.cancel` runs `processBatches` and returns. `processBatches` deliberately never
rethrows: it records each batch's outcome on `batch.request` and swallows the rejection
(`b.request?.result().catch(() => {})`). `pend` and `commit` therefore follow it with an
`everyBatch(...)` completeness check and synthesize an aggregate error from the batch statuses.
**`cancel` has no such check.** A cancel in which every peer's RPC failed returns normally, and
every caller reads "returned" as "discharged":

- `TransactorSource.transact`'s two abort sites — the `!commitResult.success` return and the
  `catch (e)` rethrow;
- `NetworkTransactor.cancelAbandonedSweepBlocks` (whose `try/catch` can therefore never fire);
- `TransactionCoordinator`'s cancel phase in `packages/db-core/src/transaction/coordinator.ts`.

A pending record's only removers are a client cancel, a divergence-shaped commit refusal, and a
forward write of the SAME action id (`docs/repository.md`, "a pending record's lifetime is bounded
by its writer"). An application-level retry loop opens a **new transaction**, so it mints a new
action id — none of the three. `ClusterMember.validatePendOperations` then votes reject on every
later pend touching the block, naming the abandoned action as the rival. The write collides with
its own predecessor, permanently.

A second, independent defect sits on the pend path: `NetworkTransactor.pend`'s failure branch
fires its cancel as an unawaited background microtask
(`void Promise.resolve().then(() => this.cancelBatch(...))`). `pend` therefore returns *before* the
cancel lands, and a caller that retries immediately meets its own still-standing record. That one
is self-healing, but it burns a whole attempt out of the caller's retry budget every time.

## Measured, on the in-process mesh (3 nodes, clusterSize 3, superMajority 0.67)

A scratch spec drove `TransactorSource.transact` over a `buildNetworkTransactor` whose `wrapRepo`
models a briefly-broken client transport. Four arms, all deterministic:

| arm | injection | before | after both fixes |
| --- | --- | --- | --- |
| A | commit + cancel reset for a 150 ms window | attempt 1 resets; attempts 2 and 3 rejected with `pending conflict: block(s) held by unresolved rival action(s) retry-2`; record stranded on all 3 members | attempt 2 lands |
| B | commit reset only, cancel transport clean | already passes — attempt 2 lands. This is the proof that a cancel which actually *runs* is the whole repair | unchanged |
| C | pend reply lost on every peer (the work landed, the reply did not) | attempt 2 rejected by its own record; attempt 3 lands — one attempt wasted | attempt 2 lands |
| D | cancel reset on every peer, called directly | `NetworkTransactor.cancel` tried all 3 peers, every one failed, all 3 members still held the record, and it **returned with no error** | throws, naming the action |

Arm A is the reported chain. It differs from the upstream report in one detail worth stating: the
report shows `1/3 rejected` (one member holding the record) where this mesh strands it on all
three. That is a difference in where the fault fell, not a different mechanism — one holder is
enough to reject, because a 3-member cohort at 0.67 needs all three approvals.

## Fix specification

**Arm 1 — `NetworkTransactor.cancel` must know whether it discharged, and must outlast a transient
fault.** Mirror the check `pend` and `commit` already run, and wrap it in a time-based retry:

- After `processBatches`, test `everyBatch(batches, b => b.request?.isResponse === true)`. Failing
  that, at least one block's cancel reached nobody and its pending record still stands.
- Retry the whole round — fresh `batchesForPayload`, so a re-resolved coordinator is picked up —
  with backoff, until `abortOrCancelTimeoutMs` expires. `processBatches`' own retry is a *peer*
  retry (one alternate coordinator per block, no delay); a stream reset is *time*-shaped and needs
  a delay to clear. The prototype used `min(50 * 2 ** round, 500)` ms and cleared a 150 ms fault on
  its second round.
- On budget exhaustion, throw an aggregate built from `formatBatchStatuses` plus `firstBatchError`
  (the same shape `pend` builds) naming the action id and the blocks still held, so the failure is
  legible rather than silent.
- Retrying is safe: cancel is idempotent, and the three-timings safety argument already written out
  in `cancelAbandonedSweepBlocks`' doc comment covers a cancel that races a landing commit. Extra
  rounds cost latency only.
- **Bound the cost.** With a permanently-down transport and the harness default
  `abortOrCancelTimeoutMs` of 5000, the prototype issued 39 cancel RPCs across roughly 7 rounds and
  took 4.9 s before throwing. That is the honest price of a genuinely dead transport, but consider a
  maximum round count alongside the deadline so the RPC count stays proportionate.

**Arm 2 — `cancelBatch` gets the same treatment.** It is the pend path's cancel and has no
completeness check either. Prefer factoring the round-plus-check-plus-backoff into one private
helper that both `cancel` and `cancelBatch` call, rather than two copies of the loop.

**Arm 3 — `NetworkTransactor.pend`'s failure path must await its cancel.** Replace the
`void Promise.resolve().then(...)` with an awaited call inside a `try/catch` that logs (the catch
matters once Arm 2 makes it throwable). This is what removes the wasted attempt in Arm C. State the
tradeoff in the code: a losing pend now pays a cancel round-trip before it returns its
`StaleFailure`, where before it returned at once and cleaned up behind itself. That is the right
trade — the old shape spent one of the caller's retries instead.

**Arm 4 — the caller sites must keep their verdict.** In `TransactorSource.transact`, both cancels
become throwable, and neither may mask what it was cleaning up after:

- the `!commitResult.success` site: a confirmed conflict must still be RETURNED as the
  `StaleFailure` — `Collection.sync` and the multi-collection pend phase read it via
  `isConflictFailure` to decide to rebase. Catch and log; do not convert it into a throw.
- the `catch (e)` site: today a throwing cancel silently replaces `e`, the real transport cause.
  Keep `e` as the thrown error and attach the cancel failure to it, so the caller's log names both
  the fault and the fact that the pend was left undischarged.
- `TransactionCoordinator`'s cancel phase already catches; confirm its log line is loud enough to
  identify a stranded action, and leave its control flow alone.

**Residual — a tripwire, not a ticket.** A fault that outlasts `abortOrCancelTimeoutMs` still
strands the record; nothing node-side reclaims it. Put a `NOTE:` at the new retry loop pointing at
the backlog ticket `debt-unpromotable-pending-records-need-a-sweep`, which is the backstop for
exactly this residual and already carries an arm describing it.

## Test

New spec, `packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts`, modelled on
`packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts` — same mesh, same per-member
`memberState` helper read straight off `StorageRepo`, same "assert the invariant, not the
mechanism" style. Drive `TransactorSource.transact` rather than the raw transactor, so the
production caller and its cancel are inside the test.

The injector is the part worth copying verbatim — a client transport that is down for a bounded
window, per RPC kind:

```ts
let down = new Set<string>();
let downUntil = Number.POSITIVE_INFINITY;
const gate = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
	if (down.has(label) && Date.now() < downUntil) throw new Error('The stream has been reset');
	return run();
};
const transactor = buildNetworkTransactor(mesh, {
	wrapRepo: (inner: IRepo): IRepo => ({
		get: (g, o) => inner.get(g, o),
		pend: (r, o) => gate('pend', () => inner.pend(r, o)),
		cancel: (r, o) => gate('cancel', () => inner.cancel(r, o)),
		commit: (r, o) => gate('commit', () => inner.commit(r, o))
	})
});
```

Arm C needs a different injector: the pend must REACH the server and lose only its reply
(`await inner.pend(r, o).catch(() => undefined); throw new Error('The stream has been reset')`),
because the wedge requires the record to have been written.

Each arm's retry loop is the app-level shape — a **fresh action id per attempt**, which is what
makes the collision possible at all. A loop reusing one action id (the `Collection.syncInternal`
shape) is carved out by `validatePendOperations`' self-exclusion and never reproduces this. Say so
in the spec header so the next reader does not "simplify" the loop into passing vacuously.

## TODO

- [ ] Extract a private discharge helper in `NetworkTransactor`: build batches, `processBatches`,
      `everyBatch` completeness check, backoff, repeat until `abortOrCancelTimeoutMs`; throw a
      named aggregate on exhaustion.
- [ ] Route `cancel` through it.
- [ ] Route `cancelBatch` through it.
- [ ] Add the `NOTE:` tripwire at the loop pointing at `debt-unpromotable-pending-records-need-a-sweep`.
- [ ] Await `pend`'s failure-path cancel; keep the log on failure; note the latency tradeoff in a comment.
- [ ] Harden `TransactorSource.transact`'s two cancel sites so neither masks the verdict it is
      cleaning up after; keep the original error as the thrown one.
- [ ] Check `TransactionCoordinator`'s cancel-phase log names the stranded action.
- [ ] Write `packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts` with arms A–D above.
- [ ] Run `yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test`.
      The cancel/pend-adjacent specs — `torn-commit-cancels-abandoned-blocks`,
      `coordinator-repo-cancel-solo-cohort`, `cluster-abandonment-e2e`, `race-resolution`,
      `pend-validation`, `cluster-pend-staleness` — all passed against the prototype (35/35), so a
      failure there means the shipped shape diverged from it. Note that db-p2p resolves
      `@optimystic/db-core` through its `dist/`, so `yarn workspace @optimystic/db-core build` must
      run before db-p2p's specs see a db-core change.
- [ ] Update `docs/repository.md`'s pending-record-lifetime passage: the client cancel is now a
      retried, checked operation rather than a single best-effort shot.
