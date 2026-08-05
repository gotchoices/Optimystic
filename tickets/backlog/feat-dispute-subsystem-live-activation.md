description: Turn the built-but-switched-off dispute/arbitration feature on for real running nodes so a node can actually raise and answer a dispute — but only after the network can independently re-derive who the legitimate referees are, otherwise a node making fake identities could forge a passing outcome.
prereq: invalidation-live-wiring-requires-arbitrator-set-anchoring
files:
  - packages/db-p2p/src/libp2p-node-base.ts (services map ~643 dormancy note; DisputeService construction ~1217-1282)
  - packages/db-p2p/src/inbound-authorization.ts (authorizeInboundStream — must cover the dispute stream when it is registered)
  - packages/db-p2p/test/inbound-stream-authorization.spec.ts (per-service test table — a fifth entry)
  - docs/internals.md (§ Inbound Stream Authorization), packages/db-p2p/docs/repo.md (protocol table)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (disputed-record path ~319-339)
  - packages/db-p2p/src/dispute/service.ts (disputeProtocolService factory / DisputeProtocolService handler)
  - packages/db-p2p/src/dispute/dispute-service.ts (initiateDispute ~137; handleChallenge revalidate ~274; maybeInvalidate → onInvalidation ~225)
  - packages/db-p2p/src/dispute/invalidation.ts (verifyInvalidationCertificate — the arbitrator-set-binding verification the resolution path relies on)
difficulty: hard
tradeoffs: It is a security-sensitive activation of a subsystem nobody is currently asking for, gated behind anchoring work that has not started — a maintainer could reasonably leave the subsystem dormant indefinitely rather than take on its adversarial surface.
----

# Wire the dispute subsystem live on a running node

## What this is

The dispute/arbitration subsystem is built end-to-end but inert on every live
node (documented, deliberately, by `annotate-dispute-subsystem-dormancy`). This
ticket switches it on: a live node should be able to **start** a dispute when its
rejection is overridden, **answer** a dispute when selected as an arbitrator, and
**apply** the proven-invalid outcome as a durable reversal.

## Why it is gated (do not bypass)

Dispute activation is NOT a free wiring change. A dispute that resolves
`challenger-wins` originates a durable transaction reversal
(`dispute-service.ts` `maybeInvalidate` → `onInvalidation` → the invalidation
subsystem). So this work is the **origination side of the same live-invalidation
path** that `invalidation-live-wiring-requires-arbitrator-set-anchoring` gates,
and it inherits the identical security precondition:

> Network-originated reversal must not go live until the arbitrator set can be
> independently re-derived (validated live recompute — layer 2) or trust-anchored
> (layer 3). Otherwise a peer minting throwaway Ed25519 keypairs self-signs a
> synthetic cohort + a 2/3 super-majority and forges a passing resolution that a
> degradation-mode verifier accepts.

Hence `prereq: invalidation-live-wiring-requires-arbitrator-set-anchoring`. This
ticket stays in `backlog/` until that anchoring work lands; it must not be
promoted to a working stage before then. When planned, it should be split into
`prereq:`-chained implement tickets (handler registration, coordinator
invocation, callback wiring) rather than one oversized change.

## Scope when activated (the three gaps to close)

- **Register the inbound handler, behind the permission check.** Add a `dispute:`
  entry to the libp2p `services` map in `libp2p-node-base.ts` (mirroring
  `cluster` / `repo` / `sync`), wiring `disputeProtocolService({ protocolPrefix })`
  to the constructed `DisputeService`, so the node answers
  `/optimystic/<network>/dispute/1.0.0`. Guard it on
  `options.dispute?.disputeEnabled` so the default-off behavior is preserved.
  Note the construction currently happens post-`node.start()` (~1217); the handler
  needs the DisputeService instance, so resolve the ordering (either construct
  earlier, or register via the registrar post-construction the way other post-start
  wiring is done). **See "Who may make this node vote?" below — the authorization
  decision must be settled before the handler is registered, not after.**
- **Invoke `initiateDispute` from the coordinator.** From the disputed-record
  path (`cluster-coordinator.ts:319-339`), after `record.disputed = true` and
  `disputeEvidence` are set, call `DisputeService.initiateDispute(record,
  evidence)`. Decide the coordinator→DisputeService handle (injection vs. the
  `(node as any).disputeService` surface) and whether the call is awaited on the
  commit path or fired best-effort off it (a dispute round must not block or fail
  the already-super-majority-approved commit).
- **Wire the resolution + revalidation callbacks.** Pass `onInvalidation` (so
  `maybeInvalidate` originates the durable reversal through the cluster) and
  `revalidate` (so an arbitrator's `handleChallenge` produces a substantive vote
  instead of always `inconclusive`) into the `DisputeService` construction. The
  `onInvalidation` path is exactly what the anchoring gate protects — it must run
  through the recompute-capable verify (`verifyInvalidationCertificate` with an
  injected `recomputeArbitratorSet` or trust anchor), never the accept-and-log
  degradation tier.

## Edge cases & interactions (the adversarial surface the implementer must cover)

- **Forged-resolution rejection (the headline case).** A peer minting keypairs
  self-signs a synthetic arbitrator cohort + super-majority. With anchoring in
  place the applying node MUST reject it. Mirror the invalidation headline test
  ("rejects sybil-key votes when recompute exposes a forged arbitrator set") for
  the dispute origination path.
- **Challenger ∈ original cohort.** `initiateDispute` and the verify path must
  confirm the challenger was a member of the committed transaction's cohort — the
  `arbitratorSet` binding proves the set is legitimate, not that the challenger is
  entitled to challenge. (See the same residual in the anchoring ticket.)
- **Arbitrator-set determinism across nodes.** `selectArbitrators` today adds the
  local node's own id to `exclude`, which is a no-op only because the initiator is
  itself in `originalPeers`. A verify-path recompute must reconstruct `exclude`
  from `proof.challengerPeerId` + original cluster, never the verifier's own id,
  or re-derivation diverges (already flagged in `libp2p-node-base.ts:1181-1187`).
- **Commit path isolation.** A dispute round (arbitrator dial, vote collection,
  timeout) must never block, delay, or fail the commit that already reached
  super-majority. Partial failure (no arbitrators reachable, selection throws,
  round times out) must leave the commit intact — `initiateDispute` already
  returns `undefined` on these; confirm the call site honors that.
- **One dispute per transaction / fire-once invalidation.** `disputedTransactions`
  and `invalidatedTransactions` guard against re-initiation and double-reversal;
  confirm they hold under concurrent disputed commits and node restart (in-memory
  sets do not survive restart — decide whether that is acceptable or needs
  persistence).
- **Handler start/stop lifecycle.** The registered handler must `unhandle` on
  `node.stop()` (the service `stop()` does this) and compose with the existing
  stop-wrapper chain without leaking the protocol registration.
- **Cascade / degradation preservation.** A `challenger-wins` reversal must pass
  through the recompute-capable gate before any cascade children reuse the proof
  (invariant carried from the anchoring ticket).
- **Engine-health self-suppression.** `initiateDispute` skips when the local
  engine is unhealthy (`engineHealth.isUnhealthy()`); confirm that path is exercised
  so an unhealthy node does not spam disputes it cannot substantiate.

## Who may make this node vote? (decide before registering the handler)

A node embedding this library can supply one function deciding which remote peers may open the
"database" conversations with it — reading blocks, writing blocks, syncing history, and transferring
block copies. It is supplied once at construction (`createLibp2pNode({ authorizeInboundStream })`), and
a peer it turns down has its connection attempt torn down before the node reads anything the peer sent.
That work (`2-feat-inbound-stream-authorization-hook`) was scoped, deliberately and explicitly, to
those four protocols.

Dispute is a fifth conversation of the same kind: a remote peer opens it to challenge another peer's
behavior, and the node answers by *signing a vote*. It is **not** covered by the permission check.
Today that is harmless — the handler is not registered at all, so no peer can open the stream (verified:
`libp2p-node-base.ts` ~643 and ~1217 both carry `[dispute-subsystem-dormant]` notes saying the service
is constructed but absent from the services map). **The moment this ticket registers the handler, the
gap becomes real**, which is why the decision belongs here rather than in a separate ticket.

The question: is being asked to vote on a dispute something only admitted peers should be able to do?

- **For gating it:** an application that has decided a peer is not part of its network should not have
  that peer able to make its node produce signed votes. Votes are cryptographic statements; producing
  them for strangers is both work and attributable output.
- **Against gating it:** disputes are, by nature, about misbehaving peers, and the peer reporting one
  may legitimately be someone the node has not admitted. A permission check written as "only my members"
  would silently drop those reports.

A reasonable resolution is to gate it but keep it separately controllable, so an application can close
its database while leaving dispute reporting open. Settle this before writing the registration — the
plumbing is a handful of lines either way, structurally identical to the cluster handler (same file
layout, same "one request, one response per connection" shape).

Expected behaviour, whichever way it goes:

- With no permission function supplied, dispute streams are served exactly as the rest of this ticket
  describes.
- With one supplied and the decision being "gate it", a refused peer's dispute stream is torn down
  before the challenge is decoded, no vote is signed, and the refusal is logged on this node with the
  peer's identity and the reason — matching what the other four surfaces already do.
- The documentation must stop describing dispute as ungated by omission: `docs/internals.md` §
  Inbound Stream Authorization and the protocol table in `packages/db-p2p/docs/repo.md` both currently
  name it as *not* covered, and `libp2p-node-base.ts:304` says the same in a comment.
- The per-service test table in `packages/db-p2p/test/inbound-stream-authorization.spec.ts` is built so
  a fifth service is one more entry: for every service it asserts a refused peer's operation never
  reaches the underlying subsystem and no response is written. A dispute entry should assert the same,
  plus specifically that no vote is signed.

## Related

- Security gate: `invalidation-live-wiring-requires-arbitrator-set-anchoring`
- Documented dormancy this activates: `annotate-dispute-subsystem-dormancy`
- Round progression (out of scope here): `design-dispute-synchronous-escalation`
- Membership epoch (out of scope here): `design-cluster-membership-agreement`
