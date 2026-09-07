description: Review the new setting that lets an application tighten the block-repair safety check as a user's group of machines grows, without also making the system stricter about accepting writes — plus the written-down rule that a group applies a changed machine count by restarting its node rather than through a live setting change.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/reference-peer/src/cli.ts, packages/db-p2p/docs/cluster.md, docs/optimystic.md, docs/internals.md, docs/architecture.md, docs/transactions.md
difficulty: medium
----

# Review: declare the repair yardstick on its own; apply a changed size by rebuilding

## What shipped

One new operator field and a pile of prose that had drifted out of true.

`clusterPolicy.repairCorroborationClusterSize` (on `ClusterPolicyOptions`, so it flows through
`NodeOptions` automatically) declares the **repair corroboration floor's yardstick alone**. Before
this, the only way to raise that yardstick was `clusterPolicy.assumedClusterSize`, which also raises
the membership admission gate's low-confidence write floor — so a deployment that wanted repair
tightened had to accept a floor that can refuse legitimate writes. The downstream consumer (Sereus)
pinned `assumedClusterSize: 2` at every group size for exactly that reason, and therefore got no
repair tightening at all. **No runtime setter was added; that was settled in the plan and is recorded
as an accepted-tradeoff `NOTE:` at `resolveClusterPolicy`.**

### The resolution order now in `resolveClusterPolicy` (`cluster/cluster-policy.ts:~215`)

```ts
repairCorroborationClusterSize =
    max(minAbsoluteClusterSize /* 2 */,
        asDeclaredSize(declaredRepairSize) ?? asDeclaredSize(declaredCohortSize) ?? clusterSize)

// unchanged pass-through:
assumedClusterSize = options.clusterPolicy?.assumedClusterSize ?? minAbsoluteClusterSize
```

`asDeclaredSize` (new module-private helper) returns the value only when it is a positive integer —
`Number.isInteger` already rejects `NaN`, both infinities and fractions — and `undefined` otherwise,
so a degenerate declaration **falls through** to the next term rather than being clamped. Clamping to
2 would be the unsafe direction (2 is the one size whose floor relaxes to a single corroborator).

### Everything else touched

- `resolveClusterPolicy` advisory: `cohortUndeclared` now requires **both** operator fields absent;
  `declaredRepairSize` added to the structured log payload; `undeclaredAdvice` names both fields and
  says which one also moves the write floor.
- `reference-peer` CLI: `--repair-corroboration-cluster-size`, mirroring `--assumed-cluster-size`
  (parser, options interface, echo line, debug payload, `clusterPolicy` construction, commander
  option). `--assumed-cluster-size`'s own help text updated for the new fallback chain.
- Stale in-code prose corrected: `quorum-restore.ts` `corroboratorCapacity` doc (third escape hatch),
  `coordinator-repo.ts` `cohortTooSmallMessage` (names both fields), `libp2p-node-base.ts:510`
  ("the one operator field" → two), `cluster-policy.ts` module doc and `clusterSize` field doc.
- Docs: `packages/db-p2p/docs/cluster.md` (the false Sereus claim replaced; the new field documented;
  two new subsections — *Which numbers move together* and *Changing a size after the node is
  running*), `docs/optimystic.md` (example switched to the new field, *Who declares it, and which
  field*, and a new rebuild-contract paragraph before *Deployment Targets*), `docs/internals.md`
  (resolution chain, size table row, host-derivation paragraph, `cohort-too-small` remedy),
  `docs/architecture.md`, `docs/transactions.md` (reconcile paragraph).

## Validation performed

```
yarn workspace @optimystic/db-p2p build                      # exit 0
yarn workspaces foreach -A --topological-dev run build       # exit 0 (all packages, incl. reference-peer)
cd packages/db-p2p && node --import ./register.mjs \
  node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"        # 2618 passing, 49 pending, exit 0
```

Every pre-existing case in `test/cluster-policy.spec.ts` passes **unmodified** — no existing spec was
edited, only the file's header doc and the `advisoryPayload` cast (which gained
`declaredRepairSize?: number`).

### Use cases worth exercising by hand

- **The downstream shape.** `resolveClusterPolicy({ clusterPolicy: { repairCorroborationClusterSize: 8 } })`
  → repair 8, admission 2, clusterSize 10. This is the case the whole ticket exists for.
- **Both declared.** The repair field wins for repair; `assumedClusterSize` still sets admission.
- **Degenerate values**, per field independently: `0`, negative, `NaN`, `Infinity`, `2.5`. Must land
  on the *strict* next term, never on 2.
- **Advisory silence** with only the repair field declared at a size with margin (5); **no-margin arm
  but not undeclared arm** at 2 or 3.
- **Reference peer:** `--repair-corroboration-cluster-size 4` should print the echo line and reach
  `clusterPolicy`; `--repair-corroboration-cluster-size 0` / `abc` / `2.5` should reject with
  "must be a positive integer".

## Known gaps — read these before trusting the test floor

- **The CLI flag has no test.** `packages/reference-peer` has no spec harness for its flags; that is
  a tracked, pre-existing gap (`tickets/backlog/debt-reference-peer-cli-flags-untestable`) and the
  ticket explicitly said not to fix it here. Verification was: the workspace builds, and the flag
  string appears in `packages/reference-peer/dist/src/cli.js`. **Nobody has run the binary with the
  new flag.** If a reviewer can boot a reference peer, that is the highest-value thing to check.
- **The coordinator-agreement spec is a hand-rolled restatement, not the real chain.** The
  `resolves to the same yardstick a hand-wired CoordinatorRepo would` case re-implements
  `cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize ?? policy.clusterSize` inline
  rather than constructing a `CoordinatorRepo`. It therefore pins the *agreement* of the two orders
  but would not notice if `coordinator-repo.ts:670` were edited. Constructing a real `CoordinatorRepo`
  needs a components object the spec file does not currently build; judged not worth the harness here,
  but it is a genuine soft spot.
- **Behaviour change to an existing field, beyond adding a new one.** A degenerate
  `assumedClusterSize` (0, negative, `NaN`, …) previously passed through into the repair yardstick
  raw; it now falls through to `clusterSize`. This is what the plan specified and it is strictly
  safer, but it *is* a change to how an existing field resolves, not purely additive. The admission
  gate's value is untouched (still a raw pass-through — `cluster-repo.admissionFloor` floors it), and
  a spec pins that asymmetry.
- **`clusterSize: 1` advisory wording.** The trailing `max(minAbsoluteClusterSize, …)` does not change
  the repair floor for any input (verified by spec, and by the `max(1, min(FLOOR, capacity))` in
  `quorumSize` plus `corroboratorCapacity`'s own max against visible peers), but it does shift the
  advisory's `availablePeers` from 0 to 1 for `clusterSize: 1`. Parked as a `NOTE:` tripwire at the
  flooring site — see *Review findings* guidance below.
- **No end-to-end / mesh test of the new field.** `mesh-harness.ts` passes `clusterPolicy` through
  verbatim so a mesh *can* declare the two yardsticks apart, but no mesh spec does. The specs added
  are all unit-level against `resolveClusterPolicy`.
- **The docs claim about what a rebuild costs was not measured.** The "survives / resets / peers'
  view" list in `cluster.md` and `optimystic.md` was assembled by reading the recovery and cache code
  named in the plan ticket (`recoverTransactions`, `lastSeenCommitMs`, `unsettledAheadClaims`, the
  responsibility cache, the rebalance monitor's snapshot). It is a code-reading claim, not an
  observed one. A reviewer who doubts a specific line should check that line against its site rather
  than assume it was exercised.

## Things the reviewer should deliberately try to break

- Is `asDeclaredSize`'s `value as number` cast sound? (`Number.isInteger(undefined)` is `false`, so
  the cast is only reached for numbers — but confirm rather than assume.)
- Does any *other* consumer of `repairCorroborationClusterSize` care that it is now floored at 2?
  Checked: `corroboratorCapacity` (both restoration paths) and the advisory. Confirm nothing else
  reads it.
- `cohortUndeclared` uses raw `=== undefined`, not `asDeclaredSize(...) === undefined`. So
  `assumedClusterSize: NaN` counts as "declared" for the advisory while falling through for the
  resolution. Deliberate (the plan said "both operator fields absent"), but it is a seam where the
  two notions of "declared" differ — worth a second opinion.
- Does the reworded `undeclaredAdvice` still read as *advice* rather than a fault for a correctly
  provisioned large deployment? It got noticeably longer.
- `packages/db-p2p/docs/cluster.md` — the `ClusterConsensusConfig` code block near line 850 was
  deliberately **not** given the new field (it is a different interface; the field lives on
  `ClusterPolicyOptions`). Confirm that is the right call and that the surrounding prose does not
  now imply otherwise.

## Out of scope (do not expand)

- Any runtime setter. Settled; the `NOTE:` at `resolveClusterPolicy` records the decision and its
  revisit condition.
- Deriving a yardstick from network observation
  (`tickets/backlog/feat-admission-floor-from-observed-cohort-high-water-mark`).
- `assertClusterSizeCoupling` — it checks `clusterSize` only and is correctly untouched. Nodes may
  legitimately disagree on the repair yardstick.
- The Sereus-side derivation (that repo's work, depends on this shipping).
