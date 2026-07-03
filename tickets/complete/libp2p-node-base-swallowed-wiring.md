description: Stopped the peer-to-peer node startup code from silently ignoring failures while wiring up its critical internal services, so a broken wiring now fails loudly at startup instead of degrading quietly.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts
----

Origin chain: review finding eh-4 (docs/review.html §9) → fix → implement → review (this ticket).

## What landed

`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts` injects the running libp2p node
into its custom services (`setLibp2p`) and the reputation view (`setReputation`). Every injection had
been wrapped in an empty `catch { }`, so a wiring failure was discarded and the node ran half-wired,
falling back to the unreliable `components.libp2p` proxy and surfacing later as unexplained
routing/consensus failures. The change:

- **Best-effort in-factory injections** (networkManager ~line 524, fret ~line 539): log the failure
  via `createLogger('node-wiring')` and continue (the real node is re-injected post-construction).
- **Load-bearing pre-start injections** (`fret`/`networkManager`/`repo`.setLibp2p, ~lines 557-563):
  fail fast. The node has not started, so a throw rejects node creation — nothing leaks.
- **Load-bearing post-start injection** (`networkManager.setReputation`, ~line 586): fail fast but
  `await node.stop()` before rethrow, so a started node + open transports do not leak (mirrors the
  cohort-topic hard-fail blocks).
- **Type discipline**: `SetLibp2pCapable` / `SetReputationCapable` interfaces and a `WiredServices`
  record; injections now go through `node.services as unknown as WiredServices` instead of
  `(node as any).services?.x?.setLibp2p?.()`, removing the silent optional-chain skips.
- **`as any` removed** from `createLibp2p(...)`; `libp2pOptions` typed `Libp2pInit`. This exposed four
  dead `connectionManager` keys (`autoDial`, `minConnections`, `dialQueue`,
  `inboundConnectionUpgradeTimeout`) that the old cast silently ignored; dropped/renamed
  behavior-preservingly. A residual `services`-field cast remains, forced by a duplicate
  `@libp2p/interface` install pulled via `@libp2p/crypto`.

## Review findings

Read the implement diff (`git show e4108d2`) with fresh eyes before the handoff.

**Checked — verified correct:**
- **Dropped `connectionManager` keys were genuinely dead.** Inspected the installed
  `libp2p/dist/src/connection-manager/index.d.ts`: `ConnectionManagerInit` has `maxConnections`,
  `maxDialQueueLength`, `inboundUpgradeTimeout` — and NO `autoDial`, `minConnections`, `dialQueue`, or
  `inboundConnectionUpgradeTimeout`. So the removed keys were runtime no-ops under the old `as any`,
  and `inboundConnectionUpgradeTimeout: 10_000` → `inboundUpgradeTimeout: 10_000` is exact (10_000 is
  also the default). The handoff's claim is accurate; the drop is behavior-preserving. No live
  `minConnections` floor could have existed — the key never reached libp2p.
- **Injection signatures match.** `networkManager.setLibp2p(Libp2p)` / `setReputation(IPeerReputation)`
  (network-manager-service.ts:61,65) and `repo.setLibp2p(Libp2p)` (repo/service.ts:102) line up with
  the hand-written interfaces; `reputation` is a `PeerReputationService` (implements `IPeerReputation`).
- **Logger namespace** resolves to `optimystic:db-p2p:node-wiring` (logger.ts BASE_NAMESPACE + subns),
  as claimed; mirrors the log-not-swallow precedent at network/get-network-manager.ts:13.
- **setReputation stop-on-throw** mirrors the real cohort-topic hard-fail blocks (lines 1042, 1071),
  both of which `await node.stop()` before throwing. Correct.
- **No empty `catch { }` wiring swallows remain** in the file.

**Found and fixed inline (minor):**
- **Overstated compile-time guarantee.** The `WiredServices` doc comment (and the handoff) claimed a
  renamed/removed service or a changed `setLibp2p`/`setReputation` shape "fails the build." It does
  not: `node.services as unknown as WiredServices` and the config-side `services: (...) as unknown as`
  cast both sever the compile link, so a service RENAME is caught at *runtime* (fail-fast throw, still
  a real improvement over the old silent skip), not by tsc, and a real signature change is caught only
  at the service's own definition. What the typed record genuinely buys: caller-side typos / wrong
  arity fail tsc, and a missing service throws instead of being quietly no-op'd. Rewrote the comment at
  the `WiredServices` declaration to state this accurately. (Behavior unchanged; comment-only.)

**Found — filed as new ticket (major, pre-existing):**
- **Startup error path leaks a started node.** Between `await node.start()` (~line 565) and the
  successful return, a long stretch of async setup runs; only three spots stop the node on failure
  (the setReputation injection + the two cohort blocks). Any other throw in that stretch — most
  reachably `keyNetwork.initFromPersistedState()` on corrupt persisted state — propagates out while the
  started node keeps its transports open, with no handle for the caller to stop it. Pre-existing (this
  change actually *added* one of the three guards); broader than the wiring focus. Filed
  `tickets/backlog/debt-libp2p-node-base-startup-error-leak.md`.

**Tripwire (recorded in code, not a ticket):**
- The `services`-field `as unknown as NonNullable<Libp2pInit['services']>` cast exists only because
  `@libp2p/crypto` pulls a duplicate `@libp2p/interface` whose PeerId/key `Uint8Array` shapes are
  structurally incompatible with the top-level copy. A `NOTE:` comment at the cast site says to drop it
  if the dep tree dedups or on a libp2p bump. Conditional (fine now; only work if the deps change) —
  parked as a comment, indexed here. Confirmed the residual, not a full type landing.

**Test coverage (checked — no new runtime tests added; accepted):**
- Happy path is exercised by any node-construction spec (1103 passing). The fail-fast paths
  (renamed/removed service; throwing `setReputation`) have no runtime assertion — the harness has no
  fixture to force a service/injection to throw, and the guard is type-driven. A spec that stubs a
  throwing `setLibp2p`/`setReputation` and asserts `createLibp2pNodeBase` rejects (and, for the
  post-start case, that `node.stop()` ran) would close the gap; not filed as a ticket since the guard
  is compile/runtime-structural and the value is defense-in-depth. Flagged here rather than papered
  over.
- The two in-factory injections remain log-not-delete by design (redundant with post-construction
  re-injection; kept as the lower-risk change). Acceptable.

## Verification performed (this review pass)

- `packages/db-p2p` `npx tsc --noEmit` → clean (exit 0), before and after the comment edit.
- `packages/db-p2p` `yarn test` → 1103 passing, 36 pending (exit 0), ~53s.
- No lint script in this package; `build` is `tsc`, covered by the typecheck above.
