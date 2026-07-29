---
description: An application can already refuse unknown peers that try to read or write its database, but the same peers can still ask the node to vote on a dispute. Extend the same permission check to the dispute conversation.
files: packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/inbound-authorization.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/internals.md, packages/db-p2p/docs/repo.md
difficulty: easy
---

# Extend the inbound-stream permission check to the dispute protocol

## Background

A node embedding this library can now supply one function that decides which remote peers are
allowed to open the four "database" conversations with it — reading blocks, writing blocks,
syncing history, and transferring block copies. The function is supplied once when the node is
created (`createLibp2pNode({ authorizeInboundStream })`); a peer it turns down has its connection
attempt torn down before the node reads anything the peer sent.

The node also serves a fifth conversation of the same kind: **dispute**. A remote peer opens it to
challenge another peer's behavior, and the node answers by *signing a vote* on that challenge. That
conversation is not covered by the permission check. Any peer that can reach the node can ask it to
vote, today and after the database surfaces are locked down.

The dispute handler is structurally identical to the cluster one — same file layout, same "one
request, one response per connection" shape — so adding the check is the same handful of lines that
were added to the other four.

## Why it was left out

The work that added the permission check was scoped, deliberately and explicitly, to the four
database conversations. Widening it to a fifth is a scope decision about who should be able to make
this node vote, and that is worth deciding on purpose rather than folding into a review pass.

## The decision to make first

Is being asked to vote on a dispute something only admitted peers should be able to do?

- **Argument for gating it:** an application that has decided a peer is not part of its network
  should not have that peer able to make its node produce signed votes. Votes are cryptographic
  statements; producing them for strangers is both work and attributable output.
- **Argument against gating it:** disputes are, by nature, about misbehaving peers, and the peer
  reporting one may legitimately be someone the node has not admitted. A permission check written
  as "only my members" would silently drop those reports.

A reasonable resolution is to gate it but keep it separately controllable, so an application can
close its database while leaving dispute reporting open. Whoever picks this up should settle that
question before writing code — the plumbing is trivial either way.

## Expected behavior

- With no permission function supplied, nothing changes: dispute streams are served as they are today.
- With one supplied and the decision above being "gate it", a refused peer's dispute stream is torn
  down before the challenge is decoded, no vote is signed, and the refusal is logged on this node
  with the peer's identity and the reason — matching exactly what the other four surfaces already do.
- Whichever way it goes, the documentation must stop describing dispute as ungated by omission:
  `docs/internals.md` § Inbound Stream Authorization and the protocol table in
  `packages/db-p2p/docs/repo.md` both currently name it as *not* covered.

## Coverage expectations

The existing per-service test table in `packages/db-p2p/test/inbound-stream-authorization.spec.ts`
is built so a fifth service is one more entry: it asserts, for every service, that a refused peer's
operation never reaches the underlying subsystem and that no response is written. A dispute entry
should assert the same, plus specifically that no vote is signed.
