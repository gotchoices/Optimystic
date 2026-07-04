description: When applying an already-agreed transaction hits a temporary error on one cluster member, that member permanently records the transaction as done and then silently skips it forever on retry, dropping it on that node. Fix by only recording "done" after the work actually succeeds.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/i-transaction-state-store.ts, packages/db-p2p/src/cluster/memory-transaction-state-store.ts, packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/test/cluster-repo.spec.ts
difficulty: medium
----

# Persistent "executed" marker is never rolled back on a transient apply fault

## Confirmed diagnosis

`handleConsensus` (`cluster/cluster-repo.ts:797-829`) marks a transaction executed
in two places, both **before** applying its operations:

- in-memory guard: `this.executedTransactions.set(messageHash, executedAt)` (line 813)
- durable marker: `this.stateStore?.markExecuted(...)`, fire-and-forget (line 814-815)

It then runs the apply loop (line 817-820). The catch block (line 821-828) rolls
back **only** the in-memory marker:

```ts
} catch (err) {
    this.executedTransactions.delete(record.messageHash);
    throw err;
}
```

The durable marker stays. The state-store interface
(`i-transaction-state-store.ts:39-42`) has `markExecuted` / `wasExecuted` /
`pruneExecuted` but **no `unmarkExecuted`**. On redelivery, `handleConsensus`
short-circuits at line 800 (`await this.wasTransactionExecutedAsync(...)` finds the
durable marker) and the operation is silently dropped on that member forever.

Two apply-failure paths reach the catch and hit this bug:
1. an unexpected thrown fault (transient storage I/O) — the `throw err` at line 931
   or any raw throw inside `applyConsensusOperation`;
2. a propagated genuine commit fault — the `throw new Error(...)` at line 948
   (`success:false` with a bare `reason`, no `missing`).

Both are exactly the cases the in-memory rollback was written to allow a corrected
retry for — but the durable marker defeats it.

## Latent sibling defect (same root cause) — fix it here too

The eager durable write is also wrong on a **process crash** mid-apply, not just a
caught exception: if the member dies between line 814 and completing the apply loop,
the durable marker is already persisted (fire-and-forget may or may not have landed,
but it is *intended* to). On restart, redelivery is skipped — same silent drop, with
no catch block involved at all. Any fix that only adds `unmarkExecuted` in the catch
leaves this crash window open.

## Chosen fix: persist the durable marker only *after* apply succeeds

Move `stateStore.markExecuted(...)` to **after** the apply loop completes without
throwing. This fixes both the caught-fault case and the crash case in one move, and
needs **no interface change**.

Rationale for why this is safe:

- The **in-memory** guard still set eagerly (before any `await`) — it is what
  provides the synchronous check-and-set that prevents the concurrent
  apply-window race (two `handleConsensus` calls for the same hash both passing the
  async check). Keep it exactly where it is (line 813). Its eager set + catch-block
  delete are unchanged.
- The **durable** marker exists only for *post-restart* dedup (the in-memory map is
  empty after restart — see the comment at line 798-799). Post-restart, a re-run of
  an already-applied consensus transaction is already **idempotent by design**: the
  "ahead" divergence path in `applyConsensusOperation` tolerates re-application as a
  no-op (`StorageRepo.commit` returns `success:false` with `missing`, logged as
  `divergence: 'ahead'`, line 933-946; re-`pend` is logged and tolerated,
  line 881-889). So the narrow window between "apply succeeded" and "durable write
  landed" is safe to re-run on restart — it converges rather than dropping.

Sketch:

```ts
this.executedTransactions.set(record.messageHash, executedAt); // eager, unchanged

try {
    for (const operation of record.message.operations) {
        await this.applyConsensusOperation(record, operation);
    }
} catch (err) {
    this.executedTransactions.delete(record.messageHash);
    throw err; // durable marker was never written — nothing to roll back
}

// Only now that apply succeeded is the durable "executed" state true.
this.stateStore?.markExecuted(record.messageHash, executedAt)
    .catch(err => log('cluster-member:persist-executed-error', { messageHash: record.messageHash, error: (err as Error).message }));
```

### Alternative (documented, not chosen)

Add `unmarkExecuted(messageHash)` to `ITransactionStateStore` and its two
implementations, and call it in the catch alongside the in-memory delete. Rejected
because: (a) it does not close the crash-mid-apply window above; (b) it grows the
interface for a guarantee the post-apply ordering gives for free. If a future need
arises to durably mark "executing" (e.g. to suppress re-apply cost rather than rely
on idempotency), revisit — but that is not this ticket.

## Update the recovery comment

The comment at line 798-799 ("Check persistent store first for post-recovery
dedup") stays accurate. But the `@pitfall` block on `handleConsensus` (line 787-789)
and the inline comment at line 811 ("Mark as executing IMMEDIATELY before any async
operations") describe the durable write's old placement — reword so the durable
marker is described as written **after** apply, while the in-memory guard is the
thing set eagerly for the race.

## TODO

- [ ] Write a reproducing test in `packages/db-p2p/test/cluster-repo.spec.ts`
      (near the persistent-dedup tests at ~line 800-895): inject a `MemoryTransactionStateStore`
      and a repo whose `commit`/`pend` throws once, drive a single-peer cluster to
      consensus so `applyConsensusOperation` throws, assert `handleConsensus` rethrew
      AND `stateStore.wasExecuted(messageHash)` is **false** (currently it is `true`).
      Then redeliver the same consensus record against a non-throwing repo and assert
      the operation actually re-runs (repo pend/commit call count increments) rather
      than being skipped.
- [ ] Move the `stateStore?.markExecuted(...)` call from before the apply loop to
      after it succeeds (see sketch). Keep the eager in-memory `set` and the
      catch-block `delete` unchanged.
- [ ] Confirm the concurrent apply-window race is still covered: a second synchronous
      `handleConsensus` for the same hash must still short-circuit at the in-memory
      `has` check (line 807). Existing dedup tests should still pass; add/keep a test
      asserting a second in-flight call does not double-apply.
- [ ] Reword the stale placement comments (line 787-789 `@pitfall`, line 811) to match
      post-apply durable write.
- [ ] Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`
      (stream, don't silently redirect) and confirm green, including the existing
      `persistent dedup prevents double execution after restart` test and the two new
      cases.
