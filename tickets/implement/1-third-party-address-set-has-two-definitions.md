description: When one machine tells another machine how to reach a third one, it answers that question two different ways depending on which message it is answering — and one of the two ways is missing a whole source of addresses, so a machine reachable only through a relay can end up described as having no address at all. Make both answers the same answer.
prereq:
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md
difficulty: medium
----

# One question, two answers: which addresses may we hand a third party for a peer?

This node answers that question in two places, and they do not agree.

**`findCluster` (`libp2p-key-network.ts:1019-1073`) answers it with a union of two sources.** It
reads every live connection through `publishableConnectionAddr`, and it *also* reads the peerStore
for every non-self cohort member (`getPeerStoreAddrsByPeer`, line 1112), then de-duplicates
connection-addresses-first. The peerStore arm is what carries a peer's own advertised addresses —
the ones that reach us through libp2p's `identify` / `identifyPush` — and for a peer reachable only
through a relay, that is the only place its real circuit address ever comes from.

**The three redirect address resolvers answer it with connections alone.**

- `repo/service.ts:162` — `RepoService.getPeerAddrs`. This one is load-bearing in production:
  `RepoService.checkRedirect` (line 217) builds its payload from `this.getPeerAddrs(pid)` and
  nothing else — there is no cluster record to fall back on, and `libp2p-node-base.ts` deliberately
  injects no `getConnectionAddrs` for the repo service (line 604 and the note above it).
- `cluster/service.ts:123` — `ClusterService.getPeerAddrs`, reached only when the cluster record
  itself carried no addresses for that member (line 175), i.e. exactly the "addressless member"
  case `findCluster` admits and logs.
- `libp2p-node-base.ts:577` — the `getConnectionAddrs` the node injects into the cluster service.

So: a cohort member that only ever dialed **us**, and that is reachable only through a relay, is
described by `findCluster` with its circuit address and by a repo redirect with **no address at
all**. The recipient of that redirect has nothing to dial. Nothing about that is intentional — it is
two implementations of one rule drifting apart, and the weaker one was never the considered answer.

**Nobody has measured this in production.** It is filed on the strength of reading the two code
paths side by side, not on a captured failure. The argument for doing it anyway is that it removes
the disagreement rather than patching an instance: afterwards there is one function that answers
"which addresses may we publish for this peer", and a fourth caller cannot get a different answer by
reaching for the nearer of two half-implementations.

## The shape

Put the union in `peer-address-book.ts`, beside the predicate that file already owns:

```ts
/** The peer-store slice this module needs, alongside the existing `merge`. */
export interface PeerAddressBookHost {
	peerId: PeerId
	peerStore?: {
		merge?: (id: PeerId, data: { multiaddrs: Multiaddr[] }) => Promise<unknown>
		get?: (id: PeerId) => Promise<{ addresses?: Array<{ multiaddr: { toString(): string } }> }>
	}
}

/**
 * Every address we may hand a THIRD party for `peerId`: the publishable half of our live
 * connections, then the peer's own advertised addresses from the peerStore, de-duplicated,
 * connection-first. The single answer — `findCluster` and every redirect resolver share it.
 */
export async function publishableAddrsForPeer(
	host: PeerAddressBookHost,
	connections: DirectionalConnection[],
	peerId: PeerId,
	log: AddressLog
): Promise<string[]>
```

Connection-first ordering is not cosmetic: an address we outbound-dialed is one libp2p has just
succeeded with, so it belongs ahead of an advertised address we have never tried. That ordering is
already what `findCluster` does, and the reasoning is written out at
`libp2p-key-network.ts:1061-1068` — move it into the helper rather than restating it.

`ClusterService.checkRedirect` is synchronous today. Its only caller, `processOperation`
(`cluster/service.ts:215`), is `async`, so making it `async` is contained; `RepoService.checkRedirect`
is already `async`. The `getConnectionAddrs` component hooks (`cluster/service.ts:34`,
`repo/service.ts:33`) return `string[]` today and become `Promise<string[]>` — or stay sync with the
peerStore read happening around them. Either is fine; pick one and make all three resolvers look
identical afterwards.

PeerStore failures stay swallowed-and-logged, as `getPeerStoreAddrsByPeer` already does
(`libp2p-key-network.ts:1120-1130`): a redirect carrying the connection-derived half is strictly
better than a redirect that throws.

Nothing about the trust boundary changes. `findCluster` already publishes peerStore addresses to
third parties, and the peerStore's contents are already bounded at ingress by
`MAX_MERGED_ADDRS_PER_PEER` / `MAX_LEARNED_PEERS_PER_RECORD`. This gives the redirect paths the same
inputs `findCluster` has had all along; it does not widen what any of them may say.

# Second arm: pin the inbound-relayed decision so it stops being re-filed

This ticket replaces `fix/1-inbound-relayed-connection-addr-is-never-published`, which proposed
relaxing `publishableConnectionAddr` (`peer-address-book.ts:96`) so an **inbound** connection's
`remoteAddr` became publishable when it is a circuit address. That investigation refuted the
proposal. The durable home for the refutation is a `NOTE:` at the code site — otherwise the next
reader re-derives the same tempting change from the same three lines.

**Why an inbound relayed `remoteAddr` is not a third-party address.** Read from
`@libp2p/circuit-relay-v2@4.x` as vendored in `packages/db-p2p/node_modules`:

- The listener side composes it as `ourConnectionToTheRelay.remoteAddr` encapsulated with
  `/p2p-circuit/p2p/<dialer>` (`dist/src/transport/index.js:272`). The relay it names is therefore
  **the relay we hold a reservation with**, not one the dialer is reachable on.
- The relay's `handleConnect` requires a reservation for the **destination** only
  (`dist/src/server/index.js:219-223`, status `NO_RESERVATION`). A dialer needs no reservation to
  open a circuit. So a third party dialing that composed address reaches the dialer only if the
  dialer *coincidentally* also holds a reservation on our relay — which nothing establishes.
- When our own hop to the relay was itself inbound, the prefix of the composed address is an
  ephemeral source socket, so the result is undialable twice over.
- In the one case where it does happen to work — dialer and we share a relay — the dialer's genuine
  self-advertised circuit address has already reached us through `identify`, so publishing the
  composed address adds nothing and costs a slot against `MAX_MERGED_ADDRS_PER_PEER`.

The existing table row at `test/peer-address-book.spec.ts:83` already asserts the right verdict, and
its comment already gives one reason ("only dialable if OUR hop was outbound"). It is missing the
decisive one — that the dialer needs its own reservation on our relay. Complete it, and record the
decline at the predicate itself.

## TODO

**Phase 1 — pin the declined change**

- Add a `NOTE:` accepted-tradeoff line at `publishableConnectionAddr` (`peer-address-book.ts:96`)
  stating what was declined (making inbound circuit addresses publishable), why (the relay named is
  ours, not the dialer's; `handleConnect` requires a reservation only for the destination; the
  dialer's real circuit address arrives by `identify` anyway), and the revisit condition (a measured
  case where a peer's genuine circuit address reaches a third party by no other route).
- Extend the comment on the inbound-relayed row at `test/peer-address-book.spec.ts:83` with the
  reservation asymmetry, citing the two vendored source lines above. Do not change the verdict.

**Phase 2 — one definition of the publishable address set**

- Add `publishableAddrsForPeer` to `peer-address-book.ts` and widen `PeerAddressBookHost.peerStore`
  with the optional `get`. Keep connection-first, de-duplicated ordering, and swallow-and-log on
  peerStore failure.
- Route `RepoService.getPeerAddrs` (`repo/service.ts:162`), `ClusterService.getPeerAddrs`
  (`cluster/service.ts:123`) and the injected `getConnectionAddrs` (`libp2p-node-base.ts:577`)
  through it. Make `ClusterService.checkRedirect` `async` and update `processOperation`.
- Re-point `findCluster` (`libp2p-key-network.ts:1019-1073`) at the same helper so exactly one
  implementation survives. `getPeerStoreAddrsByPeer` keeps its second caller at line 668
  (`classifySelfDialability`), so that function stays — but `findCluster`'s own hand-rolled union
  must not remain as a second copy.
- Leave the `addressless` / `selfRelayOnly` counting in `findCluster` exactly as it is. This changes
  what the redirect paths see, not what `findCluster` reports.

**Phase 3 — prove it, then prove it again with the change neutered**

- Extend `test/cluster-service-node-resolvers.spec.ts` — it already stands up two real nodes and one
  dial — so the listener, which holds the inbound half, publishes the dialer's peerStore-advertised
  address where today it publishes `[]`. The direct-connection version is enough; a relay topology
  is not needed to pin the union.
- Add the equivalent to `test/redirect.spec.ts` for `RepoService.checkRedirect`, the one resolver
  with no record fallback.
- Neuter the peerStore arm and watch both new tests fail, the way `a8f64d0`'s tests were verified.
- Confirm the existing inbound-direct assertions still pass unchanged — an ephemeral source socket
  must still never be published.

**Phase 4 — docs**

- `docs/internals.md` § *Third-Party Address Learning* states the producer rule as "outbound
  connections, then peerStore" while naming four producers as though they all did that. After this
  change they do; make the sentence true rather than aspirational.
- `packages/db-p2p/docs/cluster.md` § Access Control carries the long-form rationale for the
  direction rule. Add the reservation asymmetry there in one sentence and point at the `NOTE:`.
