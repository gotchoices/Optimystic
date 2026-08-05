----
description: A node used to decide "how many peers should this group have" in more than one place, and those places could disagree. Separately, a deployment too small to repair itself got no warning. Both are fixed, and the review corrected a warning message that overstated which deployments are affected.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/cluster-size-coupling.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, docs/transactions.md, docs/internals.md, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/cluster-size-coupling.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts
----

# What shipped

## Arm A — one resolved cluster size per node

`createLibp2pNodeBase` calls `resolveClusterPolicy(options)` exactly once, early, and the resulting
`consensusConfig.clusterSize` feeds every consumer that previously applied its own fallback:
`networkManagerService`, `new Libp2pKeyPeerNetwork(...)` (which used to inherit its own constructor
default of 16 whenever `clusterSize` was unset), and `initSpreadOnChurnMonitor`. No
`options.clusterSize` read survives anywhere in `packages/db-p2p/src` outside `resolveClusterPolicy`
itself and the test mesh harness.

`cluster/cluster-size-coupling.ts` adds `assertClusterSizeCoupling(resolvedClusterSize, consumers)`,
called once at node construction against new `effectiveClusterSize` getters on
`Libp2pKeyPeerNetwork` and `NetworkManagerService`. A future edit that reintroduces a private
fallback on either throws at startup instead of shipping a silent divergence.

## Arm B — startup advisory when repair cannot self-heal

`resolveClusterPolicy` logs `assumed-cluster-size-unset` once per node when
`clusterPolicy.assumedClusterSize` is absent and `clusterSize > minAbsoluteClusterSize`, naming the
resolved `repairCorroborationClusterSize`, the corroboration floor, the smallest deployment that can
still heal, and the fix — including that declaring `assumedClusterSize` does not lower the
replication factor.

The three decline logs (`cluster-fetch:no-quorum`, `reconcile:no-rev-quorum`,
`reconcile:no-content-quorum`) now all carry `repairCorroborationClusterSize`, the required quorum,
and the responder/carrier count.

`docs/transactions.md` and `docs/internals.md` both cross-link the startup advisory from their
`repairCorroborationClusterSize` paragraphs.

No default changed.

## Review findings

**Checked:** the implement-stage diff read before the handoff summary; every cluster-size consumer in
`packages/db-p2p/src` re-derived by grep (`options.clusterSize`, `clusterSize ?? `,
`new Libp2pKeyPeerNetwork`, `resolveClusterPolicy`); the arithmetic of the new warning re-derived
against `quorumSize` / `corroboratorCapacity` in `quorum-restore.ts`; import-cycle check on the new
`cluster-policy` → `quorum-restore` edge (none — `quorum-restore` imports only `db-core` and
`multiformats`); the four docs that mention `clusterSize` or `repairCorroborationClusterSize`; test
coverage against each of the ticket's four deliverables; `yarn lint` (clean) and the `db-p2p` suite
(1531 passing, 0 failing, 44 pending — pre-existing skips).

**Fixed in this pass (minor):**

- **The startup warning stated a false threshold.** It said a cohort running "fewer than
  `repairCorroborationClusterSize` machines" — 10 by default — can never repair. Untrue:
  `corroboratorCapacity` caps only the *floor* of two, so an unconfigured `clusterSize: 10`
  deployment running four machines repairs normally. Only a cohort that cannot field two peers
  besides the reader — fewer than three machines — is permanently stuck, which is exactly what the
  original ticket asked the message to say and what `docs/transactions.md` already said. An advisory
  that overstates its blast radius is worse than none, since operators learn to ignore it. Message
  rewritten around `CORROBORATION_FLOOR + 1`; a new `minimumSelfHealingDeployment` field carries the
  number structurally, and a spec now pins both it and the message wording so the claim cannot drift
  back.
- **`resolveClusterPolicy`'s doc comment still claimed "Pure".** It now has a logging side effect.
  Reworded to state the one side effect and why it belongs there.
- **The ticket's fourth deliverable — "the knob named at the decline" — shipped untested.** Added a
  payload assertion to the existing unconfigured-node decline spec in
  `coordinator-repo-read-repair.spec.ts`, and a new `reconcile:no-rev-quorum` decline spec in
  `reconcile-block.spec.ts` (the reconcile decline logs had no log-capture coverage at all).
- **`docs/internals.md` was left stale.** It is the internals home for
  `repairCorroborationClusterSize` and already enumerates this path's log tags, but the implement pass
  only cross-linked `docs/transactions.md`. Added the same one-sentence pointer, stating the
  three-machine threshold.

**Filed as a new ticket (major):** `backlog/bug-second-key-network-built-with-defaults`.
`packages/reference-peer/src/cli.ts:418` and
`packages/quereus-plugin-optimystic/src/optimystic-adapter/key-network.ts:46` each construct a
**second** `Libp2pKeyPeerNetwork` from bare defaults on a node that already has one attached — so the
reference peer's read/write path selects cohorts at width 16 with network scoping disabled, while the
same node's consensus path uses the resolved 10 with scoping on. This is the identical defect this
ticket closed inside `createLibp2pNodeBase`, still live in two production composition roots that sit
outside it. Filed at the representation rung rather than as two one-line patches: the root cause is
`Libp2pKeyPeerNetwork`'s silent `clusterSize = 16` constructor default plus an untyped
`node.keyNetwork`, which together make rebuilding easier than reusing. The implement handoff flagged
these two sites as a judgment call; the judgment is that they are the same bug, not a scope question.
Site-claim grep run over the board first — four open tickets touch `libp2p-key-network.ts`, none
covers this.

**Recorded as a tripwire, not a ticket:** the advisory fires only for the *undeclared* case. An
operator who declares an `assumedClusterSize` larger than the cohort they actually run is equally
unable to repair and gets no warning. That is deliberate — a declaration is an explicit assertion and
`resolveClusterPolicy` has no observed cohort to contradict it with — and becomes cheap to warn about
only if `feat-admission-floor-from-observed-cohort-high-water-mark` lands. Parked as a `NOTE:` at the
warning site in `cluster/cluster-policy.ts`.

**Noticed, deliberately not filed:**

- `packages/db-p2p/src/libp2p-node-base.ts` is 1602 lines (`wc -l`), and this change added ~15. It is
  a composition root, where length is largely inherent — splitting it is a real architectural task
  with no measured harm behind it today, and no open ticket claims it. Recording the measurement here
  rather than opening a size ticket on the strength of a 15-line diff.
- `CoordinatorRepo` is a third cluster-size consumer with a private `cfg?.clusterSize ?? 10` fallback
  and is not covered by `assertClusterSizeCoupling` — it is constructed through a per-transaction
  factory, so there is no single instance to assert against at startup. It is spread wholesale from
  `consensusConfig` at its one real call site and carries a comment saying so, so it cannot diverge
  without someone editing that spread.
- The decline logs compute `required` from `revClaims.length` / `hashCandidates.length` while the
  selectors count *distinct* peer ids. Identical today (one claim per peer, built from the target
  list), so the logged number is the one that was applied; not worth a defensive rewrite.

**Empty categories:** no findings on resource cleanup (the new code allocates nothing and holds no
handles; the two integration specs stop their nodes in `finally`), error handling (the one new throw
is the intended fail-fast, at construction, with both values named), or type safety (no new `any`;
the coupling helper is typed on a narrow structural interface).

## Still open

`feat-admission-floor-from-observed-cohort-high-water-mark` (backlog) would subsume the whole
two-yardstick split by deriving the reference from observation rather than being told it. This ticket
was deliberately the cheap mechanical interim.
