description: The peer-discovery ring still counts any peer that claims this network's protocols as a ring member, even when the application has said that peer is not one of us. Once the storage layer obeys the application's membership check, the ring should obey it too, so strangers stop serving as routing hops and as members of the publish/subscribe groups built on the ring.
prereq: network-membership-predicate-gates-block-pushes
architecture: docs/internals.md#inbound-stream-authorization
files:
  - ../Fret/packages/fret/src/index.ts (`FretConfig`; sibling repository, needs a `p2p-fret` release)
  - ../Fret/packages/fret/src/service/fret-service.ts (`applyMembershipSignal`, `classifyByProtocols`, `noteInboundRpc`, the `peer:identify` / `peer:update` listeners, `seedFromPeerStore`)
  - ../Fret/docs/fret.md (the planned `AdmissionPolicy` hook under admission control; *Network-scoped admission*)
  - packages/db-p2p/src/libp2p-node-base.ts (where FRET is constructed; would pass the gate)
  - packages/db-p2p/src/cohort-topic/host.ts (non-root tiers use `fret.assembleCohort`)
tradeoffs: Needs a release of a separate library and an API shape that library's own planned admission design should own; with this repo's two membership tickets landed no database contents reach a refused peer, so what remains is routing and reactivity-metadata hardening that a maintainer may reasonably defer until a deployment shows strangers in its ring.
----

# FRET honours the network membership predicate

## Context

`NodeOptions.isNetworkMember` (ticket `network-membership-predicate-gates-cohort-selection`) lets an embedder declare which peers belong to its network. This repo gates every path that sends block contents or accepts restored content with it (that ticket and `network-membership-predicate-gates-block-pushes`). FRET is left out: `FretService.classifyByProtocols` still promotes a peer to ring `member` when its peerStore protocol list names one of this network's FRET protocols, and `noteInboundRpc` promotes any peer that dials one. Both are forgeable — libp2p records a stream's negotiated protocol in the peerStore before the handler (and any authorization) runs, and a peer can simply advertise the ids. Sereus measured an outsider classified `member` this way (`C:\projects\sereus\tickets\blocked\stranger-joins-the-control-cohort-by-advertising-protocols.md`).

What a refused-but-ring-member peer can still do once both db-p2p tickets land:

- be a FRET routing hop (`RouteAndMaybeAct`) and drop or misroute cohort-topic traffic;
- be in a non-root cohort-topic cohort (`fret.assembleCohort` in `packages/db-p2p/src/cohort-topic/host.ts`), holding subscriber registrations and seeing reactivity notifications (collection id, revision, commit certificate — metadata, not block contents) and matchmaking registrations;
- occupy the key network's over-fetch band, which can shrink a cohort when refused peers outnumber the band's headroom near a key (the `NOTE:` at `membershipOverfetch`);
- stay a live ring member after it disconnects with no address (sereus's `fret-evicts-an-address-less-peer-that-disconnects`; FRET 1.0.2 may already change this).

## Proposed FRET API (recommended default)

- `FretConfig.isMember?(peerId: string): boolean` — synchronous, optional; absent means today's behaviour. Consulted inside `applyMembershipSignal`, the existing single choke point: a positive signal (`identify-member`, `rpc-success`, `rpc-inbound`) for a peer that fails it sets `foreign` instead of `member`; a throw counts as failing. Self is exempt.
- `FretService.reclassify(peerId: string): void` — re-runs classification for one peer from its current peerStore list and the predicate, so an embedder whose membership changes (sereus's `refreshMembershipGate`) can promote a newly admitted peer stuck at `foreign` and demote a removed one at once rather than at the next identify or tick.
- db-p2p passes the same `NetworkMembershipGate` it builds for the key network into FRET's config and exposes a node-level "membership changed for these peers" call that forwards to `reclassify`.

Alternatives: (a) implement FRET's planned `AdmissionPolicy` hook (`docs/fret.md`, admission control) instead — richer (credential, connection origin, admit/deny/default) but its design is still open there, and this need is the narrow deny case; the predicate can later become one input to it. (b) Do nothing in FRET and filter every FRET consumer in db-p2p as the two db-p2p tickets do — cohort-topic tiers and routing hops cannot be filtered from outside, because FRET chooses them internally.

## Expected behaviour

A peer the predicate refuses is never a FRET ring member, routing candidate, cohort member, anchor, or neighbour advertised in a snapshot, whatever protocols it lists or dials; a peer that becomes admitted is a member after `reclassify` (or its next identify), and one that becomes refused leaves at once.
