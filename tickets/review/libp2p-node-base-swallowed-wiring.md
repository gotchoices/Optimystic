description: Reviews a change that stopped the peer-to-peer node startup code from silently ignoring failures while connecting up its critical internal services, so a broken wiring now fails loudly at startup instead of degrading quietly.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/logger.ts
difficulty: medium
----

Origin: implement ticket `libp2p-node-base-swallowed-wiring` (itself from review finding eh-4, docs/review.html §9). This is the review handoff.

## What was changed

`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts` injects the running libp2p node
into several services (`setLibp2p`) plus the reputation view (`setReputation`). Every injection was
wrapped in an empty `catch { }`, so a wiring failure was discarded and the node kept running
half-wired — the service falling back to the unreliable `components.libp2p` proxy, with the symptom
surfacing later as unexplained routing/consensus failures. The `createLibp2p(libp2pOptions as any)`
call also defeated libp2p config typing at the seam where a misconfig is most costly.

Per-injection decisions (all from the ticket):

| site | class | new behavior |
|------|-------|--------------|
| networkManager (in-factory, ~line 481) | best-effort proxy | log via `createLogger('node-wiring')`, continue |
| fret (in-factory, ~line 494) | best-effort proxy | log via `createLogger('node-wiring')`, continue |
| fret (post-construction, pre-start) | load-bearing | fail fast (typed, non-optional; throw rejects node creation) |
| networkManager (post-construction, pre-start) | load-bearing | fail fast |
| repo (post-construction, pre-start) | load-bearing | fail fast |
| networkManager.setReputation (post-start) | load-bearing | fail fast, but `await node.stop()` before rethrow |

Structural typing added near the top of the file:
- `SetLibp2pCapable` / `SetReputationCapable` interfaces.
- `WiredServices` typed record (`fret`, `networkManager`, `repo`); the three post-construction
  injections + setReputation now go through `const wired = node.services as unknown as WiredServices`,
  so a renamed/removed service or a changed `setLibp2p`/`setReputation` shape fails the build instead
  of being silently `?.`-skipped.
- `wiringLog = createLogger('node-wiring')` for the two best-effort in-factory injections, mirroring
  the existing log-not-swallow precedent at `network/get-network-manager.ts:13`.

### `as any` removal — landed, and it exposed real dead config

`libp2pOptions` is now typed `Libp2pInit` (the file's existing
`NonNullable<Parameters<typeof createLibp2p>[0]>` alias) and the `as any` on `createLibp2p(...)` is
gone. Two consequences the reviewer should weigh:

1. **`services` field carries a narrow, commented cast** (`as unknown as NonNullable<Libp2pInit['services']>`).
   This is the ticket's explicitly-accepted fallback. Root cause: a SECOND copy of `@libp2p/interface`
   is pulled in transitively via `@libp2p/crypto` (`packages/db-p2p/node_modules/@libp2p/crypto/node_modules/@libp2p/interface`),
   and its `Uint8Array<ArrayBuffer>` vs `<ArrayBufferLike>` PeerId/key shapes are structurally
   incompatible with the top-level copy. The mismatch hits the BUILT-IN factories (`dcutr()` etc.),
   not our custom ones, so it is a dependency-dedup artifact, not a real type error. The cast is
   confined to `services`; the rest of `libp2pOptions` is fully typed. **This is the honest state:
   the full `Libp2pInit` typing did NOT fully land on the services map** — a duplicate-install dedup
   (or a libp2p bump) would let the cast be removed. See tripwire below.

2. **The `connectionManager` block had four stale keys silently ignored under the old `as any`** —
   `autoDial`, `minConnections`, `dialQueue`, and `inboundConnectionUpgradeTimeout` do not exist on
   this libp2p version's `ConnectionManagerInit`. They were dead config (libp2p ignores unknown keys
   at runtime). Fixed behavior-preservingly: `autoDial`/`minConnections`/`dialQueue` dropped
   (auto-dial is now default connection-manager behavior with no direct replacement),
   `inboundConnectionUpgradeTimeout: 10_000` renamed to the real `inboundUpgradeTimeout: 10_000`
   (10_000 is also the default, so identical runtime). **This is a slight scope expansion beyond the
   stated wiring focus, but it is the direct payoff of removing the `as any`** — the exact class of
   misconfig the ticket said this seam should expose. Reviewer should confirm the drop is acceptable
   (i.e. that nothing in this deployment actually relied on a live `minConnections` floor — it could
   not have, since the key was ignored, but confirm the intent).

## Use cases to validate

- **Happy path (primary):** construct a node via `createLibp2pNode` / `createLibp2pNodeBase`; all
  three services resolve the injected node from their first request. Covered by the existing suite
  (1103 passing) — any node-construction spec exercises this path.
- **Fail-fast on broken wiring:** if `node.services.fret/networkManager/repo` were missing or their
  `setLibp2p` threw, node creation now REJECTS (pre-start: nothing leaks). No test simulates a
  renamed/removed service today — the build (tsc) is the compile-time guard, but there is **no
  runtime test asserting the rejection**. Gap; see below.
- **setReputation post-start failure:** on throw the node is stopped before rethrow so no started
  node + open transports leak. Also **not covered by a runtime test** (would need to force
  `setReputation` to throw).
- **Best-effort in-factory injections:** on proxy-time failure they now log (namespace
  `optimystic:db-p2p:node-wiring`) instead of swallowing; the real node is re-injected moments later.
  Verify no behavior regression — these remain non-fatal by design.

## Honest gaps / known tradeoffs (reviewer: treat as a floor)

- **In-factory injections kept as log-not-delete.** The ticket noted these two (`~481`, `~494`) are
  effectively redundant with the post-construction re-injection and could be deleted outright. They
  were kept as log-on-failure to preserve current behavior for any service reading `libp2pRef`
  synchronously between construction and post-construction injection (nothing does today). Reviewer
  may decide the delete is cleaner; left as the lower-risk change.
- **No new runtime tests were added.** The change is type-driven (the typed `WiredServices` record is
  the real guard, enforced by tsc) and the fail-fast paths require forcing a service/injection to
  throw, which the current harness has no fixture for. Validation rests on: (a) tsc passing, (b) the
  full suite still green (1103 passing, 36 pending, 58s). If the reviewer wants defense-in-depth, a
  spec that stubs a throwing `setLibp2p` and asserts `createLibp2pNodeBase` rejects would close the
  fail-fast gap — flagged rather than papered over.
- **`services`-field cast is a residual, not a full type landing.** See tripwire.

## Tripwire (recorded in code, not a ticket)

Added a `NOTE:` comment at the `services` cast site: the cast exists only because `@libp2p/crypto`
pulls a duplicate `@libp2p/interface`; if that dedups (or on a libp2p bump) the
`as unknown as NonNullable<Libp2pInit['services']>` should be removed and the map typed directly.
Conditional (fine now; only becomes work if the dep tree changes), so parked as a comment, indexed
here — not filed as a ticket.

## Verification performed

- `cd packages/db-p2p && npx tsc --noEmit` → clean (exit 0).
- `cd packages/db-p2p && yarn build` (tsc emit) → clean (exit 0).
- `cd packages/db-p2p && yarn test` → 1103 passing, 36 pending (exit 0), ~58s.
- Grep confirms no empty `catch { }` wiring swallows remain; the four surviving `catch {` blocks are
  legitimate peer-unreachable / parse-failure handlers (`return undefined`), out of scope.
