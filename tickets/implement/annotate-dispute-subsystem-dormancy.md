description: The dispute/arbitration feature is fully built but switched off on every running node; add clear code comments at the two switch-off points so the next reader sees the off state is deliberate — and why — instead of mistaking it for a forgotten wire-up.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts (services map ~435-554; DisputeService construction ~1160-1196)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (disputed-record path ~319-339)
  - packages/db-p2p/src/dispute/service.ts (disputeProtocolService factory / DisputeProtocolService — the unregistered handler)
  - packages/db-p2p/src/dispute/dispute-service.ts (initiateDispute ~137; maybeInvalidate call ~225)
  - tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring.md (the security gate to cross-reference)
  - tickets/backlog/feat-dispute-subsystem-live-activation.md (the future live-activation ticket to cross-reference)
difficulty: easy
----

# Annotate the deliberate dormancy of the dispute subsystem

## Why this ticket exists (no behavior change)

The dispute/arbitration subsystem is built end-to-end but is inert on every live
node. Nothing in the code says the off state is intentional, so the next reader
(or reviewer) can reasonably read it as an accidental missing wire-up and "fix"
it — which would prematurely open a forgeable-reversal vector (see the security
gate below).

This ticket is **comments only**. It does not register the handler, does not call
`initiateDispute`, and changes no runtime behavior. Its whole job is to make the
dormancy **intentional and discoverable** at the exact sites where someone would
otherwise wire it live, each cross-referencing the security precondition and the
future live-activation ticket.

## The inertness, precisely (three independent gaps)

A live node never reaches the dispute path because all three of these hold:

1. **Inbound handler never registered.** `disputeProtocolService`
   (`dispute/service.ts`) produces the `/optimystic/<network>/dispute/1.0.0`
   stream handler (`DisputeProtocolService`), but it is **not** in the libp2p
   `services` map in `libp2p-node-base.ts` (~435-554). No live node answers a
   `challenge` or `resolution` message.
2. **Dispute never initiated.** The coordinator's disputed-record path
   (`cluster-coordinator.ts:319-339`) sets `record.disputed = true` and computes
   `disputeEvidence`, but never calls `DisputeService.initiateDispute`
   (`dispute-service.ts:137`). Only tests call it.
3. **Reversal + revalidation callbacks unset.** Even the constructed
   `DisputeService` (`libp2p-node-base.ts:1164-1196`) is passed neither
   `onInvalidation` (so `maybeInvalidate`, `dispute-service.ts:225`, is a no-op)
   nor `revalidate` (so an arbitrator's `handleChallenge` always votes
   `inconclusive`). So even if (1) and (2) were wired, no reversal would
   originate and no arbitrator would produce a substantive vote.

## The security precondition to cross-reference

Full activation is **not** a free wiring change. Dispute resolution originates a
durable transaction reversal (`maybeInvalidate` → `onInvalidation` → the
invalidation subsystem), so dispute activation inherits the **same** arbitrator-set
anchoring requirement as invalidation:
`tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring`.
Until the arbitrator set can be independently re-derived (validated live recompute)
or trust-anchored, a peer minting throwaway Ed25519 keypairs can self-sign a
synthetic cohort + super-majority and forge a passing resolution. That gate is
why the subsystem stays dormant near-term.

## Edge cases & interactions

- **Comment accuracy is the deliverable.** The line numbers above drift; anchor
  each comment to a stable code landmark (the service-map object, the
  `if (rejectionCount > 0 && approvalCount >= superMajority)` block, the
  `if (options.dispute?.disputeEnabled)` block), not to a line number. A wrong
  cross-reference is worse than none.
- **`disputeEnabled` still constructs the service.** Do not touch that path — the
  service object is legitimately used by tests and by status lookups
  (`getDisputeStatus`). The annotation must state that construction ≠ activation:
  the object exists but is unreachable from the live network path.
- **Greppability.** Tag each site so the dormant set is discoverable as one group
  (e.g. a shared marker string like `dispute-subsystem-dormant`), and name the
  live-activation ticket slug so a reader can jump straight to the wiring plan.
- **No new exports / no signature changes.** If a comment tempts you to add a
  parameter or a stub, stop — that is live-activation work and belongs in the
  `feat-` ticket, behind the anchoring gate.
- **Reviewer check:** the diff should be comments only; any non-comment line in
  the diff is out of scope for this ticket.

## TODO

- At the `services` map in `libp2p-node-base.ts` (~435-554), add a comment where a
  `dispute:` service entry would go, stating: the `/dispute/1.0.0` handler
  (`disputeProtocolService`) is intentionally NOT registered; the subsystem is
  staged dormant pending arbitrator-set anchoring; cross-reference
  `invalidation-live-wiring-requires-arbitrator-set-anchoring` and
  `feat-dispute-subsystem-live-activation`.
- At the `DisputeService` construction block (`libp2p-node-base.ts:1164-1196`),
  add a comment stating that construction is intentional (tests / status lookups)
  but the service is unreachable live: no inbound handler, `onInvalidation` and
  `revalidate` deliberately unset. Same cross-references.
- At the disputed-record path in `cluster-coordinator.ts:319-339`, add a comment
  stating that `initiateDispute` is intentionally NOT called here yet — the
  evidence is computed and persisted, but dispute origination stays dormant behind
  the same anchoring gate. Same cross-references.
- Use a single shared grep marker across all three sites so the dormant set is one
  discoverable group.
- Confirm the diff is comments only, then `yarn build` (or the package's typecheck)
  in `packages/db-p2p` to prove no accidental code change slipped in.
