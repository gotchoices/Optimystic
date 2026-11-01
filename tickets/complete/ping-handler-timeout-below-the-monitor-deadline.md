description: A node used to cut off incoming liveness pings after a fixed 10 seconds, which dropped slow-link connections whose other side waited 30 seconds. Embedders can now set that limit, and by default it stays above the node's own declared ping deadline.
architecture: packages/db-p2p/readme.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts, packages/db-p2p/readme.md, .release-notes.pending.md
----

# Ping handler timeout follows the monitor deadline

Reported by Sereus (`../sereus/tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md`). `@libp2p/ping`'s `handlePing` aborts every inbound ping stream after `init.timeout ?? 10_000`. The pinger's `ConnectionMonitor` receives that reset as `StreamResetError` or EOF and aborts the connection, so a declared 30 s `pingTimeout` was capped at the remote's 10 s.

## What landed

- `NodeOptions.pingHandlerTimeoutMs`, resolved at the top of `createLibp2pNodeBase` by `resolvePingHandlerTimeoutMs` in `packages/db-p2p/src/rpc-deadline.ts` and passed as `ping({ timeout })`.
- A declared value is used as given, and an unusable one throws when the node is built.
- When no value is declared and `connectionMonitor.pingTimeout` declares either `minTimeout` or `maxTimeout`, the timeout is twice the monitor's deadline ceiling, floored at 10 s and capped at 2^31 − 1. The ceiling is `maxTimeout`, or libp2p's 60 s default `maxTimeout` when that is undeclared (`declaredMonitorDeadlineCeiling`).
- Otherwise the timeout stays at 10 s.
- The tripwire `NOTE:` on the resolver covers stock-config pairs.
- The change is documented in the readme's React Native section, in the `NodeOptions` doc, and in the release note.

## Review findings

**Checked:** I read the implement diff (`ticket(implement): ping-handler-timeout-below-the-monitor-deadline`) against libp2p's code: `ConnectionMonitor`, `AdaptiveTimeout.getTimeoutSignal` in `@libp2p/utils` and `Ping.handlePing`. I checked the option wiring in `libp2p-node-base.ts`, where `ping()` is the only construction site in `src/`, and confirmed the resolver runs before anything is acquired. I also checked error handling (validation through the shared `validDeclaredMs`), type safety, the docs (`NodeOptions` doc, readme, release note) and the tests.

**Found and fixed (minor):**
- **Correctness: declaring only `minTimeout` reproduced the reported bug.** `AdaptiveTimeout` raises the deadline to `minTimeout` and only then caps it at `maxTimeout`, which defaults to 60 s. So `pingTimeout: { minTimeout: 30_000 }` gives the monitor a deadline of 30–60 s, yet the resolver read only `maxTimeout` and fell back to the 10 s handler. That is exactly the Sereus failure. This was the handoff's first "known gap", and it is reachable with an ordinary configuration, not a speculative one.
  - The resolver now derives from the deadline's ceiling, which is `maxTimeout` or libp2p's default (`LIBP2P_DEFAULT_PING_MAX_TIMEOUT_MS`), whenever either bound is declared. An unusable `maxTimeout` also maps to that default, since libp2p's clamp then never applies it. This resolves the handoff's second gap as well.
  - `DeclaredPingDeadline` now includes `minTimeout`, so the spec's `as Libp2pConnectionMonitorInit` cast is gone.
  - The `NodeOptions` doc, readme and release note now state the rule.
- **Test: the spec pinned the defect.** The pure-resolver test asserted that a `minTimeout`-only declaration gives 10 s; it now asserts 120 s.
  - I replaced the loop of `greaterThan` checks, which the exact `60_000` assertion already covered, with an exact check of the 10 s floor at `maxTimeout: 3_000`.
- **DRY: the node config was copied twice in the spec.** The implementer widened the first describe's `spawn` to take `pingHandlerTimeoutMs`, never used it there, and copied the whole node config twice in the new describe. It is now one module-level `spawnInto(nodes, extra)` that both describes use.

**Tripwires:** None new. The existing resolver `NOTE:` (stock-config pairs keep 10 s) still holds.

**Considered, no action:**
- The handler timeout holds a stalled inbound stream longer. This is bounded per connection by `maxInboundStreams` and documented as the cost.
- The "both ends configured alike" assumption is documented in both places, consistent with the existing `connectionMonitor` advice.
- No slow-link simulation was added, by design of the ticket. The two-node arm proves the option reaches the service.
- The empty `catch` in the two-node arm is a test-only, commented "a reset is the expected end".

**Validation:**
- `yarn build` (db-p2p): clean.
- `yarn lint` (root): clean.
- `yarn lint:docs`: clean.
- Targeted spec run: 5 passing.
- Full db-p2p `yarn test`: 3474 passing, 73 pending, 0 failing.
