description: A machine used to hand out its neighbours' temporary return-path sockets as if they were real addresses, so other machines wasted connection attempts on ports nobody could reach. It now only shares addresses it dialled itself, and the health counter that was supposed to catch this finally reports the problem.
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/routing/libp2p-known-peers.ts, packages/db-p2p/docs/cluster.md, docs/internals.md, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/relay-inbound-source-address.spec.ts, packages/db-p2p/test/relay-third-party-address-gap.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/support/capture-log.ts
----

Closes gotchoices/Optimystic#13. Implemented in `a8f64d0`, reviewed and amended in this commit.

## What shipped

A node's `findCluster` returns a `ClusterPeers` map that **other** peers dial from, so every address
in it has to be reachable by a third party. It was built from every live connection's `remoteAddr`
without asking which side had dialled. For an **outbound** connection that is the address we dialled
— real, and reachable by anyone. For an **inbound** one it is the far side's *ephemeral source
socket*: the port their operating system picked for that single connection, reachable by nobody
else.

Publishing it was worse than publishing nothing. The receiving peer cannot tell it from a listen
address, so it merged it, spent a slot against `MAX_MERGED_ADDRS_PER_PEER`, turned an instant
`NoValidAddressesError` into a burned connection attempt, and could only displace the entry with a
*successful* connection — the one thing that address made impossible. It also silenced the only
diagnostic for the condition: `findCluster:addressless-members` counts members with **zero** parsed
addresses, so an entry holding one bad address never counted. The upstream report measured
`addressless=0` on 1,383 of 1,389 lookups while nearly every dial failed.

The rule now lives in one predicate — `publishableConnectionAddr` in `peer-address-book.ts`, beside
`validMultiaddrStrings`, the two sharing a private `isCarriableMultiaddrString` so "is this string
an address at all" has one implementation. A missing `direction` is deliberately treated as *not*
publishable, so a hand-built test stub cannot silently restore the old behaviour.

Four producers go through it: `findCluster`'s connection scan (`libp2p-key-network.ts`), and all
three redirect-address resolvers — the one `libp2p-node-base.ts` injects into the cluster service,
plus the connection-reading fallbacks in `cluster/service.ts` and `repo/service.ts`. A redirect
payload is merged by the recipient through the same `mergePeerAddresses`, so an ephemeral socket
there is undialable in exactly the same way.

Nothing changed about cohort selection, ordering, or the self entry. Connected-first ordering
stays; only outbound addresses can occupy the front. An inbound-only member with an empty peerStore
is now published with no address at all — correct, and no longer silent, because `addressless`
counts it.

## Review findings

### Verified the premise the whole fix rests on

The implementer flagged "is `direction` really always set by libp2p?" as the first thing to break.
Confirmed at the type level, not by sampling: `Connection.direction` is declared
`direction: MessageStreamDirection` (non-optional) in
`packages/db-p2p/node_modules/@libp2p/interface/dist/src/connection.d.ts:97`, and
`MessageStreamDirection = 'inbound' | 'outbound'` in the same package's `message-stream.d.ts:6`. It
is a property of the connection interface, not of any individual transport, so no per-transport
audit is needed.

### Swept every other place a connection becomes a published address

Four other `remoteAddr` reads exist in `packages/*/src`. Three are not producers:
`libp2p-key-network.ts:554` (`isLimitedConnection`) and `cohort-topic/stream-util.ts:48` both sniff
`/p2p-circuit` to make a *local* choice about which connection to use, and `libp2p-key-network.ts`'s
self entry publishes `getMultiaddrs()` (our own announce addresses), not a connection.

The fourth, `routing/libp2p-known-peers.ts:23` (`buildKnownPeers`), does build a peer-and-addresses
list from every connection regardless of direction. It is harmless today — nothing in the repository
calls it, and `routing/responsibility.ts` reads only `KnownPeer.id`, never `.addrs` — but it is a
public export from `src/index.ts` and `src/rn.ts`, so an embedder could reach it. Conditional, not a
defect, so it is parked as a `NOTE:` tripwire at the site rather than filed: if a caller ever hands
`KnownPeer.addrs` to a third party, route it through `publishableConnectionAddr` first.

### Fixed inline — the redirect paths had no test of their own

The handoff was honest that the three widened call sites shipped with no direct coverage: the
existing redirect specs stub `getConnectionAddrs` out, so they never reach the connection-reading
code. Closed with three tests, each verified to fail with the direction check neutered
(`if (false && conn.direction !== 'outbound')`) and each failing with the ephemeral source socket
visible in the diff:

- `cluster-service-node-resolvers.spec.ts` — two **real** nodes, one dial. The dialer holds the
  outbound half and the listener the inbound half of the same socket pair, so one dial yields both
  verdicts against the production `getConnectionAddrs` resolver in `libp2p-node-base.ts`, which had
  no coverage at all before. The listener must publish `[]` for the dialer; the dialer must publish
  exactly the address it dialled.
- `redirect.spec.ts` — `RepoService.checkRedirect` with no `getConnectionAddrs` injected, driving
  the connection-reading fallback directly.
- `cluster-service-redirect.spec.ts` — the same for `ClusterService`, reaching the fallback via
  `components.libp2p`.

### The scope widening was right, and one of the three is more load-bearing than the handoff said

The handoff offered to revert the three extra call sites and described all of them as fallbacks for
embedders. That is true of `ClusterService` — `libp2p-node-base.ts` injects `getConnectionAddrs`
into it — but **not** of `RepoService`. The node wiring gives the repo service `setLibp2p(node)` and
no `getConnectionAddrs` (`libp2p-node-base.ts:596-615`), so `repo/service.ts`'s connection-reading
`getPeerAddrs` *is* the production source of a repo redirect's addresses. Reverting that hunk would
have left the same bug live on the repo protocol. Kept, and now covered.

### Fixed inline — a doc the change should have touched

`docs/internals.md` § *Third-Party Address Learning* is the canonical prose home for this mechanism:
it enumerates every ingress, both caps, the trust boundary, and the `addressless` diagnostic. It
described only the **consumer** side — which addresses a node learns — and said nothing about which
addresses a node *puts into* those messages, which is exactly what this change decided. Added a
paragraph stating the producer rule (outbound connections, then peerStore; inbound contributes
nothing), naming the single predicate and all four producers, and pointing at
`packages/db-p2p/docs/cluster.md` § Access Control for the full rationale. Also noted there that the
`addressless` line is now load-bearing for that rule rather than a passive diagnostic.

`packages/db-p2p/docs/cluster.md` was already updated by the implementer and is accurate.
`packages/db-p2p/docs/repo.md`'s `findCluster` mention is a generic usage sample and is unaffected.

### Fixed inline — type safety on the new interface

`DirectionalConnection.direction` was typed `string`, which is looser than reality and would let a
typo'd stub compile into a silent "not publishable". Tightened to `'inbound' | 'outbound'` — the
same union libp2p declares, so a real `Connection` still satisfies it structurally — and the
table-driven case list in `peer-address-book.spec.ts` follows.

### Checked and found nothing to change

- **`MAX_MERGED_ADDRS_PER_PEER` interactions**, which the handoff left un-audited: nothing asserts a
  count this shifts. Full suite green.
- **`src/testing/cohort-topic-mesh-harness.ts`** — its `getConnections()` returns `[]`; unaffected.
- **The `capture-log.ts` addition** (`formatCaptured`/`hasLine`): correct, and the reasoning in its
  doc comment holds — `debug` resolves only its own `%o`/`%O`/`%j` before calling the sink, so
  `args[0]` still carries the literal `addressless=%d` and `hasTag` cannot see a substituted value.
- **The two new integration specs' reliance on `clusterSize`** (2 and 3, against the topology default
  of 1): confirmed load-bearing — the cohort keeps `clusterSize - 1` non-self members, so at 1 both
  would pass vacuously. `relay-inbound-source-address.spec.ts` already carries an explicit "this spec
  asserted nothing" guard for that failure mode; the joined case fails its poll and dumps the record.
- **Comment/prose volume**: the rationale for the direction rule is restated at some length in
  `peer-address-book.ts`, `docs/cluster.md`, `docs/internals.md`, four call sites and several spec
  headers. Dense, but it matches the established style of the surrounding code and docs in this
  package, so it was left alone rather than churned.

### Filed / deferred

No tickets filed. No `blocked/` items. The one conditional concern is parked as the `NOTE:` in
`libp2p-known-peers.ts` described above.

## Verification

- `yarn workspace @optimystic/db-p2p test` — **1835 passing, 44 pending, 0 failing** (1832 before
  this review pass; +3 from the new redirect-path tests).
- `yarn workspace @optimystic/db-p2p test:integration` — **30 passing, 2 pending**.
- `yarn lint`, `yarn build`, `yarn typecheck` from the repository root — all clean.
- Regression value of the new tests demonstrated, not assumed: with the direction check disabled,
  all three fail and each error message shows the ephemeral source socket being published.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Companion tickets (untouched)

`relay-cannot-dial-its-own-reservation-holders` (in `implement/`) names this ticket as a prereq and
adds a deliberately **different** predicate — "an address *we* can dial" — plus a self-relay count on
`findCluster:done`. Both belong in `peer-address-book.ts`. The one added here is named
`publishableConnectionAddr` and its doc comment frames it as the publish-side question, so the
distinction stays visible at each call site when the second lands.
