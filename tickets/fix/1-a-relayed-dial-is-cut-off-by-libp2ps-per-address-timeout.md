description: libp2p (from 3.2.x) aborts each address of a dial after its own fixed `addressDialTimeout` (6 s), inside whatever overall deadline the dial has. A relayed dial at the supported 3 s round trip needs about seven sequential frames, so it fails at 6 s although `linkRoundTripMs` gave it a 19.5 s budget. `NodeOptions.linkRoundTripMs` should size that timeout too, and `NodeOptions.connectionManager` should let a caller set it.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (`connectionManager` in the libp2p init; `NodeOptions.connectionManager` and `NodeOptions.linkRoundTripMs` docs)
  - packages/db-p2p/src/connection-monitor.ts (`Libp2pConnectionTimeouts`)
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `LinkDeadlines`)
  - packages/db-p2p/package.json, packages/quereus-plugin-optimystic/package.json, packages/substrate-simulator/package.json (`libp2p` range), yarn.lock
  - packages/db-p2p/readme.md and docs that describe what `linkRoundTripMs` derives
source: sereus-ec, from kjeib on gotchoices/sereus#13 (sereus 1.8.0 / optimystic 1.8.x)
----
# A relayed dial is cut off by libp2p's per-address timeout

## Report

kjeib, gotchoices/sereus#13: a relayed formation at 1500 ms per-frame delay (the supported 3 s round
trip, declared through `linkRoundTripMs`) fails with a `TimeoutError` 6.0 s into the dial. With libp2p's
`ADDRESS_DIAL_TIMEOUT` raised to 30 s and nothing else changed, the same run passed end to end.

## Cause (checked against the published libp2p source)

- libp2p's dial queue wraps every address it tries in
  `anySignal([signal, AbortSignal.timeout(this.addressDialTimeout)])`
  (`libp2p/dist/src/connection-manager/dial-queue.js`, 3.3.11), default `ADDRESS_DIAL_TIMEOUT = 6_000`.
  The overall `dialTimeout` — or the caller's own signal — is the outer bound; the 6 s per address
  cuts it short regardless.
- That applies to our RPC clients' dials too, which carry their own signal: the per-address timer is
  combined with it, not replaced by it. So `LinkDeadlines.dialTimeoutMs` is capped at 6 s per address
  today as well, not only libp2p's `dialTimeout`.
- The option and constant first appear in libp2p 3.2.x (absent in 3.2.0, present in 3.2.4; 3.1.x has
  neither). This repository declares `libp2p: ^3.1.3` and its lockfile resolves 3.1.3, so neither our
  tests nor our types see it; sereus's install resolves 3.3.11 and does.
- Sereus cannot set it: `Libp2pConnectionTimeouts` is
  `Pick<ConnectionManagerInit, 'dialTimeout' | 'inboundUpgradeTimeout'>`.

## Proposed fix

- Raise the `libp2p` range in the three workspaces to a version that has `addressDialTimeout`
  (^3.3.11 is what sereus runs) and update the lockfile; run `yarn lint:deps` (same major).
- Add `addressDialTimeout` to `Libp2pConnectionTimeouts`, and pass
  `addressDialTimeout: options.connectionManager?.addressDialTimeout ?? <derived>` beside
  `dialTimeout` and `inboundUpgradeTimeout`.
- The derived value: a single address must be allowed the whole connection budget, since a relayed
  peer usually has exactly one address to try. Decide whether that is
  `linkDeadlines.connectionTimeoutMs` or a new `LinkDeadlines` field, but it must be at least
  `max(connectionTimeoutMs, dialTimeoutMs)` so neither our RPC dials nor libp2p's own are cut short,
  and floored at libp2p's 6 s default so an undeclared round trip changes nothing.
- Update the `NodeOptions.connectionManager` and `linkRoundTripMs` docs (and the readme) to list it.
- Test: a unit test that the libp2p init carries the derived value for a declared round trip and the
  6 s floor for none, and that an explicit `connectionManager.addressDialTimeout` wins. If a delayed
  relay fixture exists (the 1500 ms measurements in
  `complete/2.5-declared-link-round-trip-derives-every-dial-deadline`), extend it to show a relayed
  dial at a 3 s round trip now completes.

## After release

Tell sereus-ec the version; sereus raises its floor and closes #13 once kjeib confirms.
