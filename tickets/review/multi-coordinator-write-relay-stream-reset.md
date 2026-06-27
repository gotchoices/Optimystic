description: Two storage nodes that reach each other only through a relay can now agree on a write even when the relayed connection used to collect the second node's approval is briefly disrupted — the coordinator retries that approval instead of failing the whole write, and prefers a direct connection when one exists.
prereq:
files:
  - packages/db-core/src/cluster/structs.ts (new promiseImmediateRetries config knob)
  - packages/db-p2p/src/repo/coordinator-repo.ts (defaults promiseImmediateRetries)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (updateMember helper; collectPromises + broadcastMergedRecord use it)
  - packages/db-p2p/src/libp2p-key-network.ts (connect() prefers a direct connection over a limited/relayed one)
  - packages/db-p2p/test/cluster-coordinator-promise-retry.spec.ts (NEW deterministic regression — authoritative proof)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (NEW connect() prefer-direct cases)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts (forcing function — now passes-or-skips)
  - packages/db-p2p/test/multi-coordinator-write.integration.spec.ts (direct-TCP control — still passes)
  - tickets/fix/p2p-fret-rpc-over-limited-connection.md (follow-up filed during implement)
----

# Multi-coordinator write over a relayed (limited) connection — implement handoff

## What was wrong (confirmed root cause)

A super-majority write across two same-keyspace coordinators collects one promise
locally and one from the peer over the cluster RPC. When that peer is reachable
only through a relay, the RPC rides a circuit-relay ("limited") libp2p connection
that can be reset transiently (per-circuit cap / reservation lapse, or a lingering
limited connection that survives a DCUtR upgrade to direct). The reset surfaces on
the dialer as a `StreamResetError`. Two distinct gaps turned that transient blip
into a hard consensus failure:

1. **Asymmetric retry.** `commitTransaction`'s broadcast phase already had a
   per-peer in-line retry (`broadcastMergedRecord` + `commitBroadcastImmediateRetries`)
   precisely to absorb a transient stream error. The **promise** phase
   (`collectPromises`) had **no** such retry, so a single relayed reset dropped the
   peer, leaving 1/2 approvals and failing `Math.ceil(2 * 0.67) = 2` super-majority.

2. **Connection selection.** `Libp2pKeyPeerNetwork.connect()` reused the first
   `status==='open'` connection — which could be a limited/relayed one even when a
   direct connection also existed (the brief window after DCUtR upgrades a relayed
   link to direct). It then opened the RPC stream on the soon-to-be-reset circuit.

## The fix (3 surfaces)

- **`collectPromises` immediate retry** — extracted a shared `updateMember(peerIdStr,
  record, immediateRetries, phase)` helper on `ClusterCoordinator`. It invokes the
  local cluster exactly once (a local throw is a real fault, not transport churn) and
  retries a **remote** `ClusterClient.update` up to `immediateRetries` times before
  surfacing the error. `collectPromises` now uses it with the new
  `promiseImmediateRetries` knob; `broadcastMergedRecord` was refactored onto the
  same helper (behavior preserved). The commit-**collection** loop was deliberately
  left un-retried (it already has the broadcast retry + scheduled-retry timer as
  backstops; adding a retry there changed asserted call-counts and gains nothing).

- **`connect()` prefer-direct** — now filters to open connections, prefers a
  **direct** (non-`/p2p-circuit`, no `limits`) connection, and only falls back to a
  limited connection (still with `runOnLimitedConnection: true`) when that is the
  only open path. New `isLimitedConnection()` helper detects relayed connections via
  the `limits` field with a `/p2p-circuit` multiaddr fallback.

- **Config knob** — `promiseImmediateRetries?: number` added to
  `ClusterConsensusConfig` (db-core), defaulted to `1` in `coordinator-repo.ts`
  (sibling to `commitBroadcastImmediateRetries`).

## How to validate

Deterministic (authoritative — run in the default suite, no gating):

    npm test --workspace @optimystic/db-p2p
    # or targeted:
    node --import ./register.mjs node_modules/mocha/bin/mocha.js \
      test/cluster-coordinator-promise-retry.spec.ts \
      test/libp2p-key-network.spec.ts \
      test/cluster-coordinator.spec.ts \
      test/cluster-coordinator-supermajority.spec.ts --reporter spec

- `cluster-coordinator-promise-retry.spec.ts` models the relayed reset directly:
  one peer's promise RPC throws a StreamResetError on its first call.
  - `retries=1` (default) → both promises collected → 2-of-2 → commit. **Pass = fix.**
  - `retries=0` → same reset fails super-majority (`/super-majority/`). **The bug.**
- `libp2p-key-network.spec.ts` → `connect()`: prefers a direct connection over a
  limited one; detects `/p2p-circuit` without a `limits` field; falls back to a
  limited-only path.

Integration (gated on `OPTIMYSTIC_INTEGRATION=1`, real libp2p — slow):

    OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p

- `multi-coordinator-write.integration.spec.ts` (direct-TCP control) — **passes**
  (both cases, ~0.5 s each).
- `multi-coordinator-write-relay.integration.spec.ts` — **passes-or-skips, never
  red-fails** (observed 2/3 pass at ~320 ms, 1/3 skip at 40 s). It now finds a block
  whose cohort includes the relay-only coordinator B and drives the write across the
  relay; when FRET doesn't stabilize in budget it `this.skip()`s.

Results this run: default db-p2p suite **1044 passing / 36 pending / 0 failing**;
full monorepo `yarn build` (tsc, incl. `test/`) clean.

## Honest gaps the reviewer should weigh (tests are a floor, not a ceiling)

- **The relay integration spec does NOT deterministically reproduce the reset.** It
  passes `applyDefaultLimit:false` (lifts the 128 KiB cap) and the promise payload is
  tiny, so the relayed RPC succeeds *with or without the fix* — it is a positive
  smoke test ("a multi-coordinator write across a relay reaches consensus"), not a
  red-without-fix repro. The **deterministic unit tests are the real regression
  guard.** A reviewer wanting a red-without-fix integration repro would need
  `applyDefaultLimit:true` + enough sustained traffic to trip the cap mid-RPC (hard
  to set up in-process), or the DCUtR lingering-limited-connection topology.
- **The `connect()` prefer-direct path is unit-tested but not exercised by a live
  DCUtR integration test.** Proving the lingering-limited-connection selection in a
  real node needs the (slow, flaky) `dcutr-direct-upgrade` topology. The unit tests
  assert the selection logic directly instead.
- **FRET-over-relay flakiness / external limitation.** During implement we found
  `p2p-fret`'s wire RPCs (neighbors/ping/maybe-act/leave) open streams **without**
  `runOnLimitedConnection: true`, so two relay-only peers can't exchange FRET state
  *directly* over the limited link — convergence only happens **transitively** via the
  relay (a full FRET participant directly connected to both). That makes the relay
  spec's FRET stabilization bimodal/flaky (hence the skip path). Filed as
  `fix/p2p-fret-rpc-over-limited-connection` (external package; lands upstream + a
  version bump). It is a robustness gap, not a hard blocker when a directly-connected
  FRET intermediary exists.
- **`negotiateFully:false` left unchanged.** The ticket flagged it as a candidate
  relayed-circuit race. We did not change it: the prefer-direct + immediate-retry
  combination already covers the observed failure, and flipping it risks regressing
  the warm-relay-reuse path other specs depend on. Worth a deliberate look if the
  reviewer wants belt-and-suspenders.
- **Sereus end-to-end not re-run** (no `../sereus` access in this run). The source
  ticket's two flows — second `storage` node join + cross-party strand formation —
  remain unverified against a live Sereus relay topology and should be checked there.

## Supported-topology decision (carried from the source ticket)

A 2-node coordinator cluster IS effectively supported today: the direct-TCP control
spec proves 2-of-2 reaches consensus, and the `validateSmallCluster` fallback admits
`peerCount(2) >= minAbsoluteClusterSize(2)`. This fix keeps it working over relays
too (Sereus needs the second `storage` node to join and write). We did **not** add a
fast-fail "cluster too small" guard — recommended only as a fallback if a clean relay
fix had proven intractable, which it did not.

## Suggested review focus

- `updateMember` semantics: local invoked exactly once; remote retried; error
  surfaced after exhaustion (so `collectPromises`' existing `.catch` still records the
  peer as failed and reports reputation). Confirm no double-counting of promises.
- `isLimitedConnection` detection coverage across the libp2p version in use
  (`@libp2p/interface@^3` — is `Connection.limits` populated for relayed conns?). The
  `/p2p-circuit` multiaddr fallback is the safety net; verify it holds for the dial
  shapes Sereus produces.
- Whether the commit-collection phase also warrants the immediate retry (we argued
  no — backstops exist — but it is a judgment call).
