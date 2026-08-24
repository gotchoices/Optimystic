description: A machine used to answer "how do I reach this third machine?" two different ways depending on which message it was answering, and the weaker answer could describe a reachable machine as having no address at all. Both answers now come from one function.
prereq:
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md
difficulty: medium
----

# What landed

Two things: one declined change pinned at its code site, and one duplicated rule collapsed to a
single function.

## The rule, and where it now lives

"Which addresses may we hand a **third** party for peer P?" — `peer-address-book.ts` now answers
that once:

```ts
/** Join both halves: connection addrs first, then advertised, de-duplicated + validated. */
export function unionPublishableAddrs(connectionAddrs: string[], advertisedAddrs: string[], log: AddressLog): string[]

/** Read P's live connections + P's peerStore-advertised addresses, join with the above. */
export async function publishableAddrsForPeer(
	host: PeerAddressBookHost, connections: DirectionalConnection[], peerId: PeerId, log: AddressLog
): Promise<string[]>
```

`PeerAddressBookHost.peerStore` gained an optional `get`. Four producers now go through it:

| producer | before | after |
| --- | --- | --- |
| `findCluster` (`libp2p-key-network.ts:1058`) | hand-rolled union of connections + peerStore | `unionPublishableAddrs` (sync form — both halves already batched in hand, so no second `store.get`) |
| `RepoService.getPeerAddrs` (`repo/service.ts:162`) | connections only | `publishableAddrsForPeer` |
| `ClusterService.getPeerAddrs` (`cluster/service.ts:123`) | connections only | `publishableAddrsForPeer` |
| injected `getConnectionAddrs` (`libp2p-node-base.ts:577`) | connections only | `publishableAddrsForPeer` |

`Libp2pKeyPeerNetwork.parseMultiaddrs` is deleted (it had exactly one caller, now inside the helper).
`getPeerStoreAddrsByPeer` survives — `classifySelfDialability`'s caller at line 668 still uses it.

**Signature changes, because a peerStore read is async:**

- `ClusterService.checkRedirect` became `async`; `processOperation` awaits it. Its ten call sites in
  `test/cluster-service-redirect.spec.ts` gained `await`.
- Both `getConnectionAddrs` component hooks became `(peerId) => string[] | Promise<string[]>`.
  Declared as a union deliberately: an embedder's existing synchronous connections-only stub keeps
  compiling and working, which is what the two existing spec stubs are.

## The declined change, pinned

`fix/1-inbound-relayed-connection-addr-is-never-published` proposed letting an **inbound**
connection's `remoteAddr` be publishable when it is a circuit address. Refuted, and the refutation
now lives as an accepted-tradeoff `NOTE:` on `publishableConnectionAddr` itself. Citations verified
against `@libp2p/circuit-relay-v2@4.1.3` as vendored in `packages/db-p2p/node_modules`:

- `dist/src/transport/index.js:272` — the destination composes the address as
  `connection.remoteAddr.encapsulate('/p2p-circuit/p2p/<dialer>')`, so the relay it names is **ours**.
- `dist/src/server/index.js:219-222` — `handleConnect` looks up a reservation for `dstPeer` only and
  answers `NO_RESERVATION` when absent. A dialer needs none. That asymmetry is the decisive reason,
  and it is the one the old test comment was missing.

The verdict row at `test/peer-address-book.spec.ts:83` is unchanged; its comment now carries the
reservation asymmetry and both line citations.

# Use cases to test / validate

**The behavior that changed, in one sentence:** a peer that only ever dialed *us* — so we hold only
the inbound half of the socket — is now described in a redirect payload by the addresses it
advertised to us through `identify`, where before it was described by an empty list.

Things worth driving:

- **Repo redirect, relay-only cohort member.** `RepoService` is the resolver where this actually
  bites in production: `libp2p-node-base` injects no `getConnectionAddrs` for it (the node arrives
  later via `setLibp2p`), and unlike a cluster redirect there is no `record.peers` entry to fall back
  on. Covered by `redirect.spec.ts` -> *"unions the peerStore's advertised addresses into the
  redirect payload fallback"*.
- **Ordering.** Connection-first is load-bearing, not cosmetic: the recipient truncates at
  `MAX_MERGED_ADDRS_PER_PEER` (8), so a proven address must not be the one dropped. Asserted by
  `deep.equal([outboundAddr, dialedAdvertised])` in the same test.
- **De-duplication.** The peerStore usually holds the very address we dialed; it must not take a
  second slot. Same assertion.
- **peerStore absent / throwing / empty.** libp2p's `peerStore.get` *throws* for an unknown peer, and
  a redirect routinely names peers we have never met — so this is the common path, not the error
  path. `redirect.spec.ts` -> *"falls back to the connection half when the peerStore has nothing or
  fails"* drives all three shapes and asserts a redirect is still produced with the connection half
  intact.
- **Two real nodes, one dial.** `cluster-service-node-resolvers.spec.ts` -> *"publishes a redirect
  target from outbound connections unioned with the peer's advertised addresses"* stands up real
  libp2p nodes and asserts from both ends: the listener publishes the dialer's advertised addresses
  and **never** the ephemeral source socket; the dialer leads with the address it dialed and carries
  the listener's advertised set behind it.
- **The negative still holds.** Every pre-existing inbound-direct assertion is unchanged and passing
  — an ephemeral source socket is still never published, from any of the four producers.

**Neuter check performed** (the way `a8f64d0`'s tests were verified): with `advertisedAddrsForPeer`
forced to return `[]`, both new behaviors fail —

```
1) RepoService … unions the peerStore's advertised addresses …
   expected ["/ip4/10.0.0.5/tcp/4001/p2p/…"] to equal [… , "/ip4/192.168.1.9/tcp/4001"]
2) cluster service node resolvers … unioned with the peer's advertised addresses:
   an inbound-only peer is not addressless: identify already told us where it listens:
   expected [] not to be empty
```

The neuter was reverted; `grep -r NEUTERED packages/db-p2p/src` is clean.

# Validation run

| command | result |
| --- | --- |
| `yarn lint` | clean |
| `yarn build` | success |
| `yarn typecheck` | clean |
| `yarn test` (whole monorepo) | **0 failing** — 1387 + 1874 + 54 + 51 + 46 + 45 + 12 + 125 + 474 + 6 + 258 passing, 56 pending |
| `OPTIMYSTIC_INTEGRATION=1 … "test/**/*.integration.spec.ts"` (db-p2p) | 30 passing, 2 pending |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

# Known gaps — treat the tests as a floor

- **Nothing here was measured in production**, and the ticket said so. The whole change rests on
  reading the two code paths side by side. No captured failure exists showing a redirect arriving
  with an empty address list for a peer that a cluster record described with a circuit address.
- **No relay topology in any test.** Both new tests use a direct dial and a *stubbed* circuit
  address string. The ticket judged a relay topology unnecessary to pin the union rule and I agree —
  but that means the specific production scenario in the ticket's argument (peer reachable *only*
  through a relay) is proven by construction, not by a live circuit. `test/relay-third-party-
  address-gap.spec.ts` exists and would be where to add one.
- **The peerStore's contents are trusted exactly as much as `findCluster` already trusted them.**
  This gives the redirect paths the same inputs `findCluster` has always had; it does not widen what
  any producer may say, and ingress caps (`MAX_MERGED_ADDRS_PER_PEER` / `MAX_LEARNED_PEERS_PER_RECORD`)
  are untouched. Worth a reviewer's own read rather than my assertion.
- **A `getConnectionAddrs` that returns a rejected promise now rejects the redirect.** The sync
  version could not fail. `publishableAddrsForPeer` itself never rejects (the peerStore read is
  swallowed), and the only production injector is ours — but an embedder's async stub is a new way
  to break `checkRedirect`. I did not add a guard; a reviewer may reasonably want one.
- **`unionPublishableAddrs` vs `publishableAddrsForPeer` is two exports for one rule.** The split
  exists solely so `findCluster` can keep its batched peerStore read. Defensible, but it is a seam a
  fifth caller could pick the wrong side of.
- **Self-relay-only addresses now reach redirect payloads** (they already reached cluster records).
  That is the intended, working path — a sibling reaching the peer through our relay — but it is a
  behavior change on the redirect side that no test names explicitly.

# Tripwire recorded

`peer-address-book.ts` — `advertisedAddrsForPeer` carries a `NOTE:` that each redirect target now
costs one `peerStore.get` the redirect resolvers previously did not pay. Bounded (a redirect names at
most `clusterSize` peers, single digits, and only when this node is not responsible), unmeasured, and
the reads are already issued concurrently by `Promise.all` at both call sites. Parked at the code
site, not filed as a ticket.
