description: When two databases run on the same machines, a write that needs helper nodes can accidentally pull in a node belonging to the other database and then fail. Stop building a write's helper group from nodes that have not been confirmed to belong to this database.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCluster — the viability-floor `unknown` backfill, ~lines 574-612)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)', ~lines 690-867)
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Defense-in-depth: `findCluster` must not backfill `unknown` (possibly cross-network) peers into a write cohort

## Context

Residual hardening from the completed `multi-coordinator-cross-network-coordinator-selection` work.
That fix scopes cohort/coordinator selection to peers serving the writing network's namespaced
protocol, classifying ring peers (`membershipOf`) as:

- `serves` — peerStore advertises `${protocolPrefix}/cluster/1.0.0` or `${protocolPrefix}/repo/1.0.0` (or self),
- `foreign` — non-empty peerStore protocol list, none matching this network,
- `unknown` — empty/absent protocol list (identify not yet completed).

The hole is the `unknown` tier. A **permanently cross-network** peer and a **freshly-discovered
same-network** peer are indistinguishable at an instant: a cross-network peer's network-namespaced
`identify` never completes, so its peerStore protocol list stays empty forever — identical to a
same-network peer that simply hasn't finished `identify` yet.

`findCluster` currently backfills `unknown` peers to meet a viability floor of `min(2, clusterSize)`:

```ts
// packages/db-p2p/src/libp2p-key-network.ts  (current)
const nonSelfTarget = Math.max(0, this.clusterSize - 1)
const viabilityFloor = Math.min(2, this.clusterSize)
let others = serves.slice(0, nonSelfTarget)
if ((others.length + 1) < viabilityFloor) {
    others = [...others, ...unknown.slice(0, nonSelfTarget - others.length)]
}
ids = Array.from(new Set([selfId, ...others]))
```

Because the floor is `min(2, clusterSize)` (≤ 2), `(others.length + 1) < floor` is only ever true
when `serves` is empty — i.e. **self is the sole serving member present**. In exactly that case the
backfill pulls a cross-network `unknown` peer into the cohort; the coordinator then dials its
`/optimystic/<other-network>/repo/1.0.0`, which cannot negotiate, and the write fails:

```
Failed to get super-majority: 1/2 approvals (needed 2)
  cause = could not negotiate /optimystic/control-<other>/repo/1.0.0
```

Observed in Sereus when two parties each run a coordinator-eligible (`storage`) node on separate
control networks over a shared mesh (`strand-formation-e2e` Phase 2; `strand-membership-closed-strand`
e2e). This `storage` + `storage` cross-network topology is a real, needed use case (e.g. two
self-hosted `cadre-host` instances forming a cross-party strand) and is currently broken.

## Design decision (resolved)

**Drop the `unknown` backfill entirely under membership scoping.** The cohort becomes
`self + (serves, nearest-first, capped at clusterSize-1)`. No `unknown` peer is ever admitted on the
strength of the viability floor.

Rationale — the three options the source ticket asked us to weigh:

- **Chosen — floor relaxation (Option 3).** Contained to `findCluster`, no new dials/probes, no
  cross-subsystem plumbing. The backfill only ever fired when self was alone, so removing it produces
  a correct single-coordinator cohort in exactly that case. With the default `allowClusterDownsize:
  true` (`libp2p-node-base.ts:456,522`) a self-only cohort reaches consensus `1/1`
  (`superMajority = ceil(1 * threshold) = 1`) and the write succeeds immediately.
- **Rejected — confirm-before-backfill (Option 1).** A lightweight protocol probe *is* the dial we
  are trying to avoid; against a cross-network peer it hangs/fails, adding latency to every
  `findCluster` whenever such a peer sits in the band. It also reintroduces dialing an unconfirmed
  peer, contradicting the ticket principle.
- **Rejected — demote-on-failure (Option 2).** Its *first* attempt still produces the forbidden
  `could not negotiate` super-majority failure before demoting, and it requires threading dial-failure
  feedback from the consensus layer back into the classifier — a cross-subsystem change for no gain
  over Option 3.

Key fact making this safe: a genuine same-network peer's protocol dial **succeeds even before its
`identify` completes** (libp2p multistream-select negotiates the protocol on the stream directly), so
the only peers whose dial actually fails are cross-network ones. A legitimately-joining same-network
peer is therefore not "starved" — it is admitted as `serves` on a later write once `identify`
completes (and the coordinator/batch retry re-runs `findCluster`), and in the meantime a self-only
downsized write succeeds.

Known tradeoff (documented, accepted): when `allowClusterDownsize` is **false** and a fresh
same-network mesh is still mid-`identify`, a self-only cohort is rejected by `minRequiredSize`; the
write then depends on the batch/coordinator retry re-running `findCluster` after `identify` flips the
peer to `serves`, or fails fast. The fail-fast signal in that path (only cross-network peers remain,
self excluded) is delivered by the chained ticket `cross-network-coordinator-no-unknown-fallback`
via `NO_NETWORK_COORDINATOR`. This ticket alone fully fixes the **default** (`downsize: true`) config,
which is the observed Sereus case.

## Target change

In `findCluster`, replace the floor-backfill block with a serving-only cohort:

```ts
const nonSelfTarget = Math.max(0, this.clusterSize - 1)
const others = serves.slice(0, nonSelfTarget)
ids = Array.from(new Set([selfId, ...others]))
```

- Keep the `serves` / `unknown` / `foreignDropped` classification loop (still drives the existing
  `findCluster:membership` log line; `unknown.length` may still be logged for diagnostics).
- Leave the `membershipOverfetch()` over-fetch, the self-always-included rule, the address backfill,
  and the entire `protocolPrefix == null` no-op path untouched.
- Do **not** touch `findCoordinator`, `filterByMembership`, or `membershipOf` in this ticket — the
  coordinator-selection hole is the chained follow-up.

## Edge cases & interactions

- **Self alone + cross-network `unknown` in band (the bug):** cohort must be `[self]` only; the
  cross-network peer excluded. (Was: `[self, crossNet]` → negotiate failure.)
- **Fresh same-network peer mid-`identify`:** dropped from *this* cohort while `unknown`; re-included
  as `serves` on a later write once `identify` completes. Must not be permanently starved.
- **`serves` peers present:** unchanged — self + nearest `clusterSize-1` serving peers; `unknown`
  cross-network contaminant excluded (already covered by the "serving cohort already exists" test).
- **`foreign` member:** still always dropped, even with self alone (existing test must stay green).
- **`protocolPrefix` absent:** membership filter fully disabled → cross-network member retained
  exactly as before (regression guard test must stay green).
- **`clusterSize == 1`:** `nonSelfTarget == 0` → always self-only (unchanged).
- **Consensus interaction:** confirm a self-only cohort succeeds under `allowClusterDownsize: true`
  (`peerCount == 1`, `superMajority == 1`). Under `downsize: false` it is rejected by
  `minRequiredSize` — that fail-fast path is the sibling ticket's responsibility, not a regression
  introduced here.

## Acceptance

- A two-network shared-mesh write where the writer is the only serving peer present reaches a correct
  self-only (single-coordinator) cohort under the default `downsize: true` config — never a
  `could not negotiate /optimystic/<other-network>/repo/1.0.0` super-majority failure.
- A fresh same-network peer is still admitted (as `serves`) on a later write; single-network behavior
  and the `protocolPrefix`-absent no-op path are unchanged.
- `yarn workspace @optimystic/db-p2p test` (or the package's test command) passes, including the
  rewritten + new membership-scoping tests below.

## TODO

### Phase 1 — implementation
- Replace the viability-floor `unknown` backfill in `findCluster` with the serving-only cohort
  assembly shown above. Preserve classification, logging, over-fetch, self-inclusion, and the
  `protocolPrefix == null` no-op path.

### Phase 2 — tests (`packages/db-p2p/test/libp2p-key-network.spec.ts`)
- **Rewrite** `findCluster backfills not-yet-identified members when no serving peer exists (fresh
  mesh not starved)` → `findCluster does NOT backfill not-yet-identified members (self-only cohort)`:
  same fixture (two `unknown` members, no `serves`), expect cohort `=== [selfPeerId]` only; `freshA`
  and `freshB` excluded. Comment the rationale (downsize/retry handle the fresh mesh; an `unknown`
  could be a cross-network contaminant).
- **Add** the core regression: self is the sole serving peer and a cross-network `unknown` sits
  nearer the key (`assembleCohort` returns `[crossNet]`, peerStore protocols `[]`); expect cohort
  `=== [selfPeerId]`, cross-network excluded. Expected: no `could not negotiate` is ever reached
  because the peer is never placed in the cohort.
- Confirm existing tests stay green: "serving cohort already exists" excludes `unknown`; "sizes the
  cohort to clusterSize"; "always drops a foreign cohort member"; both `protocolPrefix`-absent
  regression guards.

### Phase 3 — docs
- Update the **Network-Membership Scoping** note in `packages/db-p2p/docs/cluster.md` (~line 619):
  replace "backfills `unknown` peers only below a small viability floor" with the new behavior —
  `findCluster` keeps self plus the nearest `serves` peers only and never admits an `unknown`
  (possibly cross-network) peer; a fresh same-network mesh relies on `allowClusterDownsize` (self-only
  write) and on re-selection once `identify` flips the peer to `serves`.
