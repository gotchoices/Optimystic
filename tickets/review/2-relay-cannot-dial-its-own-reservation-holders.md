description: A machine acting as a relay for phones behind a home router knew those phones only by an address that routed back through itself, kept trying to use it anyway, and reported the failure in words indistinguishable from "we were never told an address". It now recognises that state before dialing and says so.
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/relay-self-relay-only-dial.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md
difficulty: medium
----

# Review: a relay now fails fast on peers it can only reach through itself

Upstream: [gotchoices/Optimystic#14](https://github.com/gotchoices/Optimystic/issues/14). Companion to
the already-landed `findcluster-publishes-inbound-source-addresses` (#13).

## The condition, in one paragraph

When a relay-only client reserves a circuit on a relay `R`, the only address it can advertise is
`/<R's transport addr>/p2p/<R's peer id>/p2p-circuit`. Every node in the mesh can use that address
except `R`, which would have to relay to the client through itself. So `R` holds a **non-empty**
address-book entry it can never dial, and libp2p reports the resulting failure with the same text as
"nobody ever taught us an address". Only the second condition is ever repaired by a retry — once the
client's connection drops, only the client can re-initiate — so the two had to be separated.

## What changed

**`peer-address-book.ts`** gained the "can *we* dial this?" question, deliberately separate from the
existing "may we publish this to a third party?" (`publishableConnectionAddr`). A self-relay address
is *publishable* — a cohort sibling reaching the client through our relay is the working path — and
simply not dialable by the one node the circuit terminates on.

- `routesThroughRelay(addr, relayPeerId, log)` — walks the multiaddr's **components** and returns
  true when any `p2p-circuit` marker is immediately preceded by a `p2p` component naming
  `relayPeerId`. Not a substring test: the target peer id appended after the marker, a circuit
  naming no relay, and multi-hop chains all read differently as text.
- `classifySelfDialability(addrs, selfPeerId, log)` → `'none' | 'self-relay-only' | 'dialable'`.

**`Libp2pKeyPeerNetwork.connect`** is now `async` and, on the **cold** path only, reads the peerStore
once and refuses the dial when the verdict is `self-relay-only`, throwing the new
`SelfRelayOnlyAddressesError` (`code = SELF_RELAY_ONLY_ADDRESSES`, exported from the package root).
Empty peerStore still dials, so a genuinely-unknown peer keeps libp2p's own error. The warm path (a
live direct or limited connection) is untouched and pays no peerStore read.

**`findCluster`** counts the condition as `selfRelayOnly` on `findCluster:done`, alongside the
existing `addressless`, plus a `findCluster:self-relay-only-members` line when non-zero. It does
**not** drop those addresses from the published record.

**Docs**: `packages/db-p2p/docs/cluster.md` § "Which Addresses *We* Can Dial (Not The Same Question)"
and a paragraph in `docs/internals.md` next to the existing producer rule.

## How to validate

```
yarn workspace @optimystic/db-p2p test          # 1866 passing, 44 pending
yarn workspace @optimystic/db-p2p test:integration  # 30 passing, 2 pending
yarn lint && yarn build && yarn typecheck        # all clean
```

**The load-bearing check.** Comment out the `await this.assertNotSelfRelayOnly(...)` call in
`connect` and re-run `test/relay-self-relay-only-dial.spec.ts`. It must fail with
`AggregateError: All multiaddr dials failed` — the pre-fix behavior, over real sockets. That was run
and observed during implementation; it is the evidence that the integration spec is a guard rather
than a tautology.

Note the observed error was an `AggregateError`, **not** the `NoValidAddressesError` the upstream
report also mentions. Both are expected: libp2p's `calculateMultiaddrs` throws
`NoValidAddressesError` only when *no* candidate survives the transport filter, and otherwise lets
each candidate fail individually. Treat the error name as environment-dependent; the address book is
the reliable signal.

**Manual/field validation.** On a real relay serving relay-only clients, `optimystic:db-p2p:*` debug
output should now show `findCluster:done ... addressless=N selfRelayOnly=M` with `M > 0` in exactly
the topology #12 described, and `connect:self-relay-only peer=… protocol=… addrs=…` in place of a
burned dial timeout. A caller-visible dial failure appears on `ProtocolClient`'s line as
`dial:fail … code=SELF_RELAY_ONLY_ADDRESSES` instead of `code=none`.

## Error propagation — what was checked, and how

No production code in `packages/db-core/src` or `packages/db-p2p/src` matches on a dial error's
`name` or `code` (verified by grep for `err.name`, `.code ===`, `instanceof …Error` across both
`src` trees). The new error therefore travels the **identical** path to today's
`NoValidAddressesError`: `ProtocolClient.processMessage` logs it and rethrows; the cohort fan-out is
`Promise.allSettled` (`cluster/cluster-repo.ts:1858`, `db-core/transaction/coordinator.ts:869,974`,
`db-core/transactor/network-transactor.ts:196`), so one member's rejection is collected as that
member's failure and the operation proceeds with the rest. Nothing needed updating. This is a
**static** confirmation by reading the call sites — no test exercises a self-relay member inside a
live multi-member consensus round.

## Known gaps — treat the tests as a floor

- **No end-to-end consensus test.** The exclude-and-continue claim above is read off the code, not
  demonstrated. A spec where a cohort contains one self-relay-only member and the write still
  reaches super-majority would close it; the existing relay integration specs do not cover it.
- **`findCoordinator` is unaware of self-dialability.** A relay can still *select* one of its own
  reservation holders as coordinator and only then fail fast. That is within the ticket's intent
  ("let the caller's retry/exclude logic move on") but it costs a selection round-trip, and nobody
  measured how often it happens.
- **Multi-hop classification is a judgement call.** An address whose *second* hop is us is
  classified as self-relay and refused. `@libp2p/circuit-relay-v2` does not support nested circuits
  at all, so nothing is lost today — but the reasoning is "unreachable anyway", not "we proved this
  is the right answer".
- **CIDv1 peer-id spelling.** `@multiformats/multiaddr` 13.0.1 keeps a `/p2p/` value verbatim rather
  than normalizing CIDv1 to base58btc — measured, not assumed. `isRelayComponent` therefore falls
  back to a canonical `peerIdFromString` compare when string equality fails, and the predicate table
  covers both spellings. The fallback parse runs at most once per circuit address; it was not
  profiled.
- **`peerStore.get` failures are swallowed** (inherited from `getPeerStoreAddrsByPeer`) and read as
  `none` → dial as before. Fail-open is deliberate, but it means a persistently broken peerStore
  makes this whole guard silently inert, and no test covers that.
- **The new integration spec is not env-gated** and adds ~1.5 s to the default `yarn test` (three
  real libp2p boots over loopback), matching the sibling `relay-inbound-source-address.spec.ts`.
- **Cold-path cost is one extra `peerStore.get` for every peer**, not only on relays. The ticket
  accepted this; it was not measured against a busy node.

## Adjacent, deliberately untouched

`tickets/backlog/debt-shared-limited-connection-dial-options.md` covers dial *options*
(`runOnLimitedConnection`, dropped `AbortOptions`) at other stream-open sites in the same file. It
was read before restructuring `connect` and is unaffected — the cold path's `dialOptions` and the
warm path's `newStream` options are byte-identical to before.
