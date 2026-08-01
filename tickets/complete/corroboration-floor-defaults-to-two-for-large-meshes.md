----
description: A node repairing a damaged copy of data used to accept a single peer's word by default, so anything that made the peer group look smaller than it really is could push bad data onto an unconfigured node. The repair check now has its own default and demands two independent peers unless the operator says the network really is that small.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, docs/transactions.md, docs/internals.md, packages/db-p2p/docs/cluster.md
----

# Complete: repair corroboration floor got its own size yardstick

## What shipped

One operator field, `clusterPolicy.assumedClusterSize`, fed two consumers with opposite failure
modes, and the composition root defaulted it to `2` for the sake of the permissive one:

- **Membership admission gate** (`cluster/cluster-repo.ts`) reads it only when the node has no
  confident network-size estimate. Too small = a partition-induced downsize slips past. Too large =
  the node refuses legitimate writes. Wants a permissive default.
- **Repair corroboration floor** (`corroboratorCapacity` in `cluster/quorum-restore.ts`, called on
  every read-repair and every commit-path reconcile). Too small = a shrunken, unauthenticated peer
  view buys a lone peer full trust. Too large = a block stays unrepaired (degraded, not dead). Wants
  a strict default.

At the shared default of 2, `corroboratorCapacity(visiblePeers = 1, yardstick = 2) = max(1, 1) = 1`,
so `quorumSize` capped its floor of two down to one and a single peer's claim was adopted.

**One operator knob, two resolved values.** New pure module
`packages/db-p2p/src/cluster/cluster-policy.ts` exports `resolveClusterPolicy(options)` — now the
only place the composition root's cluster defaults live:

```
declared = options.clusterPolicy?.assumedClusterSize     // undefined = operator said nothing

assumedClusterSize             = declared ?? 2            // admission gate — unchanged, permissive
repairCorroborationClusterSize = declared ?? clusterSize  // repair floor  — NEW, strict (default 10)
```

Threading: `libp2p-node-base.ts` calls `resolveClusterPolicy(options)` in place of its former inline
literal, and both repair paths take `repairCorroborationClusterSize` from that one result —
`createReconcileBlock` explicitly, `CoordinatorRepo` via the `{...consensusConfig}` spread. The
required dep on `createReconcileBlock` and the private field on `CoordinatorRepo` were renamed to
match; `CoordinatorRepo` resolves `cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize
?? policy.clusterSize`, the middle term deliberately preserving behaviour for direct constructors
(embedders, existing specs). `resolveClusterPolicy` is not exported from `src/index.ts`; nothing
outside `db-p2p` needs it.

| Configuration | Repair floor yardstick | Effect |
|---|---|---|
| nothing set | `clusterSize` = 10 | floor of two binds; a shrunken view gains nothing (**changed**) |
| `clusterPolicy.assumedClusterSize: 2` | 2 | two-node mesh self-repairs; replication factor untouched |
| `clusterSize: 2` | 2 | same, via the honest-size route |
| `assumedClusterSize: N` | N | sets both yardsticks — a declaration means it for both |

**The deliberate trade:** a genuine two-node mesh now needs *one* setting to self-repair. It still
transacts and votes with zero configuration — only repair is affected.

## Review findings

### Checked

The implement-stage diff (`e99e945`) was read in full before the handoff summary, then:

- **Every consumer of the renamed value.** `corroboratorCapacity` has exactly two production callers
  (`coordinator-repo.ts:615`, `reconcile-block.ts:169`); both take the new field, both are fed from
  the single `resolveClusterPolicy` result in `libp2p-node-base.ts`. `clusterMember`,
  `ClusterCoordinator` and `CoordinatorRepo` each still receive the unchanged permissive
  `assumedClusterSize`; the extra `repairCorroborationClusterSize` property rides along on the
  spread and is read by nobody that shouldn't read it (the `policy` object `CoordinatorRepo` builds
  for `ClusterCoordinator` deliberately does not copy it).
- **Backward compatibility for non-`libp2p-node-base` callers.** `src/testing/mesh-harness.ts` passes
  `clusterSize: nodeCount` and no `assumedClusterSize`, landing on the `?? clusterSize` fallback; its
  commit-path reconcile is a bespoke harness callback that never touches `corroboratorCapacity`.
  `src/index.ts` re-exports `coordinator-repo` only, so the renamed `ReconcileBlockDeps` field is not
  a public-API break.
- **Behaviour arithmetic for real topologies.** A 3-node mesh is unaffected (each node sees 2 peers,
  so capacity was already 2). Only the "exactly one other peer visible" case changes — which is both
  the vulnerability and the two-node healing case. Confirmed by hand against `quorumSize`.
- **Docs, treated as stale until read**: all five changed doc files, plus the files the change
  *should* have touched — `packages/db-p2p/docs/cluster.md`'s configuration snippet and
  `docs/correctness.md`.
- **Validation** (all after the review edits below): `npx tsc --noEmit` in `db-p2p` clean;
  `yarn build` clean; `yarn lint` (`eslint .`) clean; `yarn test` across all workspaces —
  **0 failing**, `db-p2p` 1462 passing / 41 pending.
- **Discrimination check, re-run independently.** Reverting only the new default to
  `declared ?? minAbsoluteClusterSize` and running `db-p2p` tests gives **1458 passing / 4 failing**;
  restoring gives 1462 / 0. The new tests are not vacuous — the implementer's claim reproduces.

### Fixed in this pass (minor)

- **`NodeOptions` restated `ClusterPolicyOptions` field-for-field**
  (`libp2p-node-base.ts`, `cluster/cluster-policy.ts`). Two hand-maintained copies of the same shape
  with ~35 lines of near-duplicate doc prose, and — because `resolveClusterPolicy(options)` consumes
  them structurally — a knob added to one would compile and be *silently dropped* by the other. Now
  `NodeOptions = ClusterPolicyOptions & { … }`, with the richer prose kept and moved to the single
  declaration. This converts the "did the composition root see every knob?" question from something
  needing a test into a compile-time guarantee.
- **`--super-majority-threshold` help text and README said the default is `0.67`; it is `0.75`**
  (`reference-peer/src/cli.ts:769`, `reference-peer/README.md:201`). Unset means `undefined`, which
  `resolveClusterPolicy` resolves to `DEFAULT_SUPER_MAJORITY_THRESHOLD = 0.75`. Both files are in
  this ticket's scope and the numbers were operator-facing, so they were corrected here; the
  README's worked example (`Math.ceil(3 × 0.75) = 3`) reaches the same conclusion.
- **`packages/db-p2p/docs/cluster.md`'s "Configuration in libp2p-node.ts" snippet was a stale
  literal** immediately below the section this ticket rewrote — it showed a `coordinatorRepo(...)`
  config object that no longer exists. Replaced with the actual `resolveClusterPolicy` →
  four-consumer wiring.

### Filed (major)

- `backlog/bug-docs-quote-superseded-super-majority-default` — the `0.67` drift above is not local
  to reference-peer. `docs/correctness.md` states it five times *and* uses it to evaluate the
  partition-safety product as `2 · 0.75 · 0.67 = 1.005`, calling that "almost no margin" and telling
  the reader to re-derive before changing either default; at the real `0.75` it is `1.125`. The same
  figure is repeated in `cluster-repo.ts:993`. Root cause is one settled fact (the constant moved to
  `0.75` in ticket `6.2-implement-supermajority-threshold-coupling`) that several documents
  contradict — one ticket, sites enumerated. Checked the board first: no open ticket touches those
  files for this reason.

### Tripwires (recorded, not ticketed)

- **Degenerate declared `assumedClusterSize`** (`NaN`/`Infinity`) reaches `corroboratorCapacity`
  unvalidated and silently freezes repair, where the admission gate would have floored it. Verified
  the implementer's `NOTE:` is present at the resolution site in `cluster/cluster-policy.ts` and
  agree with the disposition: fail-safe direction, and unreachable through the reference-peer CLI,
  which validates positive integers.
- **Both repair paths share the yardstick by proximity, not by assertion.** The pre-existing `NOTE:`
  in `libp2p-node-base.ts` was correctly updated to name the new field. A fail-fast coupling check in
  the spirit of `assertSuperMajorityCoupling` would be stronger; conditional on either path ever
  resolving its own value, which is exactly what the NOTE says to watch for.
- **`minAbsoluteClusterSize` is `2` from `resolveClusterPolicy` but `3` in `ClusterMember` and
  `CoordinatorRepo`'s direct-constructor fallbacks.** Pre-existing and coherent at the node level
  (both sides get `2`), but the interface's documented default says otherwise. Parked as a bullet in
  `packages/db-p2p/docs/cluster.md` beside the new wiring snippet — it is an architectural note with
  no single code site to comment on.

### Checked and clean — explicitly

- **Correctness of the resolution logic**: nothing found. The precedence chain, the two defaults, and
  the "a declaration sets both" rule are each pinned by a spec, and the unconfigured-node specs feed
  a config that carries *both* `assumedClusterSize: 2` and `repairCorroborationClusterSize: 10`, so
  they genuinely exercise the precedence rather than the absence of the old field.
- **Resource cleanup and error handling**: no findings, and none expected — the diff adds one pure
  function with no I/O, no allocation, no async, and no new failure path. Stating this rather than
  leaving the category silent.
- **Test coverage** beyond the happy path: the new specs cover the regression on both repair paths,
  the healing counterpart on both, the resolver's defaults, pass-through of the remaining knobs, and
  purity. The pre-existing `cluster-membership-admission.spec.ts` (untouched) still pins that the
  permissive gate default is unchanged. No gap found worth a new spec.
- **File size**: `libp2p-node-base.ts` is 1582 lines (`wc -l`) — large for one file, but this change
  *reduced* it by 38 lines and it is a composition root whose job is breadth. Not filed: splitting it
  is a design task this diff neither caused nor is the right occasion for.

### Left open, with reason

- **No node-level end-to-end assertion.** The specs assert `resolveClusterPolicy`'s output and feed
  it to the two consumers by hand; nothing asserts that `createLibp2pNodeBase` threads the resolved
  value into a live `CoordinatorRepo`/`reconcileBlock`, which needs booting a libp2p node. The
  extraction narrows that untested layer and the `ClusterPolicyOptions` intersection above closes the
  "a knob got dropped in transit" half of it, but the wiring itself remains untested. Not filed as a
  ticket — it is the general "the composition root has no integration test" gap, not something this
  change introduced, and a ticket scoped to one field of it would be misleading.
