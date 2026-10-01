description: A relayed dial through a relay the dialer is not already connected to first opens the connection to the relay, inside libp2p's per-address limit and inside our RPC dial deadline. Both are sized for the warm case (the relay connection already open), so at the supported 3 s round trip this cold dial runs out of time. Sereus confirms it is the normal case for it, not an edge case.
files:
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `CONNECTION_ROUND_TRIPS`, `DIAL_ROUND_TRIPS`, and the `NOTE:` above them, which this ticket replaces)
  - packages/db-p2p/src/libp2p-node-base.ts (`connectionManager`, `NodeOptions.linkRoundTripMs` and `NodeOptions.connectionManager` docs)
  - packages/db-p2p/test/link-deadlines.spec.ts
  - packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts and test/util/delay-proxy.ts (the fixture to reuse)
  - packages/db-p2p/readme.md (deadline table)
source: sereus-ec, reply to the address-dial-timeout fix (8f073cb0); sereus's own counterpart is its backlog/23-bug-relayed-dial-budget-omits-opening-the-relay-connection
----
# A relayed dial through an unconnected relay outruns its deadlines

## Report

The `NOTE:` above `CONNECTION_ROUND_TRIPS` in `rpc-deadline.ts`, left by
`complete/a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`, said the derived deadlines assume the
connection to the relay is already open, and to size them for the cold path "if relayed dials ever go
through a relay this node is not already connected to". Sereus says they do, routinely:

- Phones hold reservations on more than one relay, and an invitation lists every circuit address the
  inviter has.
- A joiner usually dials the inviter through the inviter's relay, which the joiner is often not
  connected to.
- Party-run relays (an always-on node acting as its party's relay) make this the normal case.

## What the cold path costs

The review of the earlier ticket checked that the circuit transport opens a missing relay connection
under the caller's per-address signal. So inside ONE `addressDialTimeout`, and inside the RPC
`dialTimeoutMs`, the dial pays for:

1. the connection to the relay: TCP or WebSocket open, multistream for the encrypter, noise, multistream
   for the muxer;
2. the circuit hop and stop;
3. the relayed connection's upgrade, end to end (multistream, noise, multistream);
4. for the RPC dial, the stream negotiation on top (1 round trip).

The warm path is only 2 and 3 (about 4 round trips), which is what `CONNECTION_ROUND_TRIPS = 5` (4 plus one
of margin) covers. The cold path is roughly 7 to 8 round trips, before any margin.

Sereus also counts an admission decision at the relay's gate and another at the target's (about 2 s each
in sereus's own budget, `link-budget.ts`). These are application-level costs that optimystic cannot know.

## To decide in the fix stage

- **What `linkRoundTripMs` measures for the relay leg.** Its doc says "the slowest round trip … between any
  two nodes that will talk to each other, relayed hops included". The dialer-to-relay leg is one hop of a
  relayed path, so its round trip is at most the declared value. Bounding the cold-path legs by the
  declared value overestimates, but that is the only number we have. Say this in the doc.
- **Size for the cold path, or count it separately.** Sereus offers both:
  - raise the per-address limit and the RPC dial deadline to cover the cold path everywhere;
  - add the relay leg only when no connection to the relay is open.

  libp2p takes one `addressDialTimeout` for every address, so the second option is not available at
  libp2p's per-address limit. It would only apply to our own RPC dial deadline, which can check
  whether this node holds a connection to the circuit address's relay before it dials. Consider whether
  sizing every dial for the cold path costs anything real. A longer limit only delays the failure
  of a dial that is going to fail anyway: an unreachable address waits longer before the next one is
  tried, and a dead coordinator is re-picked later. Measure or reason about that against
  `DEFAULT_*` floors and the read path's budgets, which derive from the same round trip.
- **Application admission time.** Decide whether an embedder needs a way to add a per-hop allowance
  (for example `NodeOptions.linkAdmissionMs`, counted once per gate a dial crosses), or whether
  `connectionManager.addressDialTimeout` plus a caller's own `dialTimeoutMs` already let sereus cover it.
  Do not invent a knob sereus has not asked for. Sereus's budget work in its own repository may answer
  this, so ask sereus-ec through the maintainer if it is unclear.
- **Keep the floors.** An undeclared round trip must still yield exactly the LAN deadlines.

## Tests

- `link-deadlines.spec.ts` pins the new multiples.
- If feasible within a couple of seconds, extend the delay-proxy fixture so that a relay-shaped dial,
  where the dialer is not connected to the relay, succeeds within the derived per-address limit at a
  scaled-down round trip. If a real circuit relay in-process is too slow or flaky for the default suite,
  gate it under `RUN_LONG_TESTS=1` and say so in the spec header, the way the other relay specs do.

## After release

This goes in the same release as `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` if possible.
Tell sereus-ec the version.
