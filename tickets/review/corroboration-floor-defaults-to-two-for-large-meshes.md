----
description: A node repairing a damaged copy of data used to accept a single peer's word by default, so anything that made the peer group look smaller than it really is could push bad data onto an unconfigured node; the repair check now has its own default and demands two independent peers unless the operator says the network really is that small.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, docs/transactions.md, docs/internals.md, packages/db-p2p/docs/cluster.md
difficulty: medium
----

# Review: repair corroboration floor got its own size yardstick

## What was wrong

One operator field, `clusterPolicy.assumedClusterSize`, fed two consumers with opposite failure
modes, and the composition root defaulted it to `2` for the sake of the permissive one:

- **Membership admission gate** (`cluster/cluster-repo.ts`) — reads it only when the node has no
  confident network-size estimate. Too small = a partition-induced downsize slips past. Too large =
  the node refuses legitimate writes. Wants a permissive default.
- **Repair corroboration floor** (`corroboratorCapacity` in `cluster/quorum-restore.ts`, called on
  every read-repair and every commit-path reconcile). Too small = a shrunken, unauthenticated peer
  view buys a lone peer full trust. Too large = a block stays unrepaired (degraded, not dead). Wants
  a strict default.

With the shared default of 2: `corroboratorCapacity(visiblePeers = 1, yardstick = 2) = max(1, 1) = 1`,
so `quorumSize` capped its floor of two down to one — a single peer's claim was adopted.

## What changed

**One operator knob, two resolved values.** New pure module
`packages/db-p2p/src/cluster/cluster-policy.ts` exports `resolveClusterPolicy(options)`, which is now
the only place the composition root's cluster defaults live. It resolves:

```
declared = options.clusterPolicy?.assumedClusterSize     // undefined = operator said nothing

assumedClusterSize             = declared ?? 2            // admission gate — unchanged, permissive
repairCorroborationClusterSize = declared ?? clusterSize  // repair floor  — NEW, strict (default 10)
```

Threading:

- `libp2p-node-base.ts` — the inline `consensusConfig` literal (formerly ~lines 734–755) is gone;
  it now calls `resolveClusterPolicy(options)`. Both repair paths get
  `repairCorroborationClusterSize` from that one result — `createReconcileBlock` explicitly, and
  `CoordinatorRepo` via the `{...consensusConfig}` spread. The NOTE about keeping the two coupled was
  updated to name the new field.
- `createReconcileBlock` — required dep renamed `assumedClusterSize` → `repairCorroborationClusterSize`.
- `CoordinatorRepo` — private field renamed; config type widened to the new exported
  `CoordinatorRepoConfig` (`Partial<ClusterConsensusConfig> & { clusterSize?, repairCorroborationClusterSize? }`);
  resolution is `cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize ?? policy.clusterSize`.
  The middle term is deliberate: direct constructors (embedders, existing specs) keep their behavior.
- `corroboratorCapacity` — second parameter renamed; the caveat paragraph documenting this bug is
  deleted.
- `resolveClusterPolicy` is NOT exported from `src/index.ts` — nothing outside `db-p2p` needs it.

## Behavior an operator sees

| Configuration | Repair floor yardstick | Effect |
|---|---|---|
| nothing set | `clusterSize` = 10 | floor of two binds; a shrunken view gains nothing (**changed**) |
| `clusterPolicy.assumedClusterSize: 2` | 2 | two-node mesh self-repairs; replication factor untouched |
| `clusterSize: 2` | 2 | same, via the honest-size route |
| `assumedClusterSize: N` (any N) | N | sets both yardsticks — a declaration means it for both |

**The deliberate trade:** a genuine two-node mesh now needs *one* setting to self-repair. It still
transacts and votes with zero configuration — only repair is affected. This is narrower than the
pre-regression state and is stated in `reference-peer/README.md` and `docs/transactions.md`.

## Use cases to exercise when reviewing

1. **The regression itself.** Build a `CoordinatorRepo` from `resolveClusterPolicy({})`, give it a
   peer view of self + one peer, have that peer claim a higher revision. Must log
   `cluster-fetch:no-quorum` and adopt nothing. (`test/coordinator-repo-read-repair.spec.ts`, "does
   not relax the floor for an UNCONFIGURED node".)
2. **The commit-path mirror.** `createReconcileBlock` with the resolved default and a cohort list of
   one peer must not save. (`test/reconcile-block.spec.ts`, "still demands two corroborators on an
   UNCONFIGURED node".)
3. **The healing case is not lost.** `assumedClusterSize: 2` still repairs on both paths.
4. **The resolver's defaults.** `resolveClusterPolicy({})` → `assumedClusterSize === 2` AND
   `repairCorroborationClusterSize === 10`. (`test/cluster-policy.spec.ts`.)
5. **Small-mesh writes still work unconfigured** — the admission-gate default is unchanged;
   `test/cluster-membership-admission.spec.ts` was not touched and still passes.
6. **`mesh-harness`** passes `clusterSize: nodeCount` and no `assumedClusterSize`, so it lands on the
   `?? clusterSize` fallback — verified unchanged, all harness-driven specs pass.

## Validation run

- `npx tsc --noEmit -p tsconfig.json` in `packages/db-p2p` — clean.
- `yarn build` (all workspaces) — clean.
- `yarn test` (all workspaces) — all green, no failures. `db-p2p`: 1462 passing / 41 pending.
- `yarn lint` — clean.
- **Discrimination check:** temporarily reverting only the new default
  (`repairCorroborationClusterSize: declared ?? minAbsoluteClusterSize`) makes **4** of the new tests
  fail; restoring it makes them pass. The tests are not vacuous.

## Known gaps / what a reviewer should push on

- **No coupling assertion.** The two repair paths share `consensusConfig.repairCorroborationClusterSize`
  by proximity in `libp2p-node-base` plus a NOTE, exactly as before. If either ever resolves its own
  value they drift silently. A fail-fast check (like the existing `assertSuperMajorityCoupling`) would
  be stronger; it was out of scope and the pre-existing NOTE was kept and updated instead.
- **No end-to-end test at the node level.** The new specs assert `resolveClusterPolicy`'s output and
  feed it to the two consumers by hand. Nothing asserts that `createLibp2pNodeBase` actually threads
  the resolved value into a live `CoordinatorRepo`/`reconcileBlock` — that still needs booting a
  libp2p node. The extraction narrows the untested layer but does not close it.
- **`CoordinatorRepo`'s own `minAbsoluteClusterSize` default is 3**, while `resolveClusterPolicy` uses
  2. Pre-existing divergence, untouched by this ticket, but it is adjacent and worth an eye.
- **Degenerate declared values are not validated here.** `resolveClusterPolicy` passes
  `assumedClusterSize: 0 / NaN / Infinity` straight through; the admission gate floors them
  (`test/cluster-membership-admission.spec.ts` covers that) but `corroboratorCapacity` does not — e.g.
  `NaN` yields `Math.max(peers, NaN) = NaN`, and `quorumSize`'s `Math.min(2, NaN) = NaN` would make
  the floor `NaN` and every comparison false → permanent decline (fail-safe direction, but silent).
  Only reachable via an explicit operator declaration; the reference-peer CLI already rejects
  non-positive integers. Parked as a `NOTE:` comment, not a ticket — see below.
- **Docs were rewritten by hand across five files**; they describe the shipped behavior now, but the
  wording is unverified prose, not tested.

## Tripwires recorded (not tickets)

- A degenerate operator-declared `assumedClusterSize` (`NaN`/`Infinity`) reaches `corroboratorCapacity`
  unvalidated, where it silently freezes repair rather than being floored the way the admission gate
  floors it. Parked as a `NOTE:` comment inside `resolveClusterPolicy`
  (`packages/db-p2p/src/cluster/cluster-policy.ts`), which says to clamp there if another composition
  root starts accepting unvalidated config. Not a ticket: fail-safe direction, and unreachable through
  the reference-peer CLI, which validates positive integers.
