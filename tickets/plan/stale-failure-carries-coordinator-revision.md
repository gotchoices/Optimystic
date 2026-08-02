----
description: When a write loses a revision race, the coordinator knows which revision it actually holds but only reports it inside a free-form English sentence that callers are forbidden to parse. So a client that is stuck retries the same doomed revision ten times over twenty seconds and then fails with a message that reads like ordinary contention. Carry the number as a real field.
files: packages/db-core/src/network/struct.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts
difficulty: medium
----

# A stale rejection should carry the coordinator's revision as data, not prose

## The problem

`StaleFailure` ([struct.ts:66](../../packages/db-core/src/network/struct.ts#L66)) carries `reason`,
`missing`, `pending`, and `conflict`. When a pend loses an optimistic-concurrency race, both
producers build the reason string the same way:

```ts
`stale revision: block ${blockId} at rev ${latest.rev}, requested rev ${request.rev}`
```

— [coordinator-repo.ts:784](../../packages/db-p2p/src/repo/coordinator-repo.ts#L784) and
[cluster-repo.ts:1077](../../packages/db-p2p/src/cluster/cluster-repo.ts#L1077).

`latest.rev` is exactly what a losing client needs, and it is unreachable: the reason string is
free-form, wire-visible prose, and `coordinator-repo.ts`'s own doc comment states it must never
become control flow. That rule is right. The consequence is not: `Collection.syncInternal` can only
retry blindly, and when the client's revision context is wrong rather than merely behind, all ten
attempts request the same revision, learn nothing, and spend ~20 s of exponential backoff producing
a `SyncRetryExhaustedError` that looks like a busy cluster.

The embedding application (sereus) hit this for real and asked for the field by name; see
`fix/cross-node-convergence-sereus-signature-not-reproducible`, where the missing number is the
reason a cross-repo defect had to be diagnosed by inference from log text.

## What to add

An optional structured field on `StaleFailure` naming the revision the responder actually holds for
the block that lost — something on the order of:

```ts
/** The block that already occupies (or is past) the requested revision, and the revision it
 *  holds. Set only when the producer confirmed staleness against its own storage; absent
 *  otherwise, so a producer that cannot confirm stays silent rather than guessing. */
staleAt?: { blockId: BlockId; rev: number };
```

Optional and additive, so every existing producer (`TestTransactor` included) and every consumer
that ignores it keeps its current behaviour.

## What it buys

- **Fail fast on a hopeless retry.** `syncInternal` can tell "I am behind, rebase and retry" from
  "I asked for a revision that is already taken and my next attempt will ask for the same one",
  and stop instead of burning the full budget.
- **Rebase instead of retry.** With the coordinator's revision in hand, the client can advance its
  context directly rather than hoping `updateInternal` re-derives it.
- **An honest error.** `SyncRetryExhaustedError` can name the revision gap, so an embedder sees a
  diagnosis instead of a contention-shaped message.

## Design decisions to settle before implementing

- **Confirmed only.** `classifyStaleRejection` confirms staleness by re-reading local storage; only
  that path may populate the field. The conservative branch that cannot confirm locally
  ([coordinator-repo.ts:787](../../packages/db-p2p/src/repo/coordinator-repo.ts#L787)) must leave it
  absent, exactly as it leaves the rejection a throw today.
- **First loser or all losers.** A pend can touch many blocks. Reporting the first block found at or
  past the requested revision is the cheap option and matches the existing reason string; the
  alternative is a list. Pick one and say why.
- **Wire compatibility.** The field crosses the repo protocol, so decide whether a peer running an
  older build that drops the field needs any handling beyond "treat as absent" (it should not, but
  the mixed-version case is tracked separately in `backlog/debt-mixed-version-identify-incompatibility`).
- **Whether `Collection` acts on it in this pass** or only carries it. Acting on it changes retry
  behaviour for every caller; carrying it is a strictly additive first step. Recommend: carry and
  surface it in `SyncRetryExhaustedError` in this pass, and file the retry-policy change separately
  so the behavioural change is reviewed on its own.

## Edge cases & interactions

- A stale failure with **no** `staleAt` (unconfirmed, or an older peer) must behave exactly as
  today — no consumer may require the field.
- `TestTransactor` and the mesh harness never set it; their tests must stay green untouched.
- `isConflictFailure` semantics are unchanged: `staleAt` is diagnostic, not a retryability signal.
  Do not let it become a second, competing source of truth for `conflict`.
- The multi-collection coordinator path (`transaction/coordinator.ts`) surfaces stale losses too;
  decide whether it propagates the field per collection or drops it.
- Downstream consumers read `StaleFailure` through `@optimystic/db-core`'s public surface, so this
  is a dependency-floor bump for embedders.

## TODO

- [ ] Add the field to `StaleFailure` with the "confirmed only" contract documented on it.
- [ ] Populate it in `CoordinatorRepo.classifyStaleRejection` and `ClusterMember`'s promise-phase
      stale gate; leave the unconfirmed branches absent.
- [ ] Thread it through the repo protocol codec and add a round-trip test.
- [ ] Surface it in `SyncRetryExhaustedError`'s message and add a test that the error names the
      revision gap.
- [ ] Confirm the whole db-core and db-p2p suites stay green with no consumer changes.
