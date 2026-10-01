description: Newer libp2p versions give up on each address of a peer after a fixed 6 seconds, which cut off a slow relayed connection that our own deadlines allowed far longer. The deadline is now derived from the declared link round trip, and the repository's tests and lockfile run on the libp2p version users actually install, with a test that pins the libp2p behaviour.
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
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `NOTE:` at `CONNECTION_ROUND_TRIPS`)
  - packages/db-p2p/src/network/relay-reservation.ts, packages/db-p2p/src/peer-address-book.ts (version-pinned comments)
  - packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts
  - packages/db-p2p/test/util/delay-proxy.ts
  - packages/db-p2p/readme.md, packages/rn-bundle-check/readme.md, README.md, AGENTS.md, scripts/shared-majors.cjs
  - packages/rn-bundle-check/metro.config.cjs, test-harness/build-freshness.test.mjs, scripts/check-libp2p-majors.mjs (review: comments that still described `p2p-fret` as portal-linked)
source: sereus-ec, from kjeib on gotchoices/sereus#13 (sereus 1.8.0 / optimystic 1.8.x)
----
# A relayed dial is cut off by libp2p's per-address timeout

## The report

kjeib (gotchoices/sereus#13): a relayed formation on a link with a 3 s round trip failed 6.0 s into the dial. libp2p 3.2.1 and later give each address of a peer `connectionManager.addressDialTimeout` (default 6 s) to connect, and apply it inside a dial that carries its own, longer, signal.

## What landed

- **The deadline is derived.** `resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts` gives `addressDialTimeoutMs = max(6000, 5 × linkRoundTripMs)` and `createLibp2pNodeBase` passes it to libp2p; `connectionManager.addressDialTimeout` overrides it. (Landed in commit 88be3ae6, ahead of this ticket.)
- **The repository builds and tests on libp2p 3.3.11**, with `@libp2p/interface` 3.3.0 as the only copy. Every `@libp2p/*` range in every workspace moved to its current release. The lockfile had held 3.1.3, where the limit does not exist, while a fresh install of the published packages resolved 3.3.11; that is how the report was missed.
- **db-p2p is on `it-length-prefixed` 11 and `uint8arraylist` 3**, the majors a libp2p 3.3 stream is typed with, so no protocol site casts.
- **A spec reproduces the libp2p behaviour**: `packages/db-p2p/test/address-dial-timeout-cuts-off-a-signalled-dial.spec.ts`, two plain libp2p nodes through a delaying TCP proxy. A limit below the cost of the open fails the dial while the caller's 20 s signal is still live; a limit covering the open lets the same dial through. The first case fails on a libp2p that ignores the option, so a lockfile that slides back is caught.
- **The 3.1.x workarounds are gone**: `Libp2pConnectionTimeouts` is a plain `Pick`, the connection-manager init is inline, and the `services` cast in `createLibp2pNodeBase` is removed.
- **Version notes describe the installed line**: the connection-monitor paragraphs (the monitor now reports ping durations back to its adaptive timeout), and the relay comments re-read against `@libp2p/circuit-relay-v2` 4.2.13 (renewal is in place; a configured listener re-applies a reservation for its own relay).

## Decisions taken with the change

- **`p2p-fret` installs from npm; the portal to the sibling checkout is removed.** Yarn refuses a portal whose dependencies conflict with its parent's, and FRET 1.0.0 declares `uint8arraylist` 2 and `it-length-prefixed` 10. `yarn dev:link` fails for FRET until FRET moves; the root README says so. Blocked ticket `fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line` carries the proposed FRET change. If a human would rather hold the libp2p move until FRET has moved, this is the decision to reverse.
- **One type assertion**, in `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`, bridging FRET's declared `uint8arraylist` 2 source type. Every framed read in db-p2p goes through it. A `NOTE:` there names its removal condition.
- **The root `protons-runtime` resolution and db-p2p's unused `protons-runtime` dependency are removed.** The pin was for gossipsub, which is gone.
- **`multiformats` is ^14 in db-core, db-p2p and quereus-plugin-crypto.** All uses are internal (`sha256`, base codecs, the `CID` type); `p2p-fret` is the only remaining user of 13.
- **Peer ranges rose with the dev ranges** in the three storage packages, as `yarn.config.cjs` requires.

## Review findings

Read the `ticket(implement): a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` diff before the handoff, then checked the handoff's claims against the installed sources.

**Checked against installed code, and found to hold:**

- libp2p 3.3.11 `dial-queue.js` wraps every address in `anySignal([signal, AbortSignal.timeout(addressDialTimeout)])`, signalled dials included.
- `connection-monitor.js` calls `AdaptiveTimeout.cleanUp` after every ping; the deadline is 1.2 × a moving average, clamped to `minTimeout`..`maxTimeout`.
- `@libp2p/circuit-relay-v2` 4.2.13: the listener and reservation-store mechanics described in `relay-reservation.ts`, and the two file-and-line citations in `peer-address-book.ts` and its spec, match the installed files.
- The `readFrame` assertion's run-time basis: both installed `uint8arraylist` majors use `Symbol.for('@achingbrain/uint8arraylist')`, and FRET's `readFramed` reads a real stream through `@libp2p/utils`' `byteStream` (one copy, 7.4.1).
- The tripwire at `CONNECTION_ROUND_TRIPS`: the circuit transport opens a missing relay connection under the caller's per-address signal, so the cold path does pay for both opens inside one limit. Left as a `NOTE:`. It needs a slow declared link and a dialer not connected to the peer's relay. I know of no deployment with more than one relay (the accepted-tradeoff `NOTE:` above `planRelayListenAddrs` in `libp2p-node-base.ts` says the same), but I did not check Sereus's topology; if one exists, this is a reachable defect and should become a ticket.
- Installed tree: one version each of `libp2p`, `@libp2p/interface`, `@libp2p/identify`, `@libp2p/circuit-relay-v2`, `@libp2p/utils`.

**Minor, fixed in this pass:**

- Three comments still described `p2p-fret` as portal-linked by the root manifest: `outOfRepoLinkTargets` and `siblingWorkspaceRoot` in `packages/rn-bundle-check/metro.config.cjs`, a test comment in `test-harness/build-freshness.test.mjs`, and the "likely causes" message in `scripts/check-libp2p-majors.mjs`. Reworded to "when linked".
- The new description of the monitor's adaptive deadline (the `NodeOptions.connectionMonitor` doc and `packages/db-p2p/readme.md`) said the deadline follows the moving average of ping durations. A ping that ran out its deadline is entered at twice its duration (`failureMultiplier`); both places now say so. With `minTimeout` equal to `maxTimeout`, as the docs recommend, it changes nothing.
- Backlog ticket `debt-noise-and-yamux-are-on-their-last-chainsafe-releases` called the unused `@libp2p/noise` ^1.0.1 entry in quereus-plugin-optimystic a dev dependency. It is under `dependencies`, so every application installing the plugin installs it. Ticket corrected; the entry itself is left for that ticket.

**Major, filed:**

- `tickets/backlog/debt-tests-run-on-locked-versions-a-fresh-install-does-not-get.md`. The handoff asked whether a lockfile-drift check belongs in the release steps. It does: the cause of this report was that tests ran on the locked libp2p while users got a newer one, and nothing compares the two. The difference was already recorded and unread: every fixture under `packages/upgrade-check/fixtures` says `libp2p` 3.3.11 in `writtenBy`, written while the lockfile held 3.1.3.

**Appended to an existing ticket rather than filed:**

- `debt-no-scenario-runs-two-builds-in-one-cohort` gained the libp2p family move as evidence. No suite runs a node on the older libp2p set against one on the newer set; nothing is known to be broken between them.

**Tests reviewed:** the two cases in the new spec are one behaviour and its control (the second proves the first failure is the limit, not a broken link); kept as is. No test was added: nothing I found was a defect in code. `listenDelayProxy` in `test/util/delay-proxy.ts` is a straight lift shared by two specs.

**Empty categories:** no error-handling, resource-cleanup or type-safety findings. The change to our own code is the removal of two casts, one new typed seam (`readFrame`) and comment corrections; the behaviour change is entirely in the dependency versions, which the suites below exercise.

**Run on the final tree:** `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, `yarn build`, `yarn typecheck`: clean. `yarn test:harness`: 67 pass. db-p2p: 3164 passing, 64 pending. db-core: 1845 passing. quereus-plugin-optimystic: 1001 passing, 14 pending. Every other workspace: passing. `yarn check:rn`: passed. `yarn workspace @optimystic/db-p2p test:integration`: 45 passing, 2 pending. `yarn workspace @optimystic/quereus-plugin-optimystic test:integration`: 1007 passing, 8 pending.

**Not run in review:** the `RUN_LONG_TESTS=1` specs (the implementer reports 16 passing, 5 pending), the `RUN_LONG_TESTS_CONTROL` negative controls, the DCUtR hole-punch case, and anything on a device.

## Known gaps

- **Mixed-version networks are untested** (see the appended ticket above).
- **Embedders' lockfiles move with this release.** Every libp2p-family floor in db-p2p rose, so an application taking this release has its whole libp2p family pulled to the 3.3 line, including `@libp2p/circuit-relay-v2` 4.2.
- **`AbortSignal.timeout` on Hermes: no new requirement.** libp2p 3.3.11's dial queue calls it on every dial; libp2p 3.1.3 already called it on every inbound stream negotiation, connection close and inbound upgrade, so a React Native host already had to provide it. `yarn check:rn` does not run the bundle, so nothing here exercises it.
- **The relay supervisor still rewrites the configured listen address**: backlog `debt-relay-supervisor-can-keep-the-configured-listen-address`.
- **The root README says both sibling dependencies install from npm by default, but the root manifest has carried a `portal:` resolution for `@quereus/quereus` since before this ticket.** Not introduced or changed here; noted because the README paragraph this ticket added sits beside it.

## After release

Tell sereus-ec the version that includes 88be3ae6 and this change. Sereus raises its optimystic floor and closes #13 once kjeib confirms.
