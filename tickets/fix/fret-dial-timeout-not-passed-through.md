description: The next FRET release adds `FretConfig.dialTimeoutMs` (default 10 s), the time FRET's maintenance redial gives one dial. `libp2p-node-base.ts` builds FRET without it and has no option for it, so an embedder whose relayed dials take longer than 10 s (Sereus budgets 21.5 s for a relayed dial on its declared link) cannot raise it, and two strand nodes on a slow relayed link can fail to reconnect after a restart. Reported from Sereus.
files: packages/db-p2p/src/libp2p-node-base.ts (the `fret:` service factory ~1088, `NodeOptions` ~242 next to `fretProfile`), packages/db-p2p/package.json and packages/substrate-simulator/package.json (`p2p-fret` floor)
----

## What is wrong

FRET's maintenance ping used to dial with a fixed 2 s budget (Fret `maintenance-ping-dial-budget-below-a-relayed-dial`), so a peer reached only through a relay on a slow link was never redialed: the relayed dial and Noise handshake took about 9 s in Sereus's `joiner-first-commit-over-slow-relay` scenario. FRET main (12b509a, unreleased, `maintenance-redial-off-the-tick`) moves the redial off the stabilization tick and gives each dial `FretConfig.dialTimeoutMs`, default 10 s.

Optimystic constructs FRET in `libp2p-node-base.ts`:

```ts
fret: (components: any) => {
	const svcFactory = fretService({
		k: 15, m: 8, capacity: 2048,
		profile: options.fretProfile ?? …,
		networkName: options.networkName,
		bootstraps: options.bootstrapNodes ?? []
	});
```

No FRET dial timeout is passed, and `NodeOptions` has no field for one. An embedder gets 10 s whatever its link.

## What Sereus needs

- A way to set FRET's dial timeout from `NodeOptions`. Sereus already gives Optimystic a link budget (`addressDialTimeout`, `dialTimeout`, `inboundUpgradeTimeout`, all sized from its declared link round trip), so either:
  - a `fretDialTimeoutMs?: number` beside `fretProfile`, or
  - derive FRET's `dialTimeoutMs` from the libp2p `connectionManager.dialTimeout` the node is already given, when one is set.
  The second needs no new API and keeps FRET's redial consistent with every other dial the node makes; Sereus would accept either.
- The `p2p-fret` floor raised to the FRET release that has `dialTimeoutMs` once it is on npm.

## How to check

- A unit test that a node built with the option (or with a `dialTimeout`) passes it to `fretService`.
- Sereus will rerun `joiner-first-commit-over-slow-relay.integration.ts`'s restart arms (fourth and fifth), which depend on this redial, once the release is out.
