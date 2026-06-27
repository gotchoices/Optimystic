description: Two storage nodes that can only reach each other through a relay fail to agree on a write, because the relayed connection used to collect the second node's approval breaks. Direct (non-relayed) two-node writes already work; only the relayed path is broken.
prereq:
files:
  - packages/db-p2p/test/multi-coordinator-write.integration.spec.ts (NEW — passing direct-TCP forcing function; the negative control)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts (NEW — relay repro scaffold; currently skips when FRET-over-relay does not converge)
  - packages/db-p2p/test/util/relay-topology.ts (relay/browser-shaped node helpers)
  - packages/db-p2p/src/libp2p-key-network.ts (connect() — connection selection + runOnLimitedConnection/negotiateFully for the inter-coordinator dial)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (collectPromises / commitTransaction / broadcastMergedRecord — where the remote promise is collected)
  - packages/db-p2p/src/cluster/client.ts (ClusterClient.update — the cluster-protocol RPC)
  - packages/db-p2p/src/protocol-client.ts (ProtocolClient.processMessage — the dial + send + first()-read + stream.close() lifecycle)
  - packages/db-p2p/src/cluster/service.ts (ClusterService.handleIncomingStream — receive side; already returns an error envelope instead of aborting)
  - packages/db-p2p/test/circuit-relay-long-lived.spec.ts (precedent: circuit-relay default-limit reset of a relayed stream)
difficulty: hard
----

# Multi-coordinator write fails when the inter-coordinator promise stream runs over a relayed (limited) connection

## What is actually going on (read this first — the original hypothesis was falsified)

The source `fix/` ticket assumed that "two coordinators on the same keyspace" is
itself enough to reproduce the super-majority failure. **That is not true on a
clean optimystic build.** A new forcing-function test stands up exactly two
storage coordinators on the same keyspace over real libp2p (direct TCP,
`clusterSize:2`, `superMajorityThreshold:0.67` → 2-of-2 required) and drives a
write:

- `multi-coordinator-write.integration.spec.ts` — **passes** (≈200 ms). Both the
  bootstrap-node-driven write and the joiner-driven, looped, back-to-back writes
  reach 2-of-2 and commit. The inter-coordinator promise is collected fine over a
  **direct** connection.

So the defect is **not** the super-majority math (already known — see the source
ticket), and **not** the bare "2 coordinators" path. It is conditional on
*something the clean direct-TCP test does not have*. The strongest remaining
suspect, matching the Sereus topology where this was found (two always-on
`storage` nodes behind NAT that reach each other only through a reference/relay
node), is that **the inter-coordinator stream runs over a circuit-relay
("limited") connection and is reset.**

The chain that puts the stream on a limited connection:

```
A.NetworkTransactor.pend
  └─ dials coordinator (A or B) over /optimystic/<net>/repo/1.0.0
       └─ CoordinatorRepo.pend → ClusterCoordinator.collectPromises
            ├─ local promise  (always collected → 1)
            └─ remote promise: ClusterClient.update(B)
                 └─ Libp2pKeyPeerNetwork.connect(B, /optimystic/<net>/cluster/1.0.0)
                      └─ open.newStream([proto], { runOnLimitedConnection: true, negotiateFully: false })
                         # ^ over a /p2p-circuit connection when A↔B is relay-only
```

`@libp2p/circuit-relay-v2` resets a relayed stream once a per-circuit cap is hit
(`applyDefaultLimit` → `Limit { data: 128 KiB, duration: 2 min }`); see
`circuit-relay-long-lived.spec.ts` and the `relayServerInit` note in
`libp2p-node-base.ts`. A small promise RPC is well under 128 KiB, so a plain
data-cap reset is unlikely to be the whole story — candidate mechanisms to pin
down in Phase 1/2 include: a half-open / not-yet-upgraded relayed connection
being reused by `connect()`; `negotiateFully:false` racing multistream-select on
a freshly-reserved circuit; a relay reservation expiring/renewing mid-RPC; or
DCUtR tearing down the relayed connection just as the stream is opened.

## Why this is `implement/` and not `fix/`

The fix agent could not get the failure to reproduce locally despite real effort:
the direct path works, and the relay repro (`...-relay.integration.spec.ts`)
gets all three nodes up and circuit-reserved but **FRET cohort assembly between
two relay-only peers does not converge in-process within 40 s**, so the actual
2-of-2-over-relay write is not yet exercised (the spec `this.skip()`s at that
precondition rather than red-failing). Phase 1 below is therefore "finish the
reproduction"; Phase 2 is the fix. Treat the hypothesis as strong-but-unconfirmed
— if Phase 1 shows the relayed path ALSO succeeds, pivot (see "If the relay
hypothesis is wrong").

## Architecture notes for the implementer

- The receive side is already hardened: `ClusterService.handleIncomingStream`
  catches application throws and returns a structured **error envelope** (so the
  coordinator sees the real cause, not an opaque `StreamResetError`) and only
  `stream.abort()`s on genuine transport/framing faults. A *transport-level*
  reset (relay killing the circuit) bypasses this entirely — it surfaces as a
  `StreamResetError` on the **dialer** (the coordinator) inside
  `ProtocolClient.processMessage`.
- `collectPromises` already wraps each remote promise in a `.catch` that records
  the peer as failed; one failed remote promise on a 2-node cluster drops the
  coordinator to 1/2 and the write fails `super-majority`. (The source ticket's
  "0/2" vs "1/2" depends only on whether the coordinator was A or B and whether
  the local promise also faulted — secondary to the root cause.)
- The commit phase already grew `commitBroadcastImmediateRetries` +
  `broadcastMergedRecord` (one in-line re-attempt per peer) precisely to recover
  transient stream errors on the *commit* broadcast. The **promise** phase
  (`collectPromises`) has **no** such per-peer immediate retry — a single relayed
  reset there is fatal. That asymmetry is a prime fix surface.
- `Libp2pKeyPeerNetwork.connect()` reuses any `status==='open'` connection (incl.
  a limited/relayed one) and opens the new stream with
  `runOnLimitedConnection:true, negotiateFully:false`. Connection *selection*
  (prefer a direct connection when one exists; treat a reset on a limited
  connection as retryable) is the other prime fix surface.

## Decision to make explicit (carry into the review handoff)

The source ticket asks whether a 2-node coordinator cluster is a **supported
topology** (`minAbsoluteClusterSize=3`; a 2-node cluster only reaches consensus
via the `validateSmallCluster` fallback). The direct-TCP test proves 2-of-2
*can* work, so the topology is effectively supported today. Either keep it
working over relays too (the fix here), or, if small clusters are deemed
unsupported, fail fast with an explicit "cluster too small / not a coordinator
for this keyspace" error instead of a generic stream-reset super-majority
timeout. Recommendation: keep it working (Sereus needs the second `storage` node
to join and write); only add the fast-fail as a guard if a clean relay fix proves
intractable.

## If the relay hypothesis is wrong

If Phase 1 reproduction shows the relayed 2-of-2 write succeeds, the remaining
suspects (in order) are: (1) a join-time connection-state race narrower than the
joiner-loop test already covers; (2) the cross-network selection issue — but that
is split into its own ticket (`multi-coordinator-cross-network-coordinator-selection`,
case (b)). Re-scope this ticket toward whichever the completed repro implicates,
and document the pivot in the review handoff.

## TODO

Phase 1 — finish the relay reproduction (forcing function)
- Get FRET cohort assembly to converge between two relay-only ("browser-shaped")
  storage peers in `multi-coordinator-write-relay.integration.spec.ts` (e.g. give
  the relay a FRET role both peers learn through, dial peer↔peer circuit addrs
  explicitly — already attempted — and/or extend the convergence budget / use
  `networkManager.getCluster` readiness instead of raw `assembleCohort`). Remove
  the `this.skip()` once the write step is genuinely reached.
- Confirm the failure: the 2-of-2 write over the relayed connection should fail
  the super-majority check with a `StreamResetError` (or "could not negotiate")
  cause. Capture the exact error + which connection (`/p2p-circuit`) the failing
  stream used. If it does NOT fail, see "If the relay hypothesis is wrong".

Phase 2 — fix the inter-coordinator promise path over limited connections
- Make `collectPromises` resilient to a transient remote-promise stream reset the
  same way the commit broadcast is: a bounded per-peer immediate retry (reuse the
  `commitBroadcastImmediateRetries` knob or add a sibling) before counting the
  peer as failed.
- In `Libp2pKeyPeerNetwork.connect()`, prefer a **direct** open connection over a
  limited/relayed one for the cluster/repo RPC when both exist; only fall back to
  the limited connection (with `runOnLimitedConnection:true`) when that is the
  only path. Re-evaluate `negotiateFully:false` on freshly-reserved circuits.
- If relay caps are implicated, ensure the reference/relay nodes Sereus uses set
  `relayServerInit.reservations.applyDefaultLimit:false` (trusted-cluster posture)
  and document the requirement.

Phase 3 — validate
- `multi-coordinator-write-relay.integration.spec.ts` passes (write reaches 2-of-2
  over the relay) and `multi-coordinator-write.integration.spec.ts` still passes.
- `npm test --workspace @optimystic/db-p2p` green (the new specs are gated on
  `OPTIMYSTIC_INTEGRATION=1`, so confirm both the default run AND the integration
  run).
- Build clean: `tsc` over `packages/db-p2p`.
- Review handoff records: the confirmed root cause, the supported-topology
  decision, and (if Sereus reproduction is rerun) the `../sereus` flows from the
  source ticket — second `storage` node join + cross-party strand formation.
