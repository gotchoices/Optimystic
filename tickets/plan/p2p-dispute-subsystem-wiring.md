----
description: The dispute/arbitration feature is built but not actually connected on a running node, so no node can raise or answer a dispute; decide whether to connect it now or clearly mark it as deliberately switched off.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts (service registration ~382-497; DisputeService construction ~918-921), packages/db-p2p/src/dispute/service.ts (disputeProtocolService factory / DisputeProtocolService handler), packages/db-p2p/src/dispute/dispute-service.ts (initiateDispute ~130), packages/db-p2p/src/repo/cluster-coordinator.ts (disputed-record path ~312-332), backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
difficulty: medium
----

# The dispute subsystem is entirely inert in the live node

## Current state

`DisputeService` is constructed when `dispute.disputeEnabled` is set
(`libp2p-node-base.ts:918-921`), but the subsystem is never actually reachable:

- The `/dispute/1.0.0` inbound handler (`DisputeProtocolService`, produced by the
  `disputeProtocolService` factory in `dispute/service.ts`) is **never registered**
  in the node's libp2p services. No live node answers arbitration challenges.
- `initiateDispute` (`dispute/dispute-service.ts:130`) is **never called** from
  the cluster path — only from tests. No live node ever starts a dispute, even
  though the coordinator's disputed-record path
  (`repo/cluster-coordinator.ts:312-332`) already computes the evidence.

Consequence: the elaborate vote / arbitrator-set-binding verification in
`dispute/invalidation.ts` guards a path nothing reaches.

## The decision this ticket must resolve

Either (a) wire the subsystem live, or (b) make the deliberate staging explicit
and documented at both wiring sites. This needs a design call because full
activation is **not** a free wiring change: the related hardening ticket
`backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring`
establishes that network-originated invalidation/dispute application must not go
live until the arbitrator set can be independently re-derived (recompute or trust
anchor), or a peer minting throwaway keypairs can forge a passing resolution.

So activation is gated on that anchoring work, while the cheap, no-design action —
annotating the staging so the inertness is intentional and discoverable rather
than an accidental gap — is available today.

## What the plan should produce

- A resolved recommendation (default: keep the subsystem dormant near-term, and
  emit an implement ticket that **annotates the deliberate staging** at both
  wiring sites — the service-registration area in `libp2p-node-base.ts` and the
  disputed-record path in `cluster-coordinator.ts` — cross-referencing the
  arbitrator-anchoring gate), plus
- the sequencing for eventual live activation (register the handler when
  `disputeEnabled`, invoke `initiateDispute` from the coordinator's
  disputed-record path), chained via `prereq:` behind the arbitrator-anchoring
  hardening work so activation cannot land before its security precondition.

Do not emit a live-activation implement ticket that bypasses the anchoring gate.
