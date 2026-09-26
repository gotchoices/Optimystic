description: A machine checking with the others in its group used to give each one exactly one second to answer, with no way to change it — so over a slow link, such as two phones reaching each other through a relay, every answer arrived late and counted as no answer. The time allowed is now an operator setting; nothing changes for a deployment that leaves it alone.
architecture: docs/transactions.md#read-consistency-and-staleness
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-cohort-query-deadline.spec.ts, docs/transactions.md, docs/debugging.md, docs/internals.md, packages/db-p2p/docs/cluster.md
----

# Cohort read deadlines are fixed at LAN speeds — implemented

GitHub issue #22. One new operator field, `clusterPolicy.cohortQueryTimeoutMs`, default 1000 ms. **A node that declares nothing behaves exactly as before**: the same 1000 ms per peer and the same 5000 ms whole-pass bound, both now arrived at through the resolvers rather than read off constants.

## What landed

**`packages/db-core/src/cluster/structs.ts`** — `DEFAULT_COHORT_QUERY_TIMEOUT_MS = 1000` beside `DEFAULT_SUPER_MAJORITY_THRESHOLD`, and the optional `cohortQueryTimeoutMs?: number` on `ClusterConsensusConfig`. Placing the field there is what makes it reach `ClusterMember` (already built with a `ClusterConsensusConfig`) and `CoordinatorRepoConfig` (already `Partial<ClusterConsensusConfig> & …`) with no new parameter anywhere.

**`packages/db-p2p/src/cluster/cluster-policy.ts`** — two exported functions:

- `resolveCohortQueryTimeoutMs(declared)` — returns the default when undeclared; **throws** a plain `Error` naming the field and the value when the declaration is not a finite number or is at or below zero. A positive fractional value is accepted (it is a duration). The doc comment states why this differs from its neighbour `asDeclaredSize`, which falls through.
- `reconcilePassTimeoutMs(cohortQueryTimeoutMs)` — `Math.max(RECONCILE_TIMEOUT_MS, 5 * cohortQueryTimeoutMs)`.

`ClusterPolicyOptions.clusterPolicy.cohortQueryTimeoutMs` is the operator field; `ResolvedClusterPolicy` carries both `cohortQueryTimeoutMs: number` and `reconcilePassTimeoutMs: number` concretely. The module now imports `RECONCILE_TIMEOUT_MS` from `reconcile-block.ts`; that file's only edge back toward this subtree is a clause-level `import type`, so no runtime cycle (a comment at the import says so).

**`CoordinatorRepo`** — `LATEST_QUERY_TIMEOUT_MS` is gone. The constructor resolves `cohortQueryTimeoutMs` through the shared resolver (so the readme's manual-wiring path and the node assembly cannot default differently, and a degenerate declaration fails there too) and derives the pass bound from it. `queryClusterForLatest` uses the per-peer value; `restoreCorroborated`'s acquisition `withDeadline` uses the derived pass bound.

**`ClusterMember`** — the module-level `ReconcileTimeoutMs` constant is gone; the member derives `reconcileTimeoutMs` in its constructor from the same two functions and `withReconcileTimeout` reads it.

**`libp2p-node-base.ts`** — `fetchArchiveFromPeer`'s hardcoded `1000` is now `consensusConfig.cohortQueryTimeoutMs`, off the one `resolveClusterPolicy` result. Its contract is unchanged: a timed-out fetch still resolves to "no archive" and the pass moves on.

**No coupling assertion was added, deliberately.** Both `ClusterMember` and `CoordinatorRepo` call `reconcilePassTimeoutMs` on the `cohortQueryTimeoutMs` from their own config, and on a live node both read the one `resolveClusterPolicy` result — one derivation function on one input cannot produce two numbers, so an `assertSuperMajorityCoupling`-style check would assert an identity. That argument, and what would re-open the drift (either side gaining its own default or field), is recorded at `ClusterMember`'s field doc and again at the assignment.

**`mesh-harness.ts` needed no change**, as the ticket predicted — confirmed by the build and by its suite passing.

## Stale comments rewritten

All four the ticket named, none merely deleted:

- The `NOTE:` in `queryClusterForLatest` now points operators at `clusterPolicy.cohortQueryTimeoutMs` and names the two-member-cohort consequence.
- The `NOTE:` at the acquisition `withDeadline` keeps its ratio argument and says *why* it survives: `max(5000, 5 × per-peer)` is exactly what preserves the ratio the argument rests on.
- `RECONCILE_TIMEOUT_MS`'s doc now says it is the **floor** of a derived bound (and the whole bound for an unconfigured node), not the bound.
- `cluster-repo.ts`'s `ReconcileTimeoutMs` comment is replaced by the field doc described above.

## Tests

| Test | What it verifies |
|---|---|
| `cluster-policy.spec.ts` → the two new lines in "resolves the rest of the consensus config to its documented defaults" | An unconfigured node resolves 1000 / 5000 — the shipped pair, unchanged |
| `cluster-policy.spec.ts` → "raises the pass bound along with the per-peer budget" | Declared 3000 → 3000 / 15000 |
| `cluster-policy.spec.ts` → "keeps the pass bound at its 5000 ms floor…" | Declared 100 → 100 / 5000 (the `max` floor) |
| `cluster-policy.spec.ts` → "accepts a fractional duration…" | 1500.5 is accepted, not rejected as a non-integer |
| `cluster-policy.spec.ts` → four `throws on a … cohortQueryTimeoutMs` cases | `0`, negative, `NaN`, `Infinity` each throw naming the field |
| `cluster-policy.spec.ts` → "derives the pass bound the same way for every caller" | `reconcilePassTimeoutMs(policy.cohortQueryTimeoutMs)` equals `policy.reconcilePassTimeoutMs` across five declarations — the identity that stands in for a coupling assertion |
| `coordinator-repo-cohort-query-deadline.spec.ts` (new) → deadline 40 ms vs a 250 ms answer | The honest-but-late answer reads as silence: `cluster-fetch:peers-silent` and `cluster-fetch:no-quorum` logged, read flagged `unavailable: 'cohort-unreachable'` |
| same spec → deadline 1500 ms vs the same 250 ms answer | Neither line logged, claim counted and selected, read flagged `'claimed-elsewhere'` (no acquisition callback is wired, so the bytes have nowhere to come from — the claim being accepted is the half under test) |

The second spec pins the one thing resolution cannot: that the per-peer deadline site reads the *resolved* number. It would fail against the old hardcoded 1000, where a 250 ms answer lands in both cases.

**Why small declared durations rather than the default.** There is no fake-timer library in `db-p2p` (devDependencies are mocha + chai only) and `withDeadline` uses real `setTimeout`, which the class's `now` seam does not cover — that seam is only for the read-repair window. 40 ms and 1500 ms against a 250 ms answer is about 0.32 s of real time for both cases, with a ~6× margin either side of the delay. The spec header says so.

**Nothing tests the archive fetch separately.** It is the same arithmetic on the same round trip to the same peer, and the node-base wiring passes the one resolved value through, so there is nothing separate to exercise. Flagged here because a reviewer may reasonably want to challenge it.

## Docs

- `docs/transactions.md` § Read Consistency and Staleness — `cohortQueryTimeoutMs` added to the knob table; the "bounded by the same 5s deadline (`RECONCILE_TIMEOUT_MS`)" sentence now says the bound is derived and the constant is its floor; a new paragraph says when to raise the field (steady `cluster-fetch:peers-silent` against peers that are healthy and answering everything else) and why one field sets both deadlines.
- `docs/debugging.md` § `cluster-fetch:no-quorum` — the `silent` above `0` row's "Wait, or fix reachability" now also names the deadline as a cause and the field as a remedy; the `noArchive` bullet's "its own one-second timeout" is now the configurable one.
- `packages/db-p2p/docs/cluster.md` — a `cohortQueryTimeoutMs` section alongside the other `clusterPolicy` fields, plus the field in the `ClusterConsensusConfig` block.
- `docs/internals.md` — the reconcile bullet now names the derived bound and how it is derived.

## Validation run

`yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` and `yarn test` from the root: all pass. `yarn test` is fully green — 0 failing across every workspace (the `pending` counts are the pre-existing env-gated specs). `yarn test:integration` and `yarn check:rn` were **not** run: neither is agent-runnable inside this ticket's budget, and neither touches these paths.

## Known gaps a reviewer should weigh

- **The default is unchanged, so the reporter's deployment is not fixed until it sets the field.** That is the ticket's design ("Defaults do not change"), but it means the issue closes on "configurable", not on "works out of the box over a relay". The adaptive budget the reporter listed first is explicitly out of scope.
- **The write/push path's per-peer deadlines are untouched** (the callers' own bounds in `pushBlockToPeers`, `packages/db-p2p/src/cluster/block-transfer-service.ts`). Same latency exposure, different path, no report against it — out of scope by the ticket, and worth confirming that is still the right call.
- **The throw is at node construction, and it is a plain `Error`.** A host that passes a computed value (a number parsed from its own config, say) will now fail to build a node instead of silently running at 1000. That is the intended direction, but it is a new failure mode for an embedder.
- **Three consumers now read one field, and only one of them is exercised end to end.** The `resolveClusterPolicy` tier pins the numbers and the `CoordinatorRepo` tier pins the latest-query site; `ClusterMember.withReconcileTimeout` and `fetchArchiveFromPeer` are pinned only by the build and by the shared-derivation identity test.
