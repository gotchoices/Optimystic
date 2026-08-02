----
description: When a machine looks for a piece of data it does not have locally, it asks the other machines that should have a copy. If those machines are slow or unreachable, their silence is currently treated as them saying "that data does not exist" — so the asking machine confidently reports the data is missing when it is really just out of touch. Silence needs to be reported as silence.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts
difficulty: hard
repro: static
----

# A cluster read consult cannot tell "peer said no" from "peer said nothing"

## The defect

`CoordinatorRepo.get` is the read path's authority on whether a block exists. When the block is not
in local storage it consults the cohort, and only after that consult does it decide what to report.
The two outcomes it can report are meaningfully different:

- **authoritative absent** — `{ state: {} }`, no `unavailable` flag. `NetworkTransactor.get`
  treats this as FINAL and does not retry it
  ([network-transactor.ts:132-166](../../packages/db-core/src/transactor/network-transactor.ts#L132-L166)).
  `Collection.createOrOpen` takes it as licence to invent a fresh empty collection.
- **`unavailable: 'peers-unreachable'`** — "my answer is a guess". This re-enables the
  transactor-level retry against a different peer, and reaches `Collection` as a thrown
  `BlockUnavailableError` rather than as an absence.

The consult cannot currently distinguish the inputs that should produce those two outcomes, because
the callback it consults through collapses them.

`ClusterLatestCallback` returns `Promise<ActionRev | undefined>`
([coordinator-repo.ts:91](../../packages/db-p2p/src/repo/coordinator-repo.ts#L91)). Its libp2p
implementation returns `undefined` for BOTH "the peer answered and holds nothing" and "the dial
threw" — [libp2p-node-base.ts:819-835](../../packages/db-p2p/src/libp2p-node-base.ts#L819-L835):

```ts
const syncClient = new SyncClient(peerId, keyNetwork, protocolPrefix);
try {
    const response = await syncClient.requestBlock({ blockId, rev: undefined });
    // …
} catch {
    // Peer may be unreachable - return undefined to skip this peer
}
return undefined;
```

`queryClusterForLatest` then discards the remaining distinction it *does* still have — a rejected
`Promise.allSettled` entry (the per-peer 1-second `withTimeout`) is dropped by the same `continue`
that drops a fulfilled `undefined`
([coordinator-repo.ts:640-651](../../packages/db-p2p/src/repo/coordinator-repo.ts#L640-L651)):

```ts
for (const result of latestResults) {
    if (result.status !== 'fulfilled' || !result.value.value) continue;
```

No quorum means `queryClusterForLatest` returns `{ local }` with no `corroborated`,
`fetchBlockFromCluster` returns normally, the `catch` that would set `unavailable` never runs, and
the locally-missing block is reported as an **authoritative absent**. The code says so itself, at
[coordinator-repo.ts:368-372](../../packages/db-p2p/src/repo/coordinator-repo.ts#L368-L372):

> NOTE: a consult that runs but corroborates nothing (per-peer timeouts and "peer holds nothing"
> both surface as absent claims → no quorum) does NOT land here and stays an authoritative absent —
> the common new-collection probe against a healthy cohort takes exactly that path, and the callback
> contract cannot distinguish the two without counting responders.

That note is accurate. This ticket is to act on it.

## Why it matters now

A two-node cohort makes the failure trivially reachable: after self-exclusion there is exactly one
peer to consult, on a 1-second timeout. One slow answer and the reader concludes the block does not
exist. On the collection header block that means `createOrOpen` invents a rival empty collection
whose revision context starts at zero, and — per the sibling ticket
`collection-forgets-revision-on-absent-header` — the client then cannot climb back out. The observed
end state is `SyncRetryExhaustedError … stale revision: block X at rev 3, requested rev 1`, ten
attempts, ~20 seconds, from the embedding application (sereus) running two nodes in separate
processes over real sockets.

`repro: static`. This was read, not run: the collapse is visible in the source and stated in the
code's own comment, but no test has yet driven a cohort peer to time out and observed the resulting
authoritative absent. Writing that test is the first TODO, and it is what would upgrade this to
`verified`. Note that the existing in-repo two-node tests all pass — on the mock mesh and over real
TCP — precisely because their peers answer fast; see the closed fix ticket
`cross-node-convergence-sereus-signature-not-reproducible` for the full list of what those rule out.

## What to change

Give the consult a way to say "I did not hear back". Concretely, the callback (or its caller) must
surface three states per peer, not two:

- **responded, holds revision R** — a claim, counted toward quorum as today.
- **responded, holds nothing** — an absent claim. A cohort where every peer responds this way is a
  genuine absence, and the fast `createOrOpen` probe must stay fast.
- **did not respond** (dial failure, protocol error, or the 1-second timeout) — silence. Not
  evidence of anything.

`CoordinatorRepo.get` then reports `unavailable: 'peers-unreachable'` for a locally-missing block
whenever at least one cohort peer was silent, and keeps the authoritative absent only when the whole
cohort answered.

Design decisions to settle while implementing (record the choice and why in the review handoff):

- **Where the three-way state lives.** Widening `ClusterLatestCallback`'s return type is the
  explicit option; returning a per-peer outcome from `queryClusterForLatest` and letting the
  callback keep throwing on failure is the smaller one — the `catch` in `libp2p-node-base.ts` is
  what erases the signal, and `Promise.allSettled` already preserves a rejection. Prefer the smaller
  change if it covers every silence path.
- **Threshold: any silence, or a majority of it?** Flagging on any single silent peer is
  fail-closed and cheap; on a large cohort it may flag often enough to cost round-trips. State which
  you picked and what it costs.
- **The mesh harness's own callback**
  ([mesh-harness.ts:225](../../packages/db-p2p/src/testing/mesh-harness.ts#L225)) must be able to
  express silence too, or the new test cannot be written.
- **Wire/consumer compatibility.** `unavailable` is already an established field with established
  consumers; this changes only how often it is set, not its shape. Confirm no consumer treats
  `peers-unreachable` as fatal where it previously saw an absent.

## Interactions

- Sibling: `collection-forgets-revision-on-absent-header`. That one stops a bad read from wedging a
  client permanently; this one stops the bad read from being produced. No `prereq:` between them —
  different packages, different sites, either order works. Both are needed before asking sereus to
  re-measure.
- `plan/stale-failure-carries-coordinator-revision` is a third, independent improvement to the same
  diagnosis chain.
- The read-repair correctness work already tracked in
  `backlog/debt-read-repair-commit-cert-verification` and
  `backlog/debt-read-repair-penalty-provable-only` is about trusting *claims*. This is about
  counting *responders*. Do not fold them together.

## TODO

- [ ] Add a db-p2p test that drives a cohort peer to be silent (timeout or dial failure) during a
      `CoordinatorRepo.get` of a locally-missing block, and assert the current behaviour: an
      authoritative absent. This is the missing measurement — land it before the fix so the fix has
      something to flip.
- [ ] Preserve the responded-vs-silent distinction from the libp2p `ClusterLatestCallback` through
      `queryClusterForLatest`.
- [ ] Report `unavailable: 'peers-unreachable'` from `CoordinatorRepo.get` for a locally-missing
      block when the consult ran but some cohort peer was silent. Leave the all-answered case an
      authoritative absent so the new-collection probe stays one round-trip.
- [ ] Update the `NOTE:` at coordinator-repo.ts:368-372 — it documents exactly the gap being closed
      and must not outlive it.
- [ ] Teach the mesh harness's callback to express silence, so the scenario is reachable from tests.
- [ ] Re-run the db-p2p suite (1479 passing / 44 pending before this ticket) and `yarn test:integration`.
