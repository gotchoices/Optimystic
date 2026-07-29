----
description: Anyone who can open a network connection to a node can currently send it database commands directly — there is no place for the application embedding this library to say "that peer is not allowed". This adds an optional permission check that runs before any incoming database request is executed.
prereq: bug-read-repair-unrepairable-small-cluster
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts
difficulty: medium
----

# Add an optional inbound-stream authorization hook to the db-p2p services

## Why

Requested by a downstream embedder (the Sereus project, in the sibling `sereus` repo). Its
control database is private to a single party: only nodes that party has admitted may read or
write it. It already gates the protocols it owns per stream, and denies whole connections from
peers it can positively identify as non-members.

What it cannot gate is the surface that actually carries database writes — the protocols this
library registers:

- `…/repo/1.0.0`
- `…/cluster/1.0.0`
- `…/sync/…`
- `…/block-transfer/…`

`RepoService.handleIncomingStream` and its cluster/sync/block-transfer siblings go straight
from "stream opened" to "decode and execute the operation". There is no seam. The embedder
cannot wrap the handlers from outside without re-implementing the protocol framing, which it
has explicitly ruled out as a maintenance trap.

Connection-level gating is a real but partial defense: it is deliberately fail-open in
ambiguous states, so an outsider that gets a connection during an enrollment window, against a
formation-open node, or against a not-yet-enrolled node can still execute repo operations.

## What to build

An optional predicate, consulted at the top of each service's inbound stream handler, before
any decoding or execution:

```ts
authorizeInboundStream?: (remotePeerId: string, protocol: string) => Promise<boolean> | boolean;
```

Design decision, already made — **do not re-litigate it**: expose it as a **single node-level
option on `createLibp2pNode`**, threaded to all four services, rather than four separate
per-service options. Rationale: the embedder's authorization question ("is this peer a member
of my party?") is a property of the node, not of the protocol, and four independently-settable
options make it easy to secure three surfaces and silently miss the fourth. Each service should
still accept the predicate in its own init so the services stay independently testable and
usable outside `createLibp2pNode`; the node-level option simply supplies the same function to
all of them.

### Semantics that must hold

- **Absent predicate → current behavior exactly.** No predicate supplied means no check, no
  overhead, no change. This is the default.
- **Supplied predicate → fail-closed.** A predicate that returns `false` rejects the stream and
  the operation must not execute. A predicate that *throws* or rejects must also deny — never
  fall through to execution on error — and must log the failure rather than swallow it.
- The rejection must not be silently indistinguishable from a network fault. Decide whether to
  abort the stream or return a protocol-level error response, apply it consistently across all
  four services, and document what a caller observes.
- The predicate is called **once per inbound stream**, not per operation within a stream. If any
  of these protocols multiplexes several logical operations onto one stream, say so in the
  handoff — the embedder is assuming per-stream is sufficient and needs to know if it is not.

## Edge cases & interactions

- **A slow or hanging predicate** stalls the handler. Decide whether to bound it with a timeout,
  and if so what a timeout means (deny — consistent with fail-closed).
- **Self-dials / loopback**: a node connecting to itself, or the in-process short-circuit paths,
  must not be denied by an embedder predicate that only knows about remote members. Establish
  whether these paths reach the inbound handlers at all, and state the answer.
- **Peer id representation**: the predicate receives a string. Fix and document the encoding
  (`toString()` of the libp2p `PeerId`) so the embedder compares like with like — a mismatch here
  fails open in practice, because every comparison returns false and the embedder "fixes" it by
  loosening the check.
- **Existing tests** in these services construct them without the option; confirm they are
  unaffected.
- **Performance**: the predicate sits in the hot path of every inbound stream. Note the cost and
  whether embedders are expected to memoize.

## Testing

- Per service: predicate returns `false` → operation demonstrably not executed (assert on the
  underlying repo/storage mock receiving nothing, not merely on the error surfaced).
- Per service: predicate returns `true` → unchanged behavior.
- Predicate throws → denied, and the throw is logged.
- No predicate → byte-identical behavior to today.
- Node-level wiring: one option set on `createLibp2pNode` reaches all four services. Assert all
  four, individually — this test is the whole reason the option is node-level.

## TODO

- [ ] Add the option to each service's init type and consult it at the top of each inbound handler.
- [ ] Thread a single node-level option through `createLibp2pNode` to all four services.
- [ ] Confirm whether any of these protocols multiplexes multiple operations per stream.
- [ ] Document the peer-id string encoding the predicate receives.
- [ ] Tests per the list above.
- [ ] Full `db-p2p` suite green and root `yarn lint` clean.

## Downstream note

Once this lands, the Sereus side wires
`(remotePeerId) => this.isAuthorizedMember(remotePeerId)` into its control-network node only —
its cross-party strand nodes must not get it. Its ticket
`control-repo-protocol-stream-authz-optimystic` is parked in that repo's `blocked/` waiting on
this seam.
