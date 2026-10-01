description: Newer libp2p versions give up on each address of a peer after a fixed 6 seconds, which cut off a slow relayed connection that our own deadlines allowed far longer. The deadline was already derived from the declared link round trip; this change moves the repository's tests and lockfile onto the libp2p version users actually install, pins the libp2p behaviour with a test, and corrects the notes that named the old version.
architecture: packages/db-p2p/readme.md
files:
  - package.json (root `resolutions`: the `p2p-fret` portal and the `protons-runtime` pin are gone)
  - yarn.lock (libp2p 3.3.11, one copy of each `@libp2p/*` package, `p2p-fret` from npm)
  - yarn.config.cjs (`SINGLE_RANGE` for `@libp2p/peer-id`)
  - packages/*/package.json (ten manifests: libp2p-family ranges, peer ranges in the three storage packages, `multiformats`)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (`readFrame`, `FrameSource`)
  - packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/push-state-gossip.ts (read through `readFrame`)
  - packages/db-p2p/src/connection-monitor.ts (`Libp2pConnectionTimeouts`)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.connectionMonitor` and `connectionManager` docs, inline `connectionManager`, `services` without its cast, the relay `NOTE:`s)
  - packages/db-p2p/src/rpc-deadline.ts (`NOTE:` at `CONNECTION_ROUND_TRIPS`)
  - packages/db-p2p/src/network/relay-reservation.ts, packages/db-p2p/src/peer-address-book.ts (version-pinned comments)
  - packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts (new)
  - packages/db-p2p/test/util/delay-proxy.ts (new, lifted from `stream-open-costs-a-round-trip.spec.ts`)
  - packages/db-p2p/readme.md, packages/rn-bundle-check/readme.md, README.md, AGENTS.md, scripts/shared-majors.cjs
  - tickets/blocked/fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line.md, tickets/backlog/debt-noise-and-yamux-are-on-their-last-chainsafe-releases.md, tickets/backlog/debt-relay-supervisor-can-keep-the-configured-listen-address.md (filed here)
difficulty: hard
source: sereus-ec, from kjeib on gotchoices/sereus#13 (sereus 1.8.0 / optimystic 1.8.x)
----
# A relayed dial is cut off by libp2p's per-address timeout — review handoff

## The report, and what was already fixed

kjeib (gotchoices/sereus#13): a relayed formation on a link with a 3 s round trip failed 6.0 s into the dial. libp2p 3.2.1 and later give each address of a peer `connectionManager.addressDialTimeout` (default 6 s) to connect, and apply it inside a dial that carries its own longer signal. The runtime fix landed earlier in commit 88be3ae6: `resolveLinkDeadlines` derives `addressDialTimeoutMs = max(6000, 5 × linkRoundTripMs)` and `createLibp2pNodeBase` passes it to libp2p. This ticket did the rest.

## What this change does

**The repository now builds and tests on libp2p 3.3.11**, with `@libp2p/interface` 3.3.0 as the only copy. Every `@libp2p/*` range in every workspace moved to its current release, since libp2p 3.3-typed init does not accept components typed against 3.1. `yarn lint:deps` passes; the lockfile dedupe was limited to `@libp2p/*`, `@multiformats/*`, `multiformats` and `progress-events`.

**db-p2p moved to `it-length-prefixed` 11 and `uint8arraylist` 3**, the majors a libp2p 3.3 stream is typed with. This is the fix "at its cause" the ticket asked for: no protocol site casts.

**A test reproduces the libp2p behaviour** (see Tests).

**The 3.1.x workarounds are gone**: `Libp2pConnectionTimeouts` is a plain `Pick`, the connection-manager init is inline again, and the `services` cast in `createLibp2pNodeBase` (with its accepted-tradeoff `NOTE:`, whose revisit condition this move tripped) is removed. It type-checks without it.

**Version notes corrected.** The "libp2p 3.3.0 and later" parentheticals for `addressDialTimeout` are dropped (the floor is now 3.3.11). The `NodeOptions.connectionMonitor` doc and the readme's monitor paragraphs describe 3.3 as the current line: the monitor reports each ping's duration back, so the deadline is 1.2 × the moving average held between `minTimeout` and `maxTimeout`, and setting the two equal pins it. I read this from the installed `connection-monitor.js` and `adaptive-timeout.js`; the "4 of 4" measurement in the `NOTE:` is carried over, not re-measured. Comments pinned to `@libp2p/circuit-relay-v2` 4.1.3 were re-read against 4.2.13 and rewritten where the mechanics changed (renewal is now in place; a configured listener re-applies a reservation for its own relay).

**Tripwire recorded** at `CONNECTION_ROUND_TRIPS` in `packages/db-p2p/src/rpc-deadline.ts`: a circuit dial through a relay this node is not connected to costs more than five round trips, and more than the six of the RPC dial deadline.

## Deviations from the ticket — please weigh these

1. **`p2p-fret` is no longer portal-linked to the sibling checkout.** This was forced, not chosen. With db-p2p on `uint8arraylist` 3, Yarn refuses to link a portal whose dependencies conflict with its parent's (`YN0071`, the install fails), and FRET 1.0.0 declares `uint8arraylist` 2 and `it-length-prefixed` 10. Behind that, TypeScript resolved FRET's types against the checkout's own `@libp2p/interface` 3.1.0 (25 errors). The package now installs from npm, which is 1.0.0 from the same commit the checkout is on, and which the root README already calls the default. The Quereus portal is untouched. Consequence: `yarn dev:link` fails for FRET until FRET moves; the README says so. Filed as `tickets/blocked/fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line.md` with the proposed FRET change. If a human would rather hold the libp2p move until FRET has moved, this is the decision to reverse.
2. **One type assertion, in one place.** FRET 1.0.0 declares `readFramed`'s source over `uint8arraylist` 2 lists; a libp2p 3.3 stream yields `uint8arraylist` 3 lists. All five production reads and the two test reads now go through `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`, which holds the assertion and a `NOTE:` with its removal condition. The run-time basis: both majors mark a list with `Symbol.for('@achingbrain/uint8arraylist')` (checked in both installed copies), and FRET reads a real stream through `@libp2p/utils`' `byteStream`. The ticket said "rather than casting" about db-p2p's own usage; this one is FRET's published types and I could not remove it without a FRET release, re-implementing the reader, or changing which read path production takes.
3. **The root `protons-runtime: ^6.0.0` resolution and db-p2p's unused `protons-runtime` dependency are removed.** The pin was added for gossipsub, which is gone. Left in, it would have forced runtime 6 under `@libp2p/crypto`, `@libp2p/utils` and others that now declare ^7, which is not what an embedder installs. Nothing in this repository imports the package.
4. **`multiformats` moved to ^14 in db-core, db-p2p and quereus-plugin-crypto.** I meant to move db-p2p only (its ^13 held the hoist slot and left 14 nested copies of 14.0.0 beneath it, visible in `yarn check:rn`'s output); `yarn up` applies to every workspace that declares the package. I kept it because all three build, type-check and pass, and the only remaining user of 13 is `p2p-fret`. We use `sha256`, the base codecs and the `CID` type. Revert db-core and quereus-plugin-crypto to ^13.4.2 if this is more than the ticket should carry.
5. **Peer ranges rose with the dev ranges** in the three storage packages (`@libp2p/crypto` ^5.1.23, `@libp2p/interface` ^3.3.0), as `yarn.config.cjs` requires, and the single blessed `@libp2p/peer-id` range is now ^6.0.15.
6. **The measured cost of a direct connection open is about two round trips, not the three the ticket estimated**: 2.1 to 2.5 at round trips of 400 down to 100 ms through the delay proxy on libp2p 3.3.11. The spec's two limits are chosen from that (one round trip, and ten).

## Tests

Added, in `packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts` (two plain libp2p nodes through a delaying TCP proxy, about one second):

- *a limit below the cost of the open fails the dial while the caller's signal is still live* — the reproduction of the report: the dial rejects although its own 20 s signal has not aborted. On libp2p 3.1.3 this case fails because the option is ignored; I confirmed that by running the same dial against the 3.1.3 install in the FRET checkout (it succeeded in 644 ms with a 300 ms limit).
- *a limit covering the open lets the same dial through* — the same dial succeeds, and takes longer than the limit that cut the first one off, so the first failure is the limit and not a broken link.

The first case asserts no error name: through this proxy the abort surfaced as `EncryptionFailedError`, where kjeib saw `TimeoutError`; which one appears depends on where in the open the limit lands.

`listenDelayProxy` moved to `packages/db-p2p/test/util/delay-proxy.ts` and `stream-open-costs-a-round-trip.spec.ts` uses it from there. `test/reactivity/notify-transport.spec.ts` reads through `readFrame`. No test for the `??` pass-through in `createLibp2pNodeBase`, and no relayed end-to-end run at a 3 s round trip, as the ticket directed.

## What was run, on the final tree

- `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, `yarn build`, `yarn typecheck`: clean.
- `yarn test:harness`: 67 pass.
- db-core: 1845 passing. db-p2p: 3164 passing, 64 pending. quereus-plugin-optimystic: 1001 passing, 14 pending. The other workspaces: all passing.
- `yarn workspace @optimystic/db-p2p test:integration`: 45 passing, 2 pending (includes the relay-refresh, two-phones-over-relay and foreign-peer interop specs). `yarn workspace @optimystic/quereus-plugin-optimystic test:integration`: 1007 passing, 8 pending.
- `yarn check:rn`: passed.
- `RUN_LONG_TESTS=1` over the four env-gated db-p2p specs (circuit-relay long-lived, relay address propagation, substrate real-libp2p, DCUtR smoke): 16 passing, 5 pending.

Not run: `yarn check` as one command (its parts were run separately, as above); the `RUN_LONG_TESTS_CONTROL` negative controls; the DCUtR hole-punch case, which needs a non-private address; anything on a device.

## Known gaps and things to check

- **Mixed-version networks were not tested.** Every spec runs both ends on the new libp2p family. An upgraded node talking to a peer still on libp2p 3.1.3 with `@libp2p/identify` 4.0.10 and `@libp2p/circuit-relay-v2` 4.1.3 (a relay or bootstrap node from another repository, or a phone that has not updated) is the case the bump could break and no suite here covers. Backlog ticket `debt-no-scenario-runs-two-builds-in-one-cohort` is the standing gap.
- **Embedders' lockfiles move with this release.** Every libp2p-family floor in db-p2p rose, so an application taking this release has its whole libp2p family pulled to the 3.3 line, including `@libp2p/circuit-relay-v2` 4.2. That is the intent, but it is a larger step for Sereus than a one-line change suggests.
- **The relay supervisor still rewrites the configured listen address**, though the installed relay library looks able to do without the rewrite. Filed as `tickets/backlog/debt-relay-supervisor-can-keep-the-configured-listen-address.md`; the claim there is read from source, not exercised.
- **Noise and yamux are on their last chainsafe releases**; the libp2p project now publishes them as `@libp2p/noise` and `@libp2p/yamux`. Filed as `tickets/backlog/debt-noise-and-yamux-are-on-their-last-chainsafe-releases.md`. The unused `@libp2p/noise` ^1.0.1 dev dependency in quereus-plugin-optimystic was left alone (`yarn up` tried to take it to 17; I put it back).
- **`AbortSignal.timeout` on Hermes: no new requirement.** Our own code avoids it because Hermes lacks it, and libp2p 3.3.11's dial queue now calls it on every dial, signalled ones included, where 3.1.3's called it only for a dial with no signal. I checked that this adds nothing a phone did not already need: libp2p 3.1.3 calls it unconditionally on every inbound stream negotiation, connection close and inbound upgrade (`connection.js`, `upgrader.js`), so a React Native host already has to provide it. `yarn check:rn` does not run the bundle, so nothing here exercises it.
- `scripts/shared-majors.cjs` still leaves `multiformats` and `uint8arraylist` off the guarded list; its comment now names the three dependencies that keep the older majors in the tree.

## For the reviewer (carried over from the fix stage)

The deeper gap was that the lockfile kept every test on libp2p 3.1.3 while every new embedder got 3.3.x, and a behaviour change between them went unseen. This change closes that instance. Decide whether a lockfile-drift check belongs in the release steps (`docs/releasing.md`), for example comparing the locked versions of the libp2p-family packages against what a fresh install of the published packages resolves. If it does, file it as a `debt-` backlog ticket rather than adding it here.

## After release

Tell sereus-ec the version that includes 88be3ae6 and this change. Sereus raises its optimystic floor and closes #13 once kjeib confirms.
