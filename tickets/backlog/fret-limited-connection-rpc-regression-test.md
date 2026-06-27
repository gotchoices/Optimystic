description: The fix that lets peer-discovery talk over a relay-only link has no automated test, so a future change could silently break it again.
prereq:
files:
  - C:/projects/Fret/packages/fret/src/rpc/protocols.ts                     (openRpcStream + isLimitedConnection — the untested code)
  - C:/projects/Fret/packages/fret/test/                                    (where a Fret-level unit test would live)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts  (the acceptance spec that does NOT exercise the fix)
  - packages/db-p2p/test/util/relay-topology.ts                             (relay/circuit test helpers)
difficulty: medium
----

# Add a regression test for FRET RPCs over limited (circuit-relay) connections

## Problem

The `p2p-fret-rpc-over-limited-connection` change (Fret `0.5.1`, commit
`f46c82e` in the sibling `C:/projects/Fret` checkout) added `openRpcStream` /
`isLimitedConnection` in `rpc/protocols.ts` so the four FRET wire RPCs
(`neighbors`, `ping`, `maybeAct`, `leave`) open their libp2p stream with
`{ runOnLimitedConnection: true }` and can therefore run over a circuit-relay
("limited") connection.

**That code has no automated coverage anywhere:**

- The upstream fix commit (`f46c82e`) added **no test** — it only touched the
  four RPC modules + `protocols.ts` + a version bump.
- The optimystic acceptance spec
  (`multi-coordinator-write-relay.integration.spec.ts`) does **not** exercise
  it: that 3-node topology (A, B, relay) converges FRET state via
  `peer:connect` upserts regardless of whether the direct A↔B RPC works, so the
  spec passes either way. The implementer confirmed this explicitly during
  review.

The fix's only validation to date was **temporary stderr instrumentation**
(a one-off run showing ~81 RPC stream opens succeeding over LIMITED connections),
which was removed. If `openRpcStream` regresses — e.g. someone drops
`runOnLimitedConnection`, or libp2p changes how limited connections are stamped
and `isLimitedConnection` stops detecting them — nothing turns red.

## What's wanted

A deterministic-ish test that isolates a FRET wire RPC actually running over a
limited connection, where the transitive `peer:connect` path does NOT already
populate the ring. Two viable shapes (pick one or argue for another):

1. **Fret-level unit test** (preferred — closest to the code, fastest, lives in
   the repo that owns the fix): drive `openRpcStream` against a mock/stub
   `Libp2p` whose `getConnections` returns (a) only a limited connection, (b) a
   mix of direct + limited, (c) no connection. Assert: limited-only opens with
   `runOnLimitedConnection: true`; direct is preferred when both exist; the
   `requireExisting` path returns `undefined` with no connection while the
   non-`requireExisting` path falls through to `dialProtocol`. Also unit-test
   `isLimitedConnection` (the `limits != null` branch and the `/p2p-circuit`
   multiaddr-sniff fallback).

2. **db-p2p integration test**: a topology where a peer is reachable **only**
   transitively (e.g. a 4th node that A/B never `peer:connect` to directly), so
   the only way its coordinate enters the ring is a FRET RPC succeeding over the
   relay. Pre-fix this would fail to converge; post-fix it converges. Heavier
   and slower than option 1; gate on `OPTIMYSTIC_INTEGRATION`.

## Notes

- This is a hardening follow-up, not a bug — the fix is verified working via the
  instrumentation evidence; this just makes the guarantee durable.
- If option 1 is chosen, the work lands in the Fret repo, not optimystic; track
  it here but expect the actual commit there. Coordinate with the
  publish-`p2p-fret@0.5.1` step (the portal resolution currently masks the
  unpublished version).
