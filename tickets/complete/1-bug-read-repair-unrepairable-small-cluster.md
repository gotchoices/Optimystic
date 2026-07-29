description: A node that had fallen behind used to accept its own out-of-date answer as if a peer had confirmed it, and a two-node cluster could never agree on anything newer. Both are fixed, and review closed a leftover case where a node that had been reassigned away from a block reported a successful repair that never happened.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md
----

# Complete: read-repair revision selection at small cluster sizes

## What shipped

A read-repair pass polls the other members of a block's cluster ("cohort") for the newest
revision they hold, and adopts it if enough of them agree. Two flaws made a two-node
deployment permanently unable to catch up:

- **The reader counted its own answer as agreement.** The routine that asks a peer for its
  latest revision answers a question about *this* node from local storage rather than
  dialling itself. That answer was being counted as a corroborating vote, so a reader whose
  only peer timed out "confirmed" the very revision it was trying to repair — and then
  logged a successful sync and suppressed further repair attempts for the next 10 seconds.
- **A claim always needed two peers to confirm it.** A two-member cohort has, by
  construction, exactly one other peer, so nothing could ever be confirmed.

Implemented in `50af693`:

1. The reader's own answer is split out of the vote and returned separately, used only as
   the baseline to compare against.
2. The two-confirmer requirement is capped by how many peers could confirm at all —
   `max(peers currently visible excluding self, clusterSize - 1)`. Taking the **larger** of
   the two matters: cluster views are unauthenticated, so a partition or an attacker with
   routing influence could otherwise shrink a reader's view and talk the requirement down.
   The escape hatch for a real two-node deployment is to configure `clusterSize: 2`, an
   explicit operator declaration.
3. Restoration is monotonic — a cohort lagging behind the reader can no longer drag it
   backwards.
4. `clusterPolicy.allowUnvalidatedSmallCluster` is now reachable from `createLibp2pNode`;
   it was defined and consumed but unsettable by any embedder.

Two follow-on commits landed against sibling tickets before this review and are part of the
current behavior: `07cb230` threaded the same capacity cap into the commit-path reconcile
(both its gates), and `559df6a` gave the read path the ability to actually transfer block
content, which the implement stage had correctly reported as still missing.

## Review findings

### Checked and clean — no change needed

- **The capacity formula, the implementer's top ask.** Traced whether a deployment could
  have a legitimately large `clusterSize` but a legitimately small cohort, which would now
  be unable to repair. Walked `allowClusterDownsize`, `clusterSizeTolerance`, and
  `minAbsoluteClusterSize`: a downsized cohort of three or more still has two or more
  possible confirmers, so the floor stays satisfiable. The only unsatisfiable case is a
  genuinely two-member cohort left at a larger configured `clusterSize` — already documented
  in `docs/transactions.md`, diagnosable from the `required` count on the
  `cluster-fetch:no-quorum` log line, and the underlying `clusterSize` overloading is
  already owned by `plan/3-clustersize-conflates-replication-factor-and-admission-yardstick`.
  No new ticket.
- **Reconcile left on the strict floor.** The implement handoff raised this as an open
  question; `07cb230` has since resolved it in both gates. Verified against the current
  source, not the handoff text.
- **The five specs that mock the cluster-latest callback.** Audited all of them for
  false-greens riding the removed fallback. Found none beyond the three the implementer had
  already corrected.
- **The mesh test harness faking data sync.** The handoff flagged that
  `testing/mesh-harness.ts` wrote a peer's block into local storage after reading its
  latest, something the production path never did — making harness-based convergence
  assertions meaningless. `559df6a` removed the fake and wired a real acquire callback.
  Verified.
- **Excluding self weakens the proportional term** (a majority of *other* peers rather than
  of all responders — 4 of 9 where it was 5 of 10). Deliberate and correct for a
  corroboration vote; `floor(0.51 × n)` was never a strict majority in the first place.
  Accepted as-is.
- **Docs.** Read `docs/transactions.md` § "Read Consistency and Staleness" and the
  `docs/internals.md` reconcile bullet in full against the current source rather than
  trusting the handoff. Both accurate, including the parts rewritten by the two follow-on
  commits. One wording tightening applied (see below).

### Found and fixed in this pass — minor

- **The monotonic guard was skipped entirely when the reader is absent from its own cohort
  view.** The guard read the reader's revision out of the self-answer, which only exists
  when the cluster lookup returned this node. A node serving a read for a block it is no
  longer responsible for — the documented soft-serve path that logs `proximity:get-warning`
  — is absent from that view, so the baseline was `undefined` and every local revision
  counted as "an advance". Consequence: a pass that moved nothing logged
  `cluster-fetch:synced` at the revision it started from, and attempted a restoration to an
  older revision. No data regression — `StorageRepo.get` filters a backwards restoration
  context out — so the real harm is a wasted storage round trip plus exactly the phantom
  sync log that `559df6a` set out to eliminate ("reported hundreds of phantom convergences
  per run and made a real replication defect invisible for two debugging sessions").
  Fixed by passing the revision the caller's read already loaded down as the baseline; it
  costs nothing, since `get` had already computed it. New spec: *"uses the revision it
  already read as the baseline when self is not in the cohort view"* — confirmed failing
  before the fix.
- **The capacity rule was written twice.** `CoordinatorRepo.corroboratorCapacity` and
  `reconcile-block.ts`'s private copy were the same two-line rule under two near-identical
  eight-line rationale comments — the whole safety argument of this ticket, duplicated and
  free to drift. Hoisted to one exported `corroboratorCapacity` in `quorum-restore.ts`
  beside the `quorumSize` that consumes it, with four unit specs of its own (it previously
  had none directly; it was only exercised through its two callers).
- **One leaked timer per cohort peer per repair pass.** The per-peer timeout helper in
  `queryClusterForLatest` never cleared its `setTimeout`, so every peer that answered
  promptly still left a handle keeping the event loop alive for the full second. The
  sibling `withDeadline` helper in the same file clears its timer and documents why;
  brought the two in line.

### Tripwires — recorded at the code site, not filed as tickets

- **A lying sole peer can hold the repair window open.** In a two-member cohort the one
  peer is the only confirmer, so it can keep corroborating the revision the reader already
  holds and re-arm the 10-second lazy window on every pass. Bounded, and no worse than the
  peer staying silent. `NOTE:` at the guard in `coordinator-repo.ts`, naming the condition
  that would make it real work (two-member cohorts becoming a supported production
  topology). This is the judgement call the implementer explicitly asked a reviewer to make.
- **Self-exclusion is keyed on an optional `localPeerId`.** Left unset — a construction this
  class has always tolerated for single-node and test setups — the reader's own answer is
  counted as a peer claim again. Harmless today, because a self-answer can only ever
  corroborate the revision already held, so the pass declines as `local-current`. `NOTE:` at
  the site saying to make `localPeerId` required if that ever stops being true.

### Major findings — none

Nothing warranted a new ticket. The two exposures the implement stage documented honestly
(a two-member cohort trusting its sole peer's claim, and the capacity guard depending on
`clusterSize` being configured honestly) were re-examined rather than taken on trust, and
both hold: the first has no Byzantine tolerance to protect at that cohort size and is
already tracked by `backlog/debt-read-repair-commit-cert-verification`; the second is a
configuration concern already owned by an existing `plan/` ticket.

`coordinator-repo.ts` is 772 lines and carries both the repair machinery and the
pend/commit/cancel surface. Considered filing this as cleanup and decided against it — the
file is well below `cluster-repo.ts` at 1836 lines, so it is not an outlier for this
package, and the class is cohesive.

## Residual exposure, restated

- A cohort configured `clusterSize: 2` trusts its sole peer's revision **and content** on
  its word. Revision claims are bare assertions — a block archive carries no commit
  certificate — and block ids are random rather than content-derived, so nothing on the
  receive path can check either. Pinned by `quorum-restore.spec.ts` → *"a sole cohort peer
  is believed even when its rev is absurd (documented exposure)"*. Closing it needs
  `backlog/debt-read-repair-commit-cert-verification`.
- Sybil resistance is unchanged and still deferred to the same ticket.

## Validation

```
$ cd packages/db-p2p && npx tsc --noEmit          → exit 0
$ node ... mocha "test/**/*.spec.ts"              → 1414 passing, 41 pending, 0 failing
$ OPTIMYSTIC_INTEGRATION=1 ... "**/*.integration.spec.ts"
                                                  → 27 passing, 2 pending
$ cd ../.. && yarn lint                           → exit 0
$ yarn build                                      → exit 0
$ yarn test        # root fan-out, all packages   → Done, 0 failing
```

Package count went 1409 → 1414: one regression spec for the baseline defect, four for the
newly-shared `corroboratorCapacity`. No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.
