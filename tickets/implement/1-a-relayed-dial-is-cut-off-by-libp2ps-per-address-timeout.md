description: Newer libp2p versions give up on each address of a peer after a fixed 6 seconds, which cuts off a slow relayed connection that our own deadlines allowed far longer. The deadline itself is now derived from the declared link round trip; what remains is moving our tests and lockfile onto the libp2p version users actually install, correcting the version notes, and pinning the libp2p behaviour with a test.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/package.json, packages/quereus-plugin-optimystic/package.json, packages/substrate-simulator/package.json (`libp2p` range, now `^3.1.3`)
  - yarn.lock (resolves `libp2p@npm:^3.1.3` to 3.1.3)
  - packages/db-p2p/src/connection-monitor.ts (`Libp2pConnectionTimeouts`)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionManager` doc, the "Built apart from `libp2pOptions`" comment above `connectionManager`, the `NodeOptions.connectionMonitor` NOTE about libp2p 3.1.3 vs 3.3)
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `DEFAULT_ADDRESS_DIAL_TIMEOUT_MS`, `CONNECTION_ROUND_TRIPS` comment)
  - packages/db-p2p/readme.md (deadline table row for `addressDialTimeout`; the connection-monitor paragraphs that say "on this libp2p line")
  - packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts (delay-proxy fixture to copy)
  - packages/db-p2p/test/link-deadlines.spec.ts (already pins the derived value)
  - scripts/shared-majors.cjs (comment on the deliberate `@libp2p/interface` 3.1 / 3.2 split)
difficulty: hard
repro: static
source: sereus-ec, from kjeib on gotchoices/sereus#13 (sereus 1.8.0 / optimystic 1.8.x)
----
# A relayed dial is cut off by libp2p's per-address timeout

## Report

kjeib, gotchoices/sereus#13: a relayed formation at 1500 ms delay per frame in each direction (a 3 s round trip, the supported maximum, declared through `linkRoundTripMs`) fails with a `TimeoutError` 6.0 s into the dial. Raising libp2p's `ADDRESS_DIAL_TIMEOUT` to 30 s, and changing nothing else, made the same run pass end to end.

## What the fix stage established

**The libp2p behaviour, checked in the published packages.** libp2p's dial queue (`libp2p/dist/src/connection-manager/dial-queue.js`, `DialQueue.dialPeer`) wraps every address it tries in `anySignal([signal, AbortSignal.timeout(this.addressDialTimeout)])`, default `ADDRESS_DIAL_TIMEOUT = 6_000`. The outer `signal` is the dial's own: libp2p's `dialTimeout`, or the caller's signal when the caller passed one. So the per-address limit applies inside our RPC clients' dials too. The timer wraps `transportManager.dial`, which covers the transport connection plus its upgrade (encryption and muxer). It does not cover the protocol-stream negotiation that follows.

**Which versions have it.** Absent in 3.2.0. Present in 3.2.1, 3.2.2, 3.2.3, 3.2.4, 3.3.0 and 3.3.11 (the newest 3.x, which a fresh install resolves). Absent in 3.1.x. This repository declares `libp2p: ^3.1.3` and its lockfile resolves 3.1.3, so none of our tests have ever run with the limit in force. Sereus's lockfile is also on 3.1.3. kjeib hit the limit because a fresh embedder install resolves 3.3.11.

**Most of the code fix has already landed.** It went in with commit 88be3ae6, an unrelated review commit for `reactivity-forwarding-state-only-on-demand`:

- `LinkDeadlines.addressDialTimeoutMs` = `max(DEFAULT_ADDRESS_DIAL_TIMEOUT_MS (6000), 5 × linkRoundTripMs)` in `resolveLinkDeadlines`, pinned in `test/link-deadlines.spec.ts` (15 s at a 3 s round trip).
- `Libp2pConnectionTimeouts` gained an `addressDialTimeout?: number` field, declared by hand because 3.1.x's `ConnectionManagerInit` lacks it.
- `createLibp2pNodeBase` passes `addressDialTimeout: options.connectionManager?.addressDialTimeout ?? linkDeadlines.addressDialTimeoutMs` beside `dialTimeout` and `inboundUpgradeTimeout`, so an explicit setting wins.
- The `NodeOptions.connectionManager` doc and the readme's deadline table list it.

An embedder on libp2p 3.2.1 or later therefore already gets the derived value at runtime. kjeib's case (3 s round trip → 15 s per address, against about 12.1 s measured for a relayed open at that link, per the readme) should pass once sereus takes a release that includes 88be3ae6.

**The derived value: keep five round trips. Do not raise it to the dial deadline.** The fix ticket asked for at least `max(connectionTimeoutMs, dialTimeoutMs)`. That is more than needed. The per-address timer covers the connection open (about 4 round trips relayed) but not the stream negotiation (1 round trip) that `dialTimeoutMs` (6 round trips) also has to cover. Five round trips is the open plus one of margin, the same budget as `connectionTimeoutMs`. Undeclared, it stays at libp2p's own 6 s, below the 10 s `dialTimeout`, exactly as libp2p ships. Declared, it is never larger than `dialTimeout` (`max(6000, 5r) ≤ max(10000, 5r)`). Leave the derivation as it is.

**One case the five round trips do not cover.** A circuit-address dial whose relay connection is not already open dials the relay from inside the per-address timer. That cold path costs the relay's own connection open plus the hop, the stop and the relayed upgrade, which is more than five round trips on a slow link. Today this is not a concern, because a node that holds a reservation keeps its relay connection open. The 6-round-trip RPC dial deadline would not fit the cold path either. Record this as a `NOTE:` tripwire at `CONNECTION_ROUND_TRIPS` in `rpc-deadline.ts`: if relayed dials ever go to a relay this node is not already connected to, size both deadlines for the cold path.

## What remains

**1. Move the three workspaces and the lockfile to `libp2p ^3.3.11`.** This brings our tests onto the libp2p users run, and makes `ConnectionManagerInit` declare `addressDialTimeout` itself. This is the risky part, and the reason for `difficulty: hard`. libp2p 3.3.11 depends on `@libp2p/interface ^3.3.0`, `@libp2p/interface-internal ^3.1.13` and `@libp2p/utils ^7.4.1`. db-p2p declares `@libp2p/interface ^3.1.0`, which the lockfile resolves to 3.1.0, and passes transports, encrypters, muxers and services built against that line into `createLibp2p`. `scripts/shared-majors.cjs` records why db-p2p was deliberately left on the 3.1 line (a Uint8ArrayList v2 vs v3 structural-typing split in db-p2p's build), so expect type errors where libp2p's 3.3-typed init meets our 3.1-typed components. Suggested order:

- `yarn up libp2p@^3.3.11` in the three workspaces (db-p2p, quereus-plugin-optimystic, substrate-simulator), then `yarn build` and `yarn typecheck`.
- If the build splits, move the rest of db-p2p's `@libp2p/*` and `@chainsafe/libp2p-*` dependencies to their current minors as well, which is what a fresh embedder install already resolves. If that brings back the uint8arraylist v2/v3 split, fix it at its cause in db-p2p (its `it-length-prefixed` / `uint8arraylist@^2` usage) rather than casting. Then update the 3.1-vs-3.2 paragraph in `scripts/shared-majors.cjs` to describe what is now true. If the split goes away completely, that paragraph says `multiformats` and `uint8arraylist` become guardable; add them only if `yarn lint:deps` passes with them in.
- `yarn lint:deps` must pass (same major everywhere). Run the db-p2p suite, the quereus-plugin-optimystic suite and `yarn test:integration`. Moving 3.1 → 3.3 is a minor bump but crosses two minors of behaviour change. Watch the relay, identify and connection-monitor specs in particular.
- `yarn check:rn`: Metro and Hermes must still accept the bumped libp2p.

**2. Retire the 3.1.x workarounds and correct the version notes.** After the bump:

- `Libp2pConnectionTimeouts` becomes `Pick<ConnectionManagerInit, 'dialTimeout' | 'inboundUpgradeTimeout' | 'addressDialTimeout'>`, and its "stated here rather than picked" comment goes.
- Drop the "Built apart from `libp2pOptions`…" comment above `connectionManager` in `createLibp2pNodeBase`. The separate `ConnectionManagerInit & Libp2pConnectionTimeouts` object can go back inline if nothing else needs it apart.
- Every "libp2p 3.3.0 and later" / "3.1.x ignores it" for `addressDialTimeout` is wrong on the version: the field first ships in **3.2.1**. Fix it in `NodeOptions.connectionManager`'s doc and in the readme table row. Once the floor is `^3.3.11`, the parenthetical can simply go.
- The `NodeOptions.connectionMonitor` NOTE and the readme's connection-monitor paragraphs describe libp2p 3.1.3 as "this libp2p line" and 3.3 as the future line. The NOTE says to re-check them "on that move". This is that move. Rewrite them for 3.3 as the current line (the 3.3 behaviour is already measured in the NOTE: "4 of 4, measured on libp2p 3.3.11"), and re-run `test/connection-monitor-ping-overlap.spec.ts`.

**3. Reproduce the libp2p behaviour at the lowest layer.** Add one spec in db-p2p modelled on `test/stream-open-costs-a-round-trip.spec.ts`: two plain libp2p nodes through its delay proxy (copy `listenDelayProxy`, or lift it into a shared test helper if that is cleaner), scaled down so the spec runs in a couple of seconds. It must show both halves. (a) A dial that carries a generous caller signal still fails once the connection open exceeds `addressDialTimeout`, set below the open's cost. (b) The same dial succeeds when `addressDialTimeout` covers the open. This is the reproduction of the reported bug, and it also guards this one behaviour against lockfile drift: on libp2p 3.1.3 half (a) fails because the option is ignored, so a lockfile that slides back is caught. Put that sentence in the spec header the way `relay-third-party-address-gap.spec.ts` states its premise. Measure the scaled-down open cost on the proxy before choosing the two timeout values. It should be about three round trips (multistream for the encrypter, the noise handshake, multistream for the muxer), but choose from the measurement, not from this estimate.

No test that `createLibp2pNodeBase` passes the derived value into the libp2p init. That is a `??` pass-through with no branching, and the derivation itself is already pinned in `link-deadlines.spec.ts`. A full relayed end-to-end run at a 3 s round trip is not required either. No delayed-relay fixture exists in this repository (the 7.3 s / 12.1 s figures in the readme were measured outside the suite), and building one would be a `RUN_LONG_TESTS`-gated spec costing well over a minute per run.

## For the reviewer

The deeper gap is that the lockfile kept every test on libp2p 3.1.3 while every new embedder got 3.3.x, and a behaviour change between them went unseen. Step 1 closes this instance. Decide whether a lockfile-drift check belongs in the release steps (`docs/releasing.md`), for example comparing the locked versions of the libp2p-family packages against what a fresh install of the published packages resolves. If it does, file it as a `debt-` backlog ticket rather than adding it here.

## After release

Tell sereus-ec the version that includes 88be3ae6 (and this ticket). Sereus raises its optimystic floor and closes #13 once kjeib confirms.

## TODO

- Bump `libp2p` to `^3.3.11` in db-p2p, quereus-plugin-optimystic and substrate-simulator; `yarn install`; fix the build at its cause if the 3.1/3.3 `@libp2p/interface` split surfaces (move the rest of db-p2p's libp2p family forward as needed); update `scripts/shared-majors.cjs`'s split paragraph to match what is now true
- `yarn lint:deps`, `yarn build`, `yarn typecheck` clean
- Simplify `Libp2pConnectionTimeouts` to a `Pick` including `addressDialTimeout`; drop the 3.1.x workaround comment and, if possible, the separate `connectionManager` object in `createLibp2pNodeBase`
- Correct the version wording ("3.3.0 and later" → first shipped in 3.2.1, or drop it once the floor is 3.3.11) in the `NodeOptions.connectionManager` doc and the readme table
- Rewrite the connection-monitor NOTE and readme paragraphs for libp2p 3.3 as the current line; re-run `test/connection-monitor-ping-overlap.spec.ts`
- Add a `NOTE:` tripwire at `CONNECTION_ROUND_TRIPS` in `rpc-deadline.ts` about the cold-relay dial path
- Add the delay-proxy spec showing the per-address limit cutting off a signalled dial and a raised limit letting it through
- Run the db-p2p and quereus-plugin-optimystic suites, `yarn test:integration`, `yarn check:rn`, `yarn lint:docs`
