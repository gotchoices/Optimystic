description: A node decides which peers belong to its network from the protocols libp2p's peer store says each peer serves, and any connected peer can put this network's protocols into that list — by advertising them, or just by opening a stream on one, which libp2p records even when the stream is then refused. Such a peer is admitted to the node's storage groups and is sent its writes. Add an optional, embedder-supplied membership predicate that both the key network and FRET honour.
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`servesThisNetwork`, `membershipOf`, the `findCluster` membership filter, `rememberedServing`)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions`; where FRET is constructed; `authorizeInboundStream` / `inboundAuthorization` as the precedent for a node-level predicate)
  - packages/db-p2p/src/inbound-authorization.ts
  - p2p-fret (outside this repo; sibling checkout `../Fret`, `packages/fret/src/service/fret-service.ts` `classifyByProtocols` and its `peer:identify` / `peer:update` listeners)
  - libp2p 3.3.11 `dist/src/connection.js` (`onIncomingStream`: `peerStore.merge` of the negotiated protocol runs before the handler lookup)
  - docs/internals.md (§ Inbound Stream Authorization; § Third-Party Address Learning)
----

# A peer joins a storage group by claiming the network's protocols

Reported by sereus (sereus-sam), ranked fourth, security. Their full write-up: `C:\projects\sereus\tickets\blocked\stranger-joins-the-control-cohort-by-advertising-protocols.md` (read it; this ticket summarizes).

## What happens

Two decisions on a node rely on the peer store's protocol list for a peer:

- FRET marks a peer a ring member when its listed protocols include this network's FRET protocols (`classifyByProtocols`, on `peer:identify` and every `peer:update`).
- The key network keeps a cohort candidate when its listed protocols include this network's `cluster` or `repo` protocol (`servesThisNetwork` / `membershipOf`).

A peer can get those protocols into another node's peer store two ways, neither of which `authorizeInboundStream` stops:

- **Opening a stream.** libp2p's `onIncomingStream` merges the negotiated protocol into the remote peer's record before it looks up the handler. The authorization gate runs at the handler and resets the stream, but the record is already written.
- **Advertising.** A peer registers this network's protocol ids on its own node, and identify announces them.

Measured by sereus (2026-10-07, their `control-stream-authz.integration.ts`): after an outsider O opened one refused stream on each members-only protocol of member A, A's peer store listed O as serving all nine, A's FRET table had O as `member`, and A's `keyNetwork.findCluster` for a control block returned `[O, M, A]`. Not yet observed: A actually sending O a cluster request, though that follows from the cohort. A peer that disconnects afterwards with no address stays a live FRET member (FRET 1.0.2 may change this; see the uncommitted `p2p-fret` bump note in `.release-notes.pending.md`).

Consequence for sereus: their control database (party membership, addresses, strand list) is disclosed to a stranger who holds a connection, and every control write pays a dead cohort member.

## Proposed shape (sereus's recommendation)

`NodeOptions.isNetworkMember?(peerId: string): boolean` — synchronous, optional, absent means today's behaviour exactly.

- The key network treats a peer that fails it as not serving (`membershipOf`), whatever its protocols, and never restores it from `rememberedServing`.
- FRET classifies a peer that fails it as `foreign`.
- A "reclassify this peer" call the embedder makes when its membership changes (sereus's `refreshMembershipGate` already runs on every change), so an admitted member is not stuck as foreign and a removed one leaves.

Sereus passes it on control nodes only; strand nodes pass nothing.

## For planning

- **Split by repository.** The key-network half is in this repo and protects cohort selection on its own (FRET membership alone does not get a peer into `findCluster` if `membershipOf` refuses it — confirm). The FRET half needs a `p2p-fret` change and release; that is a dependency outside this repo → its own `blocked/` ticket with the proposed FRET API, unless the plan shows the key-network half fully closes the disclosure, in which case the FRET half is hardening and can be `backlog/`.
- Decide whether `authorizeInboundStream` and `isNetworkMember` should be one predicate or two. They answer different questions (may this peer touch my database vs. is this peer one of us), and sereus's predicate omits the protocol argument; but an embedder supplying only the first is still exposed — document that, or derive one from the other.
- Consider whether the key network should stop trusting peer-store protocol lists for membership at all when no predicate is given (e.g. require identify to have completed), since a refused stream is enough to forge the list. That is a behaviour change for every deployment; if it is warranted, route the decision to `blocked/`.
- Edge cases: predicate throws (fail closed, logged); predicate answer changes while a cohort lookup is cached (`RESPONSIBILITY_TTL_MS`, 60 s); self; persisted serving verdicts restored at start for peers the predicate now refuses.

## TODO

- Research and confirm the key-network half closes cohort admission; plan implement ticket(s).
- File the FRET half as `blocked/` (external dependency) with the proposed API.
- Docs: a § in internals.md beside Inbound Stream Authorization.
