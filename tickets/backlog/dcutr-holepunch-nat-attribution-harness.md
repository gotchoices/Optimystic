description: Stand up an out-of-band NAT/netns harness that actually runs the strong DCUtR hole-punch assertion green AND attributes the direct connection to DCUtR (not plain autoDial).
prereq:
files: packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/src/libp2p-node-base.ts
----

## Problem

`dcutr-direct-upgrade.spec.ts` (test #2, gated behind `RUN_DCUTR_HOLEPUNCH=1` +
`DCUTR_HOST=<non-private ip>`) asserts the strong invariant — "within 60s,
`peerA.getConnections(peerB.peerId)` contains a non-`/p2p-circuit` connection" —
with no fallback. The review of `harden-dcutr-direct-upgrade-test` confirmed the
silent fallback is gone and the assertion fails-loud / skips-cleanly. Two gaps
remain that this assertion cannot close in its current single-process form:

1. **Never run green.** The assertion has only ever been exercised through its
   skip path and its `assertRoutableHost` fail-fast guard — never through a
   genuine upgrade. The agent host is Windows loopback only; no non-private
   bound, NAT'd address is available.

2. **Attribution gap (the important one).** The test runs all three nodes in a
   single process. `createLibp2pNodeBase` sets `connectionManager.autoDial: true`
   with `minConnections: 1` (`libp2p-node-base.ts:219-225`). On a routable host
   with **no NAT**, once peerA learns peerB's direct multiaddr via identify over
   the circuit, an ordinary direct dial to that address *succeeds* — so a
   non-`/p2p-circuit` connection can form via plain autoDial rather than DCUtR's
   simultaneous-open hole-punch. The assertion ("a direct connection exists")
   does not distinguish the two. Removing `@libp2p/dcutr` entirely would not
   necessarily fail this test in a non-NAT environment.

   `assertRoutableHost` only rejects obviously-private prefixes; it does **not**
   enforce the discriminating condition — that inbound-direct is blocked except
   via hole-punch. Correct attribution to DCUtR therefore depends on the runtime
   environment genuinely having NAT (where a naive direct dial to peerB would be
   blocked and only the coordinated hole-punch traverses), and nothing in the
   test or guard enforces that.

Secondary: the spec header suggests "a cloud VM's public NIC IP" as a `DCUTR_HOST`
value, but on most clouds (AWS/GCP) the public IP is external NAT and is not
bindable on the local NIC — binding `/ip4/<public>/tcp/0` fails `EADDRNOTAVAIL`.
The only realistic runnable environment is a container / network-namespace with a
public-range address behind a NAT/firewall. Reconcile the header guidance with
that reality.

## What's needed

Stand up an out-of-band (NOT agent-runnable; multi-host or netns) job that:

- Creates a topology where peerA and peerB are mutually reachable **only** through
  the relay initially, and a naive direct dial between them is **blocked** (real
  NAT / firewall / separate netns with a NAT hop) — so a resulting direct
  connection is attributable to DCUtR's hole-punch and nothing else.
- Runs `RUN_DCUTR_HOLEPUNCH=1 DCUTR_HOST=<routable ip>` and confirms the strong
  test goes **green** (not merely compiles).
- Ideally hardens attribution in the test itself: e.g. assert the direct
  connection's `remoteAddr` is the expected peer-direct addr, and/or run a
  control where DCUtR is disabled and confirm the test then *fails* (proving the
  upgrade is DCUtR-driven, not autoDial). Consider whether `autoDial` should be
  disabled for this specific topology so only DCUtR can produce the direct path.
- Wire it into CI as a separate infra job (the agent-runnable suite must keep
  skipping it). Update the spec header guidance about `DCUTR_HOST` bindability.

Do **not** re-introduce any "assert-strong-if-observed, else warn" fallback —
that was the anti-pattern the prior ticket removed. If the single-process
topology proves unable to attribute cleanly even with NAT, move the assertion to
a true multi-process / multi-host harness.
