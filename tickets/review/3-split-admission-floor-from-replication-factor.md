description: A node used its "how many copies to keep" setting to also decide how small a group of peers it would accept a write from, which made small deployments refuse every write out of the box. The second job now has its own setting with a small default, so a two- or three-node deployment works without configuration.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md
difficulty: medium
----

# Review: membership admission gate gets its own size setting

## What changed

`clusterSize` (replication factor) was being read as the membership admission gate's fallback
yardstick. Because it defaults to `10`, an unconfigured two- or three-node deployment refused every
write. The two settings are now split.

### `packages/db-core/src/cluster/structs.ts`

- `ClusterConsensusConfig.clusterSize` doc rewritten: it is the replication factor / target cohort
  breadth only, and explicitly **not** a security yardstick.
- New `ClusterConsensusConfig.assumedClusterSize?: number` — the smallest cohort the operator asserts
  this deployment can genuinely field. `undefined` means "unknown".

### `packages/db-p2p/src/cluster/cluster-repo.ts`

- `ClusterMember.configuredClusterSize` → `assumedClusterSize` (reads `consensusConfig.assumedClusterSize`;
  no longer reads `clusterSize` anywhere).
- New private `admissionFloor(k) = max(minAbsoluteClusterSize, ceil(membershipAdmissionFraction · k))`.
  **Both** branches of `admitMembership` now go through it, differing only in which size they feed it
  (`kEst` measured, or `assumedClusterSize` asserted). Previously the unconfident branch demanded the
  *full* configured size — no fraction, no slack — so it was strictly harsher than the measured path on
  the same numbers. That second defect is fixed here.
- Unconfident branch: `assumedClusterSize === undefined` → legacy approve (unchanged posture for the
  many call sites constructing a member with no `consensusConfig`).
- Both size reject reasons now carry their numbers, prefix intact:
  - `membership-not-admitted:low-confidence-downsize (declared=3, floor=6, assumedClusterSize=8)`
  - `membership-not-admitted:below-floor (declared=3, floor=6, kEst=8)`
- One-shot `log('cluster-member:admission-config', {...})` at construction, so an operator diagnosing a
  rejection can see the node's resolved gate parameters.
- `admitMembership` doc comment rewritten (it described the removed `clusterSize` behavior).

### `packages/db-p2p/src/libp2p-node-base.ts`

- `NodeOptions.clusterPolicy.assumedClusterSize?: number`, threaded into `consensusConfig` as
  `options.clusterPolicy?.assumedClusterSize ?? 2` (the same literal as `minAbsoluteClusterSize` in that
  object). `clusterSize` stays `?? 10` with a comment saying it is deliberately not the gate's yardstick.

### Docs

- `packages/db-p2p/docs/cluster.md`: added the four `membership-not-admitted:*` variants to the error
  list (they are carried as a `rejectReason`, not thrown — worth confirming that framing is right), and
  a "`clusterSize` vs `assumedClusterSize`" subsection plus the three new fields in the config-table
  snippet.
- `docs/correctness.md` Theorem 2 (§ line ~112): the fail-closed clause said the gate measures "against
  the configured full `clusterSize`". Rewritten to `assumedClusterSize`, and it now states the accepted
  trade explicitly.

## The tradeoff this change deliberately accepts

Stated in the plan ticket and worth re-checking with fresh eyes: a **large** network whose operator
configures nothing now gets a *weaker* gate in one specific situation — when its own network-size
estimate is unconfident (which is exactly what a partition induces), the floor falls back to
`assumedClusterSize`, defaulted to `2`. A large healthy network takes the confident branch and is at
full strength regardless of configuration; the fix for a large operator is one explicit setting.

The reasoning was: "write-dead by default" is a *certain* failure for every small deployment;
"gate degraded under partition" is a *conditional* failure for large deployments whose operator declined
to configure anything. If the reviewer disagrees with that direction, this is the place to say so — it is
a security posture decision, not an implementation detail. The follow-up that removes the trade
(deriving the floor from the largest cohort ever observed) is parked in
`backlog/feat-admission-floor-from-observed-cohort-high-water-mark`.

## Validation performed

All green, run from a clean tree:

| command | where | result |
|---|---|---|
| `yarn build` | root (all packages) | pass |
| `yarn test` | root | pass — `db-core` 1266 passing, `db-p2p` 1428 passing / 41 pending, rest 258 + 6 |
| `yarn lint` | root | pass |
| `yarn test -- --grep "membership admission gate" --reporter spec` | `packages/db-p2p` | 22 passing |

`yarn test:integration` was **not** run (it is env-gated and slow). Note that it would not have caught a
regression here anyway: `src/testing/mesh-harness.ts` sets `allowUnvalidatedSmallCluster: true`, which
short-circuits the size gates entirely. **Unit coverage in
`test/cluster-membership-admission.spec.ts` is the only guard on this gate.**

## Use cases to exercise / verify

The spec now has 22 cases. The ones that matter most:

1. **The reported regression** — `assumedClusterSize: 2`, declared set of 2, no derivation capability →
   **approve**. Previously (`clusterSize: 10`) this rejected. Also covered at
   `clusterSize: 10` with **no** `assumedClusterSize` → approve, which pins that the two settings are
   decoupled and a future refactor cannot quietly re-couple them.
2. **The fallback now has slack** — `assumedClusterSize: 8`, declared **6** (`= ceil(0.75 × 8)`), low
   confidence → **approve**. Previously rejected, because the fallback demanded the full 8. This is the
   churn / discovery-timing fix.
3. **Fail-closed still binds** — `assumedClusterSize: 8`, declared 3, low confidence → **reject**, reason
   matched by regex including `(declared=3, floor=6, assumedClusterSize=8)`. Same for the empty-derived-view
   case and the split-brain minority side.
4. **Legacy paths** — no `assumedClusterSize` → approve; **no `consensusConfig` at all** → approve (the
   `voteOn` helper now takes an optional config specifically to exercise this).
5. **Degenerate values** — `assumedClusterSize: 1` → floor clamps to `minAbsoluteClusterSize` (2), so a
   solo set rejects unless `allowUnvalidatedSmallCluster` is on (both asserted); `0` and `-5` do not throw
   and floor at `minAbsoluteClusterSize`.
6. **Both `ceil` boundaries** — `ceil(0.75 × 8) = 6` (confident path, exactly-at-floor admits) and
   `ceil(0.75 × 3) = 3` (the pre-existing confident small-cluster case).
7. **Unchanged invariants** — self-membership (predicate 1) still unconditional and first;
   `allowUnvalidatedSmallCluster` still skips the size gates but not self-membership; predicate-3
   tolerance boundary cases untouched.

## Known gaps / things I would look at first

- **No test asserts the `cluster-member:admission-config` construction log fires.** It is a `log(...)`
  side effect with no observable return; I judged a logger spy not worth the coupling. If the reviewer
  wants it pinned, that is a fair ask.
- **`NaN` as `assumedClusterSize` is not handled.** `Math.max(2, NaN)` is `NaN`, and `declared.length >= NaN`
  is false, so a `NaN` would make the node reject every unconfident write. `0`, `1` and negatives are
  tested and safe; `NaN` is the one degenerate input with no guard. I left it because it can only come
  from a config typo (`parseInt` of a bad env var), but a `Number.isFinite` guard in `admissionFloor` would
  be cheap.
- **The exactly-at-floor case is tested on the confident path but the unconfident at-floor case is tested
  at `declared = 6, floor = 6` only** — I did not add an at-floor-minus-one twin for the unconfident branch
  (the `declared=3` case covers well below). Low value, but it is an asymmetry.
- **`NodeOptions.clusterSize`'s doc comment still says a two-node deployment must set `clusterSize: 2`**
  for read-repair corroboration. That is *currently accurate* — `corroboratorCapacity` still reads
  `clusterSize`. It is deliberately left alone; `implement/corroboration-floor-uses-assumed-cluster-size`
  (sequenced next, `prereq` on this) rewrites it. Do not "fix" it here.
- **I did not touch `backlog/bug-key-network-cluster-size-default-diverges`** (the key network falls back
  to `16` while everything else falls back to `10`). This change removes the *admission* consequence of
  that divergence, not the divergence.
- **`docs/internals.md` was left unchanged.** Its `clusterSize` mentions (lines ~311, ~319, ~532) are about
  the corroboration floor and FRET's dynamic-`d`, not the admission gate, so they belong to the follow-on
  ticket. Worth a second pair of eyes confirming I read that boundary correctly.
- **Cross-peer reason comparison** was checked, not just assumed: `disputeEvidence.rejectReasons` is a
  per-peer map (`cluster-coordinator.ts:356-364`), the signed payload hashes the string each vote carries
  (`computeSigningPayload`, verified as-carried in `cluster-repo.ts` and `dispute-service.ts:678`), and
  `cluster-coordinator.ts:337` only interpolates reasons into an error string that no spec asserts
  verbatim. Longer reason strings round-trip fine.

## Review findings

- Tripwire parked as a `NOTE:` comment in `packages/db-p2p/src/cluster/cluster-repo.ts`, at the
  `low-confidence-downsize` reason construction: two honest members with different local config now emit
  different reason strings for the same record. Nothing compares them today; if anything ever groups or
  dedupes dispute reasons by string equality, it must group on the `membership-not-admitted:<variant>`
  prefix rather than the whole string.
