description: A peer reachable only through a relay used to be accepted into a replication group while none of the other members were ever told how to reach it, so the group looked healthy but replication silently never finished. The addresses were already being sent over the wire; the receiving side now keeps them instead of throwing them away.
files: packages/db-core/src/network/i-peer-network.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/peer-address-learning.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/relay-third-party-address-gap.spec.ts, docs/internals.md
----
Closes gotchoices/Optimystic#11. Implemented in `d24f344`, triage fix in `0eb5695`, reviewed and
amended in this commit.

## What shipped

libp2p tells a peer's addresses only to peers it is **directly connected to**, and this stack
registers no peer-routing fallback (no kad-dht, no `peerRouters`). Replication cohorts are picked by
key position, so a node routinely shares a cohort with a peer it has never met — and if that peer is
reachable only through a circuit relay, the node holds an empty address list for it and every dial
by peer id fails instantly with `NoValidAddressesError` while membership logs still read healthy.

The addresses were already on the wire twice over (`ClusterRecord.peers[*].multiaddrs` and a
redirect payload's `{ id, addrs }`) and both consumers structurally discarded them. Every one of
those ingress points now writes them into the libp2p peerStore through one shared module,
`packages/db-p2p/src/peer-address-book.ts` — the only place in the repository that writes the
peerStore.

- New optional `recordPeerAddresses?(peerId, multiaddrs: string[])` on `IPeerNetwork`, so test
  doubles and the in-memory mesh harness keep working untouched by omitting it.
- `ClusterService.processOperation` learns the record's peer map before the redirect decision and
  before consensus; `ClusterClient` learns from the record a member returns; both clients learn a
  redirect target's addresses *before* dialing it.
- The dispute path deliberately does **not** learn — a challenge's `originalRecord` is
  attacker-supplied on a path already flagged unverified, and a disputing peer is not one we need a
  route to.
- `findCluster` now logs `findCluster:addressless-members` (unconditional, not gated on `verbose`)
  and an `addressless=` count on `findCluster:done`. Addressless members are still **admitted** —
  dropping them would shrink the cohort below `clusterSize` and put the consensus super-majority out
  of reach — but the condition is no longer silent, which was half the reported symptom.
- Two caps bound what an unvalidated message may write: `MAX_MERGED_ADDRS_PER_PEER` (8 addresses per
  peer) and `MAX_LEARNED_PEERS_PER_RECORD` (64 peers per record).

`docs/internals.md` carries the "Third-Party Address Learning" section describing the above.

## Review findings

### Checked

Read the implement diff (`d24f344`) before the handoff summary, plus the triage commit (`0eb5695`)
that landed on the same files afterward. Swept every ingress that carries a peer address in
`packages/db-p2p/src` (`grep -rn multiaddrs`) to confirm no fourth call site was missed — the only
other reads are `cluster-coordinator.ts:534,632`, which count addresses for a log line on a record
the coordinator built itself, so there is nothing to learn there. Reviewed the new module and both
traversals for duplication, the trust boundary, error handling, type safety, and source hygiene;
re-read `docs/internals.md` against the shipped code. Ran build, typecheck, lint, and the full
monorepo test suite.

### Major — fixed in this pass

**An unvalidated cluster record could introduce unbounded peers into the peerStore.**
`ClusterService.learnPeerAddresses` runs before `checkRedirect` and before `cluster.update` checks a
single signature, and inbound stream authorization is opt-in (`authorizeInboundStream` is
`undefined` unless an embedder supplies it), so at that point `record.peers` is entirely
attacker-authored. `MAX_MERGED_ADDRS_PER_PEER` bounded addresses *per peer* but nothing bounded the
number of *peers*: one 1 MiB control message (`MAX_CONTROL_MESSAGE_BYTES`) holds on the order of a
thousand fabricated `{ id, multiaddrs, publicKey }` entries, each becoming a persisted peerStore
record, repeatable per stream. The module comment asserted the opposite — "a cohort's peer *ids* are
keyspace-determined and not attacker-chosen" — which is true of a *validated* record and false at
this ingress.

Rather than adding a counter at the one site, the two near-identical traversals (`ClusterService.
learnPeerAddresses` and `ClusterClient.recordRecordPeerAddresses`, which had drifted apart already —
only one logged unparseable ids) were collapsed into one shared `mergeRecordPeerAddresses` in
`peer-address-book.ts`, so the bound cannot be applied in one place and forgotten in the other. The
cap counts *candidates*, not successful merges, so a record of nothing but unparseable ids cannot
spend unbounded parse attempts and log lines either. `MAX_LEARNED_PEERS_PER_RECORD` is 64 against
single-digit real cohorts — generous margin, not a functional limit. The false comment was
corrected and `docs/internals.md` updated. Six tests added covering the traversal and both caps.

### Major — already resolved before this pass, recorded for accuracy

**The 10 `quereus-plugin-optimystic` failures the handoff called pre-existing were caused by this
diff.** The handoff reported measuring them as pre-existing by putting an env-gated early return at
the top of `mergePeerAddresses` and observing the same ten failures. That probe could not have
worked: the fault was one frame earlier, in the new `recordPeerAddresses` wiring in
`libp2p-node-base.ts`, which read `components.libp2p` — libp2p's `components` is a Proxy whose
getter *throws* `MissingServiceError('libp2p not set')` for any key it does not hold, and `libp2p`
is not a key. The throw happens on the property read, so neither `?.` nor a following null check
defends against it, and the early return inside `mergePeerAddresses` was never reached. Because
`processOperation` calls `learnPeerAddresses` first, every cohort member answered the coordinator
with a `MissingServiceError` envelope, consensus never reached super-majority, and every distributed
`CREATE TABLE` failed with `1/3 approvals (needed 2)` — exactly the reported symptom. The runner's
triage pass diagnosed and fixed this in `0eb5695` (closure over a `liveNode` bound before `start()`)
and added `test/cluster-service-node-resolvers.spec.ts`. The full suite is green, so no action
remains; it is recorded here because the handoff's "measured, not assumed" claim is the kind a
future reader would otherwise trust. The same latent bug existed in the pre-existing
`getConnectionAddrs` resolver and was fixed alongside it.

**The handoff's "not verified by any test: that the `libp2p-node-base` wiring actually reaches a
live node's peerStore" is now closed** by the triage spec, which drives the real service on a real
node and polls `node.peerStore` for the address the record carried.

### Minor — reviewed and deliberately left alone

- **Both redirect sites learn only the target they dial (`next`), not every peer the payload
  lists.** Not a defect: the unlisted peers are learned from the cluster record that follows, and
  widening it would let an unvalidated redirect write more for no gain on the hop that needs it.
- **Three log namespaces now front one module** (`db-p2p:peer-address-book` for the service path via
  the libp2p logger, `optimystic:db-p2p:key-network` for the client path, and
  `optimystic:db-p2p:cluster-client` for the record traversal). Each names the component that owns
  the call, which is the right attribution, and every line the module itself emits carries a
  self-identifying `peer-address-book:` prefix, so grep-ability does not depend on the namespace.
- **`recordPeerAddresses: (peerId: any, ...)` in `libp2p-node-base.ts` is untyped.** It matches the
  adjacent `getConnectionAddrs: (peerId: any)` and the file's `components: any` factory idiom;
  tightening one of the two in isolation would make the file less consistent, not more.
- **`ClusterService.processOperation` was widened to public** by the implementer so tests drive the
  real ingress rather than reconstructing it. The triage spec now depends on it for the same reason,
  so the widened surface is earning its keep.

### Tripwire

The mechanism is covered end-to-end through real libp2p but **split across two specs** —
`relay-third-party-address-gap.spec.ts` proves a `peerStore.merge` of a carried address makes a
peer-id-only dial reach a relay-only peer, and `cluster-service-node-resolvers.spec.ts` proves an
inbound `ClusterRecord` puts that address in a real node's `peerStore`. No single spec joins the
halves. Parked as a `NOTE:` in the header of `relay-third-party-address-gap.spec.ts`: this is fine
while the halves meet at the one `peerStore` object, and the joined case (relay + relay-only member
+ two host members over real sockets) becomes worth building if the ingress path ever grows a
transform between the record and the merge.

### No new tickets filed

The one major finding was a defect this diff introduced whose fix was contained to the module the
diff added, so it belongs in this pass rather than in a queue. The other major finding was already
fixed and tested by the triage pass. Nothing else rose above the "reviewed and left alone" bar
above, and no accepted-tradeoff `NOTE:` at any touched site had its revisit condition trip.

## Gates

All run from the repository root after the review edits:

| command | result |
| --- | --- |
| `yarn build` | pass |
| `yarn typecheck` | pass |
| `yarn lint` | pass, clean |
| `yarn test` | pass — 0 failing across every package, including the `quereus-plugin-optimystic` suite (472 passing) that failed 10 at handoff time |

`db-p2p` is at 1803 passing / 44 pending (1795 at handoff, plus 2 from the triage spec and 6 added
by this review).
