description: A peer reachable only through a relay used to be accepted into a replication group while none of the other members were ever told how to reach it, so the group looked healthy but replication silently never finished. The addresses were already being sent over the wire; the receiving side now keeps them instead of throwing them away.
files: packages/db-core/src/network/i-peer-network.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/peer-address-learning.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/test/relay-third-party-address-gap.spec.ts, docs/internals.md
difficulty: medium
----
Implements `implement/relay-only-cohort-member-addresses-never-reach-siblings`. Fixes gotchoices/Optimystic#11.

## What the change is, in one paragraph

libp2p tells a peer's addresses only to peers it is **directly connected to**, and this stack has no
peer-routing fallback (no kad-dht, no `peerRouters`). Replication cohorts here are picked by key
position, so a node routinely shares a cohort with a peer it has never met — and if that peer is
reachable only through a circuit relay, the node holds an empty address list for it and every dial by
peer id dies instantly with `NoValidAddressesError` while membership logs still read healthy. The
addresses were already on the wire twice over (`ClusterRecord.peers[*].multiaddrs` and a redirect
payload's `{ id, addrs }`) and both consumers structurally discarded them. Now every one of those
ingress points writes the addresses into the libp2p peerStore through a single shared helper.

## What landed

- **`db-core/src/network/i-peer-network.ts`** — new **optional** `recordPeerAddresses?(peerId, multiaddrs: string[])`
  on `IPeerNetwork`. Optional so every in-memory test double and the mesh harness keep compiling
  untouched; on `IPeerNetwork` (not `IKeyNetwork`) because it is a statement about *dialing*, which
  also lets the two redirect call sites avoid the `(peerNetwork as any)` cast that the adjacent
  `recordCoordinator` hop still needs.
- **`db-p2p/src/peer-address-book.ts`** (new) — `mergePeerAddresses` + `validMultiaddrStrings` +
  `MAX_MERGED_ADDRS_PER_PEER` (8). The only place in this repo that writes the peerStore. Rules:
  never merge for self; drop unparseable addresses with a WARN; drop the root multiaddr `/` (what
  an empty string parses to); cap per message; `void` the async merge with a logged `.catch`.
- **`libp2p-key-network.ts`** — public `recordPeerAddresses` delegate next to `recordCoordinator`;
  `parseMultiaddrs` now delegates to the shared validator (one definition, not two); a new
  `findCluster:addressless-members` log line, unconditional (not gated on `verbose`), plus an
  `addressless=` count on `findCluster:done`. **Admission behavior is unchanged** — addressless
  members are still admitted, deliberately.
- **`cluster/service.ts`** — merges `record.peers[*].multiaddrs` at the top of `processOperation`,
  *before* the redirect decision and before `cluster.update`, via a new optional
  `recordPeerAddresses` component. `processOperation` is now public (see "judgement calls" below).
- **`libp2p-node-base.ts`** — wires that component as a closure over `components.libp2p`, the same
  late-binding shape `getConnectionAddrs` already uses.
- **`cluster/client.ts`** — redirect branch now typed against `RedirectPayload`; merges the redirect
  target's `addrs` **before** dialing it; and merges the peer map of the `ClusterRecord` a member
  returns (the coordinator's half of the same exchange).
- **`repo/client.ts`** — same redirect-branch typing and pre-dial merge.
- **`dispute/dispute-service.ts`** — comment recording that a challenge's `originalRecord` peer
  addresses are deliberately *not* merged, and why.
- **`docs/internals.md`** — new "Third-Party Address Learning" section.

## Use cases to exercise when reviewing

**The one that motivated the ticket.** Coordinator D1 knows relay-only peer N (N bootstrapped through
it). D1 coordinates a transaction over `{D1, D2, N}` and sends D2 a record containing N's circuit
address. Before: D2 reads the peer ids, throws the addresses away, and can never coordinate its own
transaction involving N. After: D2 keeps them.

**Redirect, first hop.** A client dials the wrong peer, gets a redirect naming a relay-only target.
The merge must land *before* the dial — a merge placed after it helps only some later hop and fixes
nothing. This ordering is asserted against a recorded event log, not by "was it called".

**Ordinary direct mesh.** Everything above must be inert when all peers are directly connected: the
merged addresses are ones identify already supplied.

**No address book.** `IPeerNetwork` implementations without `recordPeerAddresses` (mesh harness, stub
networks) must behave exactly as before — there is a test for this.

## Tests

New/changed, all passing:

- `test/peer-address-book.spec.ts` (new) — helper rules: self skipped, unparseable dropped and
  logged, the root `/` address rejected, cap enforced *and* the truncation logged, a rejected
  `peerStore.merge` logged and not rethrown, no-peerStore and empty-list no-ops.
- `test/peer-address-learning.spec.ts` (new) — both clients' redirect ingress with a
  **merge-before-dial ordering assertion**; `ClusterClient` ingress of a returned record (relay-only
  member offered, addressless member skipped, unparseable id skipped); and a network with no
  `recordPeerAddresses` at all.
- `test/cluster-service-redirect.spec.ts` — new `address learning from inbound records` block driving
  the real `processOperation`: offers on the **process-locally** path, offers on the **redirect**
  path (that branch dials too), skips addressless/unparseable/self, and works with no sink wired.
- `test/relay-third-party-address-gap.spec.ts` — the pre-existing premise guard, unchanged and green.

Gate results, honestly:

| command | result |
| --- | --- |
| `yarn build` | pass |
| `yarn typecheck` | pass |
| `yarn lint` | pass, clean |
| `yarn test` (root) | `db-core` 1368 pass, `db-p2p` 1795 pass, others green — **`quereus-plugin-optimystic` 462 pass / 10 fail** |

## Known gaps — read these before trusting the above

**The 10 plugin failures are pre-existing, and I measured that rather than assuming it.** All ten are
in `quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts`, all failing at table
creation with cohort members resetting the consensus stream ("1/3 approvals, needed 2"). I put a
temporary early-return at the top of `mergePeerAddresses` behind an env var — switching off the
entire new runtime behavior, since every call site funnels through it — rebuilt, and re-ran: **the
same ten tests failed, same counts.** The probe was removed and is not in the diff. Full write-up in
`tickets/.pre-existing-error.md`. The symptom is in the same family as the recently-landed
`cohort-topic-streams-rejected-on-limited-relay-connections` work.

**The end-to-end integration case was deferred**, as the source ticket allowed. The existing
`test/real-libp2p.integration.spec.ts` harness does not host a relay, and adding relay + relay-only
member + two host members needs real scaffolding there. What covers the mechanism instead: the
premise guard proves a single peerStore merge of a carried circuit address is sufficient to make a
relay-only peer dialable by a never-connected sibling, and the unit ingress tests prove every place
that carries such an address now performs that merge. **What is NOT covered anywhere: the two halves
joined up over real sockets.** A reviewer wanting real confidence should build that case.

**Judgement calls a reviewer may want to overturn:**

- `ClusterService.processOperation` was made **public** so the service tests drive the real ingress
  rather than reconstructing `redirect ?? cluster.update(...)` by hand — a reconstruction proves
  nothing about the ordering this ticket is entirely about. `checkRedirect` was already public for
  the same reason, but it is still a widened surface.
- Client-side tests live in a **new** `peer-address-learning.spec.ts` rather than extending
  `redirect.spec.ts` as the source ticket suggested. That file's premise was wrong: `redirect.spec.ts`
  tests `RepoService.checkRedirect` and payload shapes and has **no** stub `IPeerNetwork` to extend.
- `validMultiaddrStrings` rejects the root multiaddr `/`. This was not in the source ticket — it
  surfaced because `multiaddr('')` parses cleanly, so a blank entry would otherwise occupy a slot in
  the address book and in the per-message cap. The check is `bytes.length === 0`.
- The `libp2p-node-base` wiring logs through `components.logger.forComponent('db-p2p:peer-address-book')`
  rather than the package's `createLogger`; `Libp2pKeyPeerNetwork.recordPeerAddresses` logs through
  its own `debug` logger. Two log namespaces for one helper.

**Not verified by any test:** that the `libp2p-node-base` wiring actually reaches a live node's
peerStore. The closure is exercised only by construction, not by assertion — the service-level tests
use a stub sink and the helper tests use a stub host. If the reviewer builds the deferred end-to-end
case, that is the gap it closes.

**Deliberately unchanged:** `recordCoordinator` still goes through `pn: any` at both redirect call
sites; moving it to `IPeerNetwork` alongside the new method was explicitly out of scope.
