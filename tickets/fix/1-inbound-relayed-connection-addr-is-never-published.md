description: A NAT'd peer that reaches us through a relay has a perfectly good address we could hand to a third party, and we now throw it away. A recent fix correctly stopped publishing the ephemeral source socket of an inbound connection, but it rejects every inbound connection by direction alone — including relayed ones, whose remote address is a real, dialable circuit address.
prereq:
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/redirect.spec.ts
difficulty: medium
repro: suspected
----

# An inbound *relayed* connection's address is dialable, and we discard it

`publishableConnectionAddr` (`peer-address-book.ts:96`) is:

```ts
if (conn.direction !== 'outbound') return undefined
```

The reasoning behind that line is sound and is written out at length above it: for an **inbound
direct** connection, `remoteAddr` is the far side's ephemeral source socket — the port their OS
picked for this one connection. Reachable by nobody, indistinguishable from a listen address once
it is on the wire, and it burns a slot against `MAX_MERGED_ADDRS_PER_PEER`. Publishing it to a
third party was a real defect and `1-findcluster-publishes-inbound-source-addresses` was right to
stop it.

**But `direction` is the wrong discriminator for the relayed case.** An inbound connection accepted
over circuit-relay v2 has a `remoteAddr` of the shape

```
/ip4/<relay>/tcp/<port>/ws/p2p/<relayId>/p2p-circuit/p2p/<remotePeer>
```

Nothing in that is ephemeral. It names the relay, and the relay is exactly how a third party is
*supposed* to reach a NAT'd peer. It is the same address the peer would publish for itself. We
reject it solely because the connection arrived rather than left.

So the current rule says: **a peer reachable only through a relay has no publishable address at
all**, from any node it dialed. That is precisely the peer that most needs one.

## Why this is filed now

Sereus's `push-wake-e2e` scenario 4 (`wakes a member whose authorization and address were learned
by control-DB replication, not local seeding`) went from **green twice on 2026-08-18** to **red 7 of
7 on 2026-08-22**, always with

```
Block default/OwnerKey is unavailable (claimed-elsewhere):
the repo could not determine whether it exists
```

The only thing that moved underneath it in that window is this repo, `0.24.0` → `0.24.2`, and
`1-findcluster-publishes-inbound-source-addresses` (`a8f64d0`) is in that range. The scenario's
receiver is deliberately, genuinely NAT'd — it holds no direct listen address and is reachable only
through a relay reservation — which is the exact shape this rule now blanks out. `claimed-elsewhere`
is the verdict a coordinator returns when a block is claimed but it cannot reach a holder to
confirm, so "the holder's address is no longer published" is a mechanism that fits the symptom.

**`repro: suspected`, deliberately.** The correlation is strong and the mechanism is plausible, but
nobody has yet watched a redirect payload lose a circuit address and then watched the read fail.
The first job of this ticket is to *prove or kill* that link — do not start editing on the strength
of the paragraph above.

## Suggested shape, if the premise holds

Replace the direction test with a direction-**and**-shape test: an outbound connection's
`remoteAddr` stays publishable as it is today; an inbound one is publishable **only** if it is a
circuit address. This file already knows how to answer that question properly — the walk described
at `peer-address-book.ts:118-141` decides `p2p-circuit` by inspecting components rather than
matching on the string, and there is an existing self-relay check to reuse. Do not add a second,
string-matching notion of "is a circuit address".

Two things to keep from the fix that introduced this:

- **A missing `direction` must stay non-publishable.** That default exists so a hand-built test stub
  cannot silently opt back into the old behavior.
- **The self-relay exclusion still applies.** An address that reaches the peer by relaying through
  *us* is useless to us and misleading to others; `SelfDialability` already models this.

## Done means

- A test with two real nodes and one dial — the listener publishing the dialer's address — where the
  dial is made over a relay and the listener publishes the circuit address. The existing
  `cluster-service-node-resolvers.spec.ts` already builds the direct version of exactly this and is
  the right place.
- The direct-inbound case still publishes nothing. Neuter the new condition and watch both tests
  fail, the way the original fix's tests were verified.
- A note back to the sereus ticket `block-held-by-only-one-machine-is-unreadable` saying whether
  this was the cause, **either way** — a clean refutation is worth as much here as a fix, because
  that ticket's own stated unblock condition has already been met once and the symptom did not move.
