description: The same diagnostic message about learning a peer's address is written to two unrelated log channels depending on which code path produced it, so switching the expected channel on shows half the picture and looks like proof that the mechanism never ran. It already cost an outside reporter a wrong conclusion, and it is the channel we ask people to turn on when diagnosing this area.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/logger.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/test/logger.spec.ts
difficulty: easy
repro: verified
----

# `peer-address-book:merge` logs under two unrelated debug namespaces

Raised in the [Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12) thread by both
sides: the reporter measured "`peer-address-book:merge` fired 0 times in 46,798 lines" and drew a
conclusion from it; the maintainer's reply identified the namespace split as the reason that
measurement could not mean what it appeared to. The reporter then re-ran with **both** namespaces
armed. Small ticket, but it is the observability the two companion tickets
(`findcluster-publishes-inbound-source-addresses`,
`relay-cannot-dial-its-own-reservation-holders`) rely on for field verification.

## What happens

Both address-book ingress paths call `mergePeerAddresses`, which emits the same
`peer-address-book:merge peer=… addrs=…` line — but the log sink each path hands it comes from a
different logger:

- **Inbound** (`ClusterService`, from the coordinator): the sink is built at
  `libp2p-node-base.ts:559` as
  `components.logger.forComponent('db-p2p:peer-address-book')`. libp2p's `defaultLogger()` adds no
  prefix, so the resulting `debug` namespace is literally `db-p2p:peer-address-book`.
- **Outbound** (`ClusterClient` / `RepoClient` → `Libp2pKeyPeerNetwork.recordPeerAddresses`): the
  sink is the key-network logger, built by `createLogger` (`logger.ts:21`) under
  `optimystic:db-p2p:libp2p-key-network:<peer>`.

`DEBUG=optimystic:db-p2p:*` — the filter this package's docs and issue templates tell people to use —
therefore captures only the outbound half. The inbound half is invisible, and its absence reads as
"the merge never executed".

## The fix

Route the inbound sink through this package's own `createLogger` so both halves live under the
`optimystic:db-p2p:` tree — `optimystic:db-p2p:peer-address-book`, with the peer-id suffix
`createLogger` already supports, since integration tests run several nodes in one process.

The one thing to check before switching: the sink is currently a libp2p `Logger` obtained from
`components.logger`, and `AddressLog` is deliberately shaped to accept both that and a `debug`
logger (`peer-address-book.ts`, the `AddressLog` type). `createLogger` returns a `debug.Debugger`,
which satisfies `AddressLog`, so the swap is type-safe — but confirm nothing else downstream expects
the libp2p `Logger` extras (`.error`, `.trace`, `.enabled`).

While here, make the split hard to reintroduce: the reason it happened is that one site reached for
libp2p's logger factory and the other for ours. Whatever shape the fix takes, a new call site
inside this package should get the `optimystic:db-p2p:` tree without its author choosing between two
factories.

## Edge cases & interactions

- **The line text stays the same** (`peer-address-book:merge`, `peer-address-book:capped`,
  `peer-address-book:record-capped`) — people grep for it; only the namespace changes.
- **Peer-id suffix**: `createLogger('peer-address-book', peerId)` produces
  `optimystic:db-p2p:peer-address-book:<12 chars>`; a filter of `optimystic:db-p2p:*` still matches,
  but an exact-namespace filter someone wrote by hand would not. Note the change in the release
  notes.
- **`components.peerId` availability** at service-construction time — it is already used a few lines
  below the sink at `libp2p-node-base.ts:565`, so the suffix is available without new plumbing.
- **Other `forComponent('db-p2p:…')` sites** exist (`block-transfer-service.ts:101`,
  `spread-on-churn`, `arachnode`, `owned-block-seed`, `cluster`). They are outside this ticket's
  claim, but if the fix is a shared helper rather than a one-line swap, say in the handoff which of
  them were converted and which were left, rather than converting some silently.
- **`test/logger.spec.ts`** pins namespace construction; extend it rather than working around it.

## Tests

- Unit: the inbound sink's namespace starts with `optimystic:db-p2p:` — assert on the namespace the
  wiring produces, not on a string constant duplicated in the test.
- Unit: both ingress paths emit `peer-address-book:merge` under namespaces matched by a single
  `optimystic:db-p2p:*` filter. A table with one row per ingress path is the shape that generalizes
  when a third ingress point is added.

## TODO

- Replace the `components.logger.forComponent('db-p2p:peer-address-book')` sink at
  `libp2p-node-base.ts:559` with this package's `createLogger`, passing the node's peer id.
- Confirm no downstream consumer of that sink needs the libp2p `Logger` extras.
- Extend `test/logger.spec.ts` (or add a focused spec) with the two assertions above.
- Grep the docs for `DEBUG=` examples that name `db-p2p:peer-address-book` and update them.
- Note the namespace change in the release notes / changelog entry for the next version.
- Run `yarn workspace @optimystic/db-p2p test`, plus repo lint and typecheck.
