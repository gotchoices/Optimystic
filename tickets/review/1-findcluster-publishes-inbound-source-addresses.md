description: A machine used to hand out its neighbours' temporary return-path sockets as if they were real addresses, so other machines wasted connection attempts on ports nobody could reach. It now only shares addresses it dialled itself, and the health counter that was supposed to catch this finally reports the problem.
prereq:
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/docs/cluster.md, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/relay-inbound-source-address.spec.ts, packages/db-p2p/test/relay-third-party-address-gap.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/support/capture-log.ts
difficulty: medium
----

# Review: `findCluster` no longer publishes an inbound connection's source socket

Implements the ticket of the same slug (upstream [gotchoices/Optimystic#13](https://github.com/gotchoices/Optimystic/issues/13)).

## What changed

**One new predicate, in `peer-address-book.ts`.** `publishableConnectionAddr(conn, log)` returns a
live connection's `remoteAddr` **only when `conn.direction === 'outbound'`** and the string parses
as a non-empty multiaddr; otherwise `undefined`. It sits next to `validMultiaddrStrings`, and the
two now share a private `isCarriableMultiaddrString` helper so "is this string an address at all"
has one implementation. The doc comment states the reason: an inbound connection's `remoteAddr` is
the far side's ephemeral source socket, not anything it listens on.

A missing `direction` is treated as **not** publishable. Real libp2p always sets it, so this only
affects hand-built stubs — deliberately, so a stub cannot silently re-enable the old behavior.

**Four call sites now go through it.** The ticket named one; three more turned up during
implementation and are the same defect at a different address consumer (see *Scope I widened*):

| site | what it feeds |
|---|---|
| `libp2p-key-network.ts` `getConnectedAddrsByPeer` | the `ClusterPeers` map `findCluster` publishes |
| `libp2p-node-base.ts` `getConnectionAddrs` (cluster service wiring) | redirect payload addresses |
| `cluster/service.ts` `getPeerAddrs` fallback | redirect payload addresses when no resolver is injected |
| `repo/service.ts` `getPeerAddrs` fallback | same, on the repo protocol |

Nothing else changed about ordering, cohort selection, or the self entry. Connected-first ordering
stays; only outbound addresses can now occupy the front.

**The `addressless` diagnostic became load-bearing.** It counts cohort members with *zero* parsed
addresses, so before this change an entry holding one bad address never counted — the reporter
measured `addressless=0` on 1,383 of 1,389 lookups while nearly every dial failed. With the filter
in place an inbound-only member with an empty peerStore yields zero addresses, so
`findCluster:addressless-members` fires during exactly that window. Tests pin it.

## Where to poke first

Two things a reviewer should try to break:

1. **Is `direction` really always set by libp2p?** The whole fix rests on it. I read
   `@libp2p/interface`'s `Connection.direction` as non-optional and every real connection in the
   loopback specs carried it, but I did not audit every transport.
2. **Does anything legitimately need an inbound address published?** I argued no — the peer's own
   advertised addresses arrive via identify/identifyPush and are published from the peerStore
   instead — and the specs below cover the steady state. The risk if I am wrong is a member that
   publishes no address at all where it used to publish a (bad) one; that is visible now, not
   silent, because `addressless` counts it.

## Testing done

`yarn workspace @optimystic/db-p2p test` — **1832 passing, 44 pending**.
`yarn workspace @optimystic/db-p2p test:integration` — **30 passing, 2 pending** (run because the
redirect address path changed; the redirect round-trip cases are in there).
`yarn lint`, `yarn build`, `yarn typecheck` from root — all clean.

### Every new test was verified to fail before the fix

I temporarily neutered the direction check (`if (false && conn.direction !== 'outbound')`) and
re-ran. Results, so the reviewer does not have to take "it's a regression guard" on faith:

- `peer-address-book.spec.ts` — 3 of the 8 table rows failed (inbound direct, inbound circuit-composed, no-direction).
- `libp2p-key-network.spec.ts` — 3 of the 5 new cases failed.
- `relay-inbound-source-address.spec.ts` — failed with **31 consecutive samples** from +101 ms to
  +1025 ms carrying `/ip4/127.0.0.1/tcp/51601/ws/p2p/<client>`, i.e. the client's source port. That
  is the upstream symptom reproduced on loopback, and the ~1 s window the report describes.

### New / changed specs

- **`test/peer-address-book.spec.ts`** — table-driven over `publishableConnectionAddr`: direct
  outbound, circuit outbound, direct inbound, circuit-composed inbound, unparseable, empty string,
  no address, no direction. `{RELAY}`/`{DIALER}` placeholders are substituted with freshly generated
  peer ids *inside* each case — a literal placeholder makes a `/p2p/` component unparseable, and the
  circuit rows would then pass for the wrong reason.
- **`test/libp2p-key-network.spec.ts`** — new describe `findCluster() — only outbound connections
  contribute addresses`: inbound-only + empty peerStore → no addresses **and** `addressless=1` plus
  the `findCluster:addressless-members` line; inbound-only + populated peerStore → publishes the
  peerStore address; outbound → publishes `remoteAddr`; both directions → publishes the outbound
  address exactly once; outbound-over-circuit → published (the relay-only-self case, which is the
  easy way to write the predicate backwards).
- **`test/relay-inbound-source-address.spec.ts`** (new, ~1 s, not env-gated) — real relay + real
  relay-only client on loopback. Samples `R.keyNetwork.findCluster(key)` every 20 ms starting
  *before* the client boots, and asserts no sample ever carries an address for the client that is
  neither `/p2p-circuit` nor one the client itself advertises. It also asserts (a) at least one
  sample existed, so it cannot pass vacuously, and (b) the circuit address eventually *does* appear,
  so a filter that drops everything fails.
- **`test/relay-third-party-address-gap.spec.ts`** — added the joined case the header NOTE asked
  for, and replaced that NOTE. Relay + relay-only client + two host members: (A) `identifyPush`
  puts the circuit address in the relay's peerStore, (B) `findCluster` publishes it, (C) a
  never-connected third party ingests that **real** map through its own
  `services.cluster.processOperation` and its peerStore gains the address, (D) `dial(clientPeerId)`
  succeeds over the circuit. ~2 s.
- **`test/util/relay-topology.ts`** — `CLUSTER_SCAFFOLD` became `clusterScaffold(clusterSize = 1)`
  and the three spawn helpers accept a `clusterSize` override; they now return `OptimysticNode`
  instead of `Libp2p` so a spec can reach `.keyNetwork`. Both are widenings — existing callers are
  untouched.
- **`test/support/capture-log.ts`** — added `formatCaptured` / `hasLine`. `debug` resolves only its
  own formatters (`%o`, `%O`) before calling the sink and leaves `%s`/`%d` for downstream, so
  `args[0]` still reads `addressless=%d`. Asserting on a *value* in a log line needs the
  substituted text; the existing `hasTag` only ever sees the template. Worth a look — this trap
  will catch the next person who asserts on a log payload.
- **`docs/cluster.md`** — new bullet under *Access Control* stating which addresses a published
  record carries (outbound-connected, then peerStore), why inbound is excluded, why the narrower
  "keep inbound `/p2p-circuit`" rule was rejected, and that redirect payloads obey the same rule.

## Scope I widened, and why — please weigh this

The ticket scoped the fix to `findCluster` and asserted it would be "the only caller for
connection-derived addresses". That was not true of the tree: **three other sites** built
third-party-facing address lists from every connection regardless of direction —
`libp2p-node-base.ts`'s `getConnectionAddrs` (the production wiring for redirect targets) and the
connection-reading fallbacks in `cluster/service.ts` and `repo/service.ts`. A redirect payload's
addresses are merged into the recipient's peerStore by the same `mergePeerAddresses`, so an
ephemeral source socket there is undialable in exactly the same way.

I fixed them with the same predicate rather than filing a follow-up, because leaving them would
defeat the ticket's own stated design goal ("one definition, one site, so a future call site cannot
re-derive a permissive version"). **This is the part of the diff the ticket did not ask for.** If
the reviewer disagrees, reverting those three hunks is independent of the `findCluster` fix.

Honest gap in that widening: the redirect sites have **no new test of their own**. The existing
redirect specs (`cluster-service-redirect.spec.ts`, `redirect.spec.ts`) inject `getConnectionAddrs`
as a stub, so they never exercise the connection-reading code I changed; the integration redirect
round-trips pass but do not isolate direction. A `debt-` ticket for direction coverage on the
redirect payload path would be reasonable — I did not file one, since the reviewer may prefer to
revert instead.

## Other things a reviewer should check

- **`MAX_MERGED_ADDRS_PER_PEER` interactions** — the ticket asked whether any test asserts an exact
  address count that this shifts. The full suite passes, but I did not audit count assertions
  exhaustively; I relied on the suite.
- **`src/testing/cohort-topic-mesh-harness.ts`** — checked, its `getConnections()` returns `[]`, so
  nothing there depended on inbound addresses being published. No change needed.
- **The joined case is in-process at one hop.** The record handed to the third party in step (C) is
  the real `ClusterPeers` map from the relay's `findCluster`, but it reaches
  `processOperation` in-process rather than across a socket. The serialization hop is covered
  separately (`two-node-convergence.integration.spec.ts`). This is stated in the spec header;
  disagree with the tradeoff if you think the socket hop matters here.
- **The joined case relies on ordering to stay realistic.** The third party joins the mesh *after*
  the record is produced, so it is genuinely outside that key's cohort and the record reaches it as
  a redirect. If it joined earlier it would be in `published`, and `processOperation` would take the
  consensus path and reject on `Message hash mismatch` (an unsigned, hand-wrapped record). The
  comment says so, but it is a load-bearing ordering that a future edit could break innocently.
- **`clusterSize` in the new specs is not incidental.** The cohort reserves a slot for self and
  keeps `clusterSize - 1` others, so at the topology default of 1 every cohort is self-only and both
  new integration specs would pass vacuously. They pass 2 and 3 respectively. If either ever stops
  seeing the client in the record, that is the first thing to check — and
  `relay-inbound-source-address.spec.ts` has an explicit "this spec asserted nothing" guard for it,
  while the joined case would fail its poll with the last record dumped.
- **No tripwires were parked.** Nothing conditional came up that warranted a `NOTE:`.

## Companion tickets (not touched)

`relay-cannot-dial-its-own-reservation-holders` names this ticket as a prereq and adds a second,
deliberately different predicate — "an address *we* can dial" — plus a self-relay count on
`findCluster:done`. Both predicates are meant to live in `peer-address-book.ts`; the one added here
is named `publishableConnectionAddr` and documented as the publish-side question, so the distinction
should be visible at each call site when the second lands.
