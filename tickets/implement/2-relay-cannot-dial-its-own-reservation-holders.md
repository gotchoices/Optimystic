description: A machine that acts as a relay for phones behind a home router ends up knowing those phones only by an address that routes back through itself, which it obviously cannot use. It keeps trying anyway, and the resulting failure looks identical to "we were never told an address", so the logs cannot tell the two apart and retrying can never help.
prereq: findcluster-publishes-inbound-source-addresses
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/util/relay-topology.ts
difficulty: medium
repro: verified
----

# A relay holds only self-relay addresses for its own reservation holders

Upstream report: [gotchoices/Optimystic#14](https://github.com/gotchoices/Optimystic/issues/14),
companion to #12 and #13. Filed separately from the sibling ticket because the fix is a different
shape: this one is about **which node may use an address**, not about which address gets published.

## What happens

When a relay-only peer `C` reserves a circuit on relay `R`, the address `C` advertises — and
therefore the address `R` learns through `identifyPush` and stores — is:

```
/<R's transport addr>/p2p/<R's peer id>/p2p-circuit
```

That is correct, and useful to everyone **except `R`**. To use it, `R` would have to relay to `C`
through itself. Every candidate is rejected and the dial fails with a *non-empty* address book.

So a dial failure on a relay is ambiguous: it can mean "nobody ever taught us an address", or it can
mean "the only addresses we hold route back through us". Any retry or backoff added in response to
#12 does nothing for the second case, because retrying never makes a self-relay address usable by the
node holding it.

## What was measured

Two four-node device runs on 0.24.0 (two Android emulators behind the emulator NAT, two Node drones
providing relay), with the dial path instrumented to dump the peerStore entry, the live connections,
and the requesting protocol on every failure:

| | run 3 | run 4 |
|---|---|---|
| dial failures with a populated peerStore | 1 | 46 |
| of those, every held address self-relay | 1 of 1 | 44 of 46 |
| remainder | — | 2 `TimeoutError`, different cause |
| dial failures with an empty peerStore | 1,299 | 2,283 |

Every `/p2p-circuit` address the relay held or published for a reservation holder in run 3 — all
1,300 — routed through the relay's own peer id. Both causes are live at once and the error text does
not separate them, which is what made this hard to see.

The reporter also flags, and could not explain, that on device this surfaced as
`NoValidAddressesError` while their isolated repro produces an `AggregateError` of per-address
`Can not dial self`. Both are consistent with libp2p's dial queue: `calculateMultiaddrs`
(`libp2p/dist/src/connection-manager/dial-queue.js:253`) throws `NoValidAddressesError` when *no*
candidate survives the transport filter (`dialTransportForMultiaddr(...) == null`), and otherwise
lets each candidate fail individually — so whether the circuit transport is registered as a dialer on
that node decides which surface you see. Treat the error *name* as environment-dependent and the
self-relay address book as the reliable signal.

## The fix

**Fail fast, accurately, before dialing.** In `Libp2pKeyPeerNetwork.connect`
(`libp2p-key-network.ts:558-589`), the existing-connection path is unchanged — a live connection,
direct or limited, is still preferred and still used. Only on the cold path, before
`this.libp2p.dialProtocol(...)` at line 589, read the peerStore entry for the target and classify:

- **At least one address not routed through self** → dial exactly as today.
- **Non-empty, and every address routed through self** → throw a distinct, typed error immediately
  and skip the doomed dial. The message must name the condition: this peer is reachable only through
  a circuit on *this* node, and once the client's connection drops only the client can re-initiate.
- **Empty** → dial as today, so libp2p still produces its own `NoValidAddressesError` and nothing
  about the genuinely-unknown case changes.

**Self-relay detection is a multiaddr-component check, not a substring match.** Parse the address,
find the `p2p-circuit` component, and compare the `p2p` component immediately preceding it against
our own peer id. A substring test on `/p2p/<self>/p2p-circuit` is close, but breaks on the address
forms where the peer id is appended, absent, or repeated.

**Two predicates, deliberately different.** The sibling ticket adds "publishable to a third party";
this one adds "dialable by us". A self-relay address is *publishable* (siblings need it — that is
#11's working path) and *not dialable by us*. Both live in `peer-address-book.ts`; name them so the
call sites cannot be confused, and do **not** filter self-relay addresses out of what `findCluster`
publishes.

**Make the cohort diagnostic tell the two apart.** `findCluster`'s `addressless` counter (repaired by
the sibling ticket) counts members with no address at all. Add the second condition alongside it:
members for whom we hold addresses but every one routes through us. Report it on the same
`findCluster:done` line so one log line distinguishes "never taught" from "taught something we cannot
use".

**Deliberately out of scope: making the relay reach these peers.** Once a reservation holder's
connection drops, only the client can re-initiate — there is no address the relay could synthesize
that would work. Failing fast lets the caller's existing retry/exclude logic move to another cohort
member instead of burning a dial timeout. Do not add reconnect or re-reservation logic here.

## Cost

One `peerStore.get` on the cold dial path only — the path that is about to open a new connection
anyway. `connect` becomes `async` (it currently returns a promise from a synchronous body); the
existing-connection fast path must not gain an awaited peerStore read.

## Edge cases & interactions

- **Peer with both a self-relay address and a direct address** → dials normally; the check must not
  fire.
- **Peer with a live limited (relayed) connection to us** → handled by the existing-connection path
  before any of this; `runOnLimitedConnection: true` behavior is unchanged.
- **Our own node is relay-only** → its peers' addresses route through *some other* relay, never
  through us; the check must not fire. A spec should pin this, since it is the easy way to write the
  predicate backwards.
- **Multi-hop or unusual address forms** — `/p2p-circuit` with no trailing `/p2p/<peer>`, a peer id
  appended by libp2p's dial queue, two circuit components — must all classify without throwing.
- **Error propagation**: confirm the new error travels through `ProtocolClient.processMessage` and the
  cluster/repo/sync callers the same way a `NoValidAddressesError` does today — the member must be
  excluded and the operation must proceed with the rest of the cohort, not fail the whole write. If
  any caller matches on the error *name*, that match must be updated rather than left to fall through
  to a generic path.
- **`AbortSignal`**: the caller's signal must still be honored on the cold path, including during the
  peerStore read.
- **Interaction with the sibling ticket**: with inbound source addresses no longer published, a relay
  that holds nothing but self-relay addresses is the *remaining* failure mode on this path — expect
  the counter added here to be non-zero in exactly the topology #12 described.
- **Related but distinct**: `tickets/backlog/debt-shared-limited-connection-dial-options.md` covers
  dial *options* (`runOnLimitedConnection`, dropped `AbortOptions`) at other stream-open sites. It
  touches the same file and should not be merged into this work, but whoever implements this should
  read it before restructuring `connect`.

## Tests

- Unit, `test/libp2p-key-network.spec.ts`: with no live connection and a peerStore holding only
  `/…/p2p/<self>/p2p-circuit` addresses, `connect` rejects with the new error and `dialProtocol` is
  never called; with one non-self address present it dials; with an empty peerStore it dials (and the
  existing behavior is preserved).
- Unit, `test/peer-address-book.spec.ts`: the self-relay predicate, table-driven over the address
  forms in the edge-case list, including the relay-only-self case that must classify as *not* self-
  relay.
- Unit: `findCluster` reports the new "held, but all self-relay" count on `findCluster:done`, and does
  **not** drop those addresses from the published record.
- Integration, real loopback via `test/util/relay-topology.ts`: relay `R`, relay-only `C` reserving on
  it, and a control arm `H` — an ordinary host peer with real listen addresses. Wait for `R` to hold a
  `/p2p-circuit` address for `C`, then stop both `C` and `H` so neither can re-dial while their
  address-book entries survive. Assert `R` holds only self-relay addresses for `C`, that
  `R.keyNetwork.connect(C, protocol)` rejects promptly with the new error, and that the control arm
  `H` fails *differently* — without the control, the error would not be telling us anything about the
  address. (Stopping the peer matters: a live relay-only client immediately re-dials the relay and the
  dial then succeeds over the fresh connection.)

## TODO

- Add the "dialable by us" / self-relay predicate to `packages/db-p2p/src/peer-address-book.ts`,
  component-based, with a doc comment explaining why a relay cannot use its own circuit address.
- Add the cold-path pre-dial check to `Libp2pKeyPeerNetwork.connect`, with a distinct typed error and
  a log line naming the condition; keep the existing-connection fast path free of the peerStore read.
- Add the self-relay-only count to `findCluster:done`, without changing what the record publishes.
- Trace the new error through `ProtocolClient` and the cluster/repo/sync callers; confirm exclude-and-
  continue behavior matches the `NoValidAddressesError` path, and adjust any name-based matching.
- Add the unit specs above.
- Add the relay/relay-only/control-arm integration spec.
- Update `packages/db-p2p/docs/cluster.md` if it describes dial failure causes, so "held, but all
  self-relay" is documented as a distinct outcome.
- Run `yarn workspace @optimystic/db-p2p test`, plus repo lint and typecheck.
