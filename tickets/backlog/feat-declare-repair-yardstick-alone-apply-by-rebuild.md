description: Let an application that knows how many machines are in a user's group tighten the block-repair safety check as the group grows, without also raising the bar for writes; and settle that a group which grows or shrinks applies the new number by rebuilding its node, not through a live reconfiguration API.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/src/libp2p-node-base.ts (NodeOptions doc only), packages/db-p2p/docs/cluster.md, docs/optimystic.md, docs/internals.md, docs/architecture.md, packages/reference-peer/src/cli.ts (optional flag)
difficulty: medium
tradeoffs: A maintainer could say the single shared setting was deliberate ("declaring your real size means it for both consumers"), that hosts should declare the honest count for both and accept the stricter write floor, and that the restart contract is already implied by the existing persistence docs — in which case only the stale downstream caveat in cluster.md needs fixing.
----

# Declare the repair yardstick on its own, and apply a changed size by rebuilding the node

## The requirement, and what already works

The maintainer's requirement: *strands need to be able to dynamically scale from 1 to n,
relatively seamlessly.* A "cadre" is one user's group of machines sharing data; the supported
growth path (recorded in `docs/architecture.md` → *Supported deployment sizes*) is one phone, then a
backup machine added by a **user** tapping "add a backup", then pairing with other groups of any
size. The downstream consumer is Sereus (`../sereus/packages/cadre-core`), where a "strand" is a
per-collection node a cadre runs beside its control node.

Most of 1 → n already works and must not be re-ticketed:

- **Cohort width follows the peers that exist.** `clusterSize` is a *target* breadth; the key
  network keeps `min(serving peers, clusterSize − 1)` non-self members and `allowDownsize` lets a
  cohort shrink to the mesh that exists. Growing from 1 to `clusterSize` machines needs no setting to
  change.
- **Founding data gets copied when the group grows** — `2-replicate-owned-blocks-when-the-cohort-grows`
  (the `grown` arm of `RebalanceMonitor`); and every commit under current code carries a commit
  proof, a lone machine's included (`1-mint-solo-cohort-commit-proof`), so proof-carrying data
  repairs at any group size with no configuration.
- **A group of one or two reads quietly and repairs** — `1-solo-node-read-repair-never-settles`,
  `1-small-cohort-arming-rule`. The genesis admission gap (Optimystic#10) is closed.

What is left is one number and one lifecycle question, described next.

## Verified facts this ticket rests on

1. **The size references are fixed at construction.** `resolveClusterPolicy`
   (`packages/db-p2p/src/cluster/cluster-policy.ts`) runs exactly once, at
   `libp2p-node-base.ts:518`. Its outputs are captured as `private readonly` fields —
   `ClusterMember.assumedClusterSize` (`cluster/cluster-repo.ts:366`) and
   `CoordinatorRepo.repairCorroborationClusterSize` (`repo/coordinator-repo.ts`, constructor) — and
   handed as a plain number into `createReconcileBlock` (`libp2p-node-base.ts:851`). There is no
   setter and no re-resolution; `assertClusterSizeCoupling` (`cluster/cluster-size-coupling.ts`)
   runs at startup only. Changing the number means building a new node.

2. **One operator field sets two yardsticks that want different values.** `clusterPolicy.assumedClusterSize`
   feeds (a) the membership admission gate's low-confidence fallback — a coordinator's declared peer set
   must have at least `max(2, ceil(0.75 × assumed))` members or the member refuses to vote
   (`cluster-repo.ts` → `admitMembership` / `admissionFloor`) — and (b) the repair corroboration
   floor, via `repairCorroborationClusterSize` and `corroboratorCapacity` in `cluster/quorum-restore.ts`.
   The module doc in `cluster-policy.ts` explains why their *defaults* diverge (permissive 2 for the
   gate, strict `clusterSize` for repair), but an *explicit* value still sets both, and
   `ResolvedClusterPolicy.repairCorroborationClusterSize` is not declarable from `ClusterPolicyOptions`.
   Pinned by `test/cluster-policy.spec.ts` ("an explicit assumedClusterSize sets BOTH").

3. **The downstream consumer has already worked around the freeze — by pinning the number at the
   minimum.** This contradicts the framing that "the downstream seam does not exist"
   (`gotchoices/sereus#2` is stale on this point): `../sereus/packages/quereus-plugin-sereus/src/cluster-size.ts`
   now declares `assumedClusterSize: 2` in both `CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY`,
   fixes control breadth at 16, and makes strand breadth configurable (`CadreNodeConfig.strandClusterSize`,
   default 4). Its own comment (lines 34–36) names Optimystic's construction-time freeze as the reason
   the number is a constant rather than the live member count. The consequence: a cadre of five machines
   runs with `repairCorroborationClusterSize = 2`, so `corroboratorCapacity = max(visiblePeers, 1)`, and
   a routing-shrunk view of one peer relaxes the corroboration floor to a single voter — the exact
   exposure the declared yardstick exists to close, made permanent for every group size. Sereus chose 2
   for both because raising the single field to the honest N would also raise the *write* floor to
   `ceil(0.75 × N)` declared peers whenever the network-size estimate is unconfident, and a cadre of
   phones cannot promise that many awake machines. (Whether the confident path dominates in a small
   cadre is unmeasured; the point is that the host cannot choose.)

So the direction a growing group cannot take today is **raising** the repair yardstick — the safe
direction — and the reason it cannot is half "fixed at construction" and half "the only field that
raises it also raises something the host cannot afford to raise".

## Recommendation: rebuild the node; do not add a mutation API

**A host that learns a new group size tears down and rebuilds its node with the new number.** This
ticket makes that path *supported and documented* and adds the one option that makes the rebuilt
declaration honest. It does **not** add a runtime setter.

Why rebuild wins, against the mutation alternative that was considered and rejected:

- **The trust question answers itself.** The only party that may change the number is the host
  process that constructed the node, on the strength of its own authenticated membership records
  (in Sereus: owner-signed `CadrePeer` vouchers in the control database). Nothing arriving over the
  network may touch it — that is the settled reason the number is declared rather than observed
  (`cluster-policy.ts` module doc; the scope section of the small-cadres decision), and it is not
  reopened here. A construction-time argument enforces that boundary for free: there is no surface
  for a remote instruction to reach. A setter would have to reconstruct the same boundary ("in-process
  callers only") and then defend it against every future refactor that exposes the object.
- **Every consumer holds the number as an immutable snapshot, by design.** Four sites read it
  (member gate, coordinator read-repair, reconcile, and the startup coupling assertion). A live change
  either turns those into reads of a shared mutable cell — creating a new class of "which value did
  this pass see" bugs and demoting `assertClusterSizeCoupling` from a startup fact to a runtime
  invariant — or rebuilds those four objects, which is a restart wearing a different name.
- **In-flight semantics are trivial under a rebuild and hard under mutation.** A pend awaiting
  approval, a repair pass mid-consult, a read inside an armed read-repair window: under a rebuild all
  of them are aborted and retried, which the system already handles for every crash and every
  hibernation wake. Under mutation each needs a rule for "started under N, finishing under N+1".
- **Restarts are already routine downstream, so there is no cost to save.** Sereus tears down and
  rebuilds every strand's libp2p node on each wake from hibernation
  (`StrandInstanceManager.resumeStrand` → `buildStrandRuntime`), and its `ResumeStrandOverrides`
  already re-resolves one volatile input (the discovery seed) at resume. Storage is owned by the host
  and outlives the rebuild. Adding a second volatile input to that path is a few lines; a mutation API
  is a new protocol.
- **Applying late costs nothing new.** The direction that matters is raise-only, and a group that
  has not yet applied the higher number is running at exactly the value it runs at today. So the new
  number can take effect at the *next* rebuild — hibernation wake, app restart — with no forced
  restart at the moment of "add a backup".

### Who may change the number, and how the node knows it is authentic

The host, in-process, at construction. The node does not authenticate the value; it trusts its
constructor the same way it trusts `privateKey` and `storage`. The host's obligation — stated in the
docs this ticket writes — is that the value comes from *its own authenticated membership state*
(machines enrolled by a signed operation and not since removed), never from a network observation and
never from an end user. A local attacker who can edit that state can already edit the config file
that declares the number today; the trust proposition is unchanged.

### Raise or lower

Both, because both come from the same authenticated source: a group shrinks when the owner removes a
machine (a signed removal), and the next rebuild declares the smaller count. Two bounds keep the
lowering direction honest, and the docs must say so:

- The declared value never goes below `minAbsoluteClusterSize` (2) — the corroboration floor's own
  floor — and `corroboratorCapacity` still takes the **max** of the declared value and the peers
  actually visible, so a stale-low declaration is never *worse* than today's permanent 2.
- A machine removed but not yet reaped from the records over-declares, which only costs repair of
  **proof-less** data (a floor the group cannot meet declines, degraded rather than dead); proof-carrying
  data — everything committed under current code — repairs regardless.

### What a rebuild costs — the restart contract the docs must state

Verified against `libp2p-node-base.ts`, `cluster-repo.ts`, `coordinator-repo.ts`:

- **Durable, survives:** every block, every persisted commit proof, executed-transaction markers and
  in-flight coordinator/participant state *if* the host wired `transactionStateStore`
  (`ClusterMember.recoverTransactions` / `CoordinatorRepo.recoverTransactions`). Sereus wires none, so
  for it in-flight transactions are lost — which is already its behaviour on every wake and crash.
- **In-memory, reset:** the read-repair freshness window (`lastSeenCommitMs`), recorded doubt
  (`unsettledAheadClaims`), the responsibility cache, the rebalance monitor's responsibility snapshot.
  All reset in the *safe* direction: the first read of each held block after a rebuild consults the
  cohort, so doubt is rediscovered rather than lost; the first rebalance check re-pushes to the whole
  non-self cohort (bounded and documented as cheap in `2-replicate-owned-blocks-when-the-cohort-grows`).
- **Peers' view:** a pend this node coordinated is abandoned; the abandoned-pend rule
  (`1-abandoned-pend-holds-the-block`) drops refused pends immediately and ages out live ones on the
  staleness window, so a vanished coordinator does not wedge a block.
- **Teardown ordering** is the concern of `debt-node-factory-wiring-steps-own-their-teardown`; startup
  rollback is pinned by `test/startup-rollback.spec.ts`. Neither is changed here.

### Which numbers move together

They do not, and the docs should say why in one place:

- `clusterSize` (replication factor / target breadth) is a **network-wide constant** — every node on
  a network must agree, because the admission gate's confident path compares a coordinator's declared
  set against the member's own derived width, and a node holding a wider value rejects a narrower
  declared set as below-floor. Changing it is a coordinated rollout of every node, a different problem,
  and out of scope. For 1 → n up to `clusterSize` it does not need to change at all.
- The **repair yardstick** is per-node and safe for nodes to disagree on (each protects only its own
  reads). It should track the enrolled machine count; a value above `clusterSize` is harmless because
  the floor is already capped at `CORROBORATION_FLOOR`.
- The **admission yardstick** is per-node but disagreement costs availability (one member admits a
  set, another refuses it). Its honest value trades write availability under low confidence for
  self-shrink defence, and that trade is the host's to make per network. This ticket gives the host the
  choice; it does not make it.

## Arm 1 — declare the repair yardstick independently (code)

Add an optional field to `ClusterPolicyOptions.clusterPolicy` (name for the planner; the resolved
field is already `repairCorroborationClusterSize`, so mirroring it is the obvious choice) with this
resolution order in `resolveClusterPolicy`:

```
repairCorroborationClusterSize = clusterPolicy.<new field>
                              ?? clusterPolicy.assumedClusterSize
                              ?? clusterSize
assumedClusterSize (admission)  = clusterPolicy.assumedClusterSize ?? minAbsoluteClusterSize
```

- `assumedClusterSize` alone keeps today's behaviour exactly (sets both) — every existing spec stays
  green untouched.
- The new field never touches the admission yardstick or `clusterSize`.
- Clamp a degenerate declared value (0, negative, NaN, Infinity) to `minAbsoluteClusterSize` here,
  per the existing `NOTE:` in `resolveClusterPolicy` that says to clamp at this site rather than in
  each consumer once another composition root accepts unvalidated config — a host-derived count is
  exactly that.
- The `repair-fault-tolerance` advisory's "undeclared" arm treats the new field as a declaration.
- `test/cluster-policy.spec.ts` gains: new field alone moves only the repair yardstick; new field
  plus `assumedClusterSize` — new field wins for repair, `assumedClusterSize` still sets admission;
  clamp cases; advisory silence when declared.
- `reference-peer/src/cli.ts` may grow a matching flag beside `--assumed-cluster-size`; optional.

## Arm 2 — record the decision and the contract (docs and one NOTE)

- An accepted-tradeoff `NOTE:` at `resolveClusterPolicy`: *resolved once, no runtime mutation; a
  host that learns a new size rebuilds the node; revisit only if a deployment appears where a rebuild
  is measurably disruptive (for example a server-profile node holding thousands of blocks whose
  post-rebuild consult burst shows up in profiles).*
- `docs/optimystic.md` → *Deployment Sizes* → "Who declares it": say which yardstick the membership
  count should feed (repair), that it is applied by rebuilding the node, and the restart contract
  above in operator terms.
- `packages/db-p2p/docs/cluster.md`: the recommendation block and its two qualifications. The first
  qualification — "Sereus's `CadreNode` hardcodes `clusterSize: 3` and builds its `clusterPolicy`
  inline without exposing `assumedClusterSize`" — is **false today** and must be replaced with the
  accurate statement: Sereus declares `assumedClusterSize: 2` for every group size because raising
  the shared field would raise the write floor, which is the gap Arm 1 closes.
- `docs/internals.md` (the size-table paragraph that repeats the recommendation) and
  `docs/architecture.md` → *Supported deployment sizes*: same correction, one sentence each.

## Not in scope

- Deriving any yardstick from network observation — settled, not reopened
  (`feat-admission-floor-from-observed-cohort-high-water-mark` keeps the large-undeclared-deployment case).
- Making `clusterSize` change without a coordinated restart of every node on the network.
- Any runtime setter on `ClusterMember`, `CoordinatorRepo`, or `NodeOptions`.
- The Sereus-side derivation itself — filed separately in that repo as
  `feat-repair-yardstick-tracks-enrolled-machines-on-rebuild`, which depends on Arm 1 shipping.

## Edge cases and interactions

- New field declared **below** 2, or below the visible cohort: clamped / overridden by the max in
  `corroboratorCapacity` — the relaxed branch stays reachable only by a group that is genuinely that small.
- New field declared **above** `clusterSize`: allowed; the floor is already capped at
  `CORROBORATION_FLOOR`, so the extra only makes the "undeclared" advisory arm irrelevant. Document, don't reject.
- `assumedClusterSize` declared and new field absent: unchanged behaviour (both set). Pinned.
- A node rebuilt with a **lower** repair value mid-episode of a `cohort-too-small` deadlock: the
  once-per-episode suppression state lives in `unsettledAheadClaims` and is reset by the rebuild, so
  the deadlock is re-reported once if it still holds — correct, and worth one spec line.
- The mesh harness (`src/testing/mesh-harness.ts`) passes `clusterPolicy` through verbatim; a mesh
  can now declare the two yardsticks apart, which `debt-mesh-harness-policy-and-commit-path-untested`
  may want to exercise. No change required there.
