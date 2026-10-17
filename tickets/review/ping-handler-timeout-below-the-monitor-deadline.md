description: A node used to cut off incoming liveness pings after a fixed 10 seconds, which dropped slow-link connections whose other side waited 30 seconds. Embedders can now set that limit, and by default it stays above the node's own declared ping deadline.
architecture: packages/db-p2p/readme.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/test/connection-monitor-ping-overlap.spec.ts, packages/db-p2p/readme.md, .release-notes.pending.md
----

# Ping handler timeout follows the monitor deadline — review handoff

Reported by Sereus (`../sereus/tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md`): `@libp2p/ping`'s `handlePing` aborts every inbound ping stream after `init.timeout ?? 10_000`, the reset reaches the pinger's `ConnectionMonitor` as `StreamResetError`/EOF, and the monitor aborts the connection. So the declared 30 s `pingTimeout` was capped at the remote's 10 s.

## What changed

- `resolvePingHandlerTimeoutMs(declared, connectionMonitor)` and `DEFAULT_PING_HANDLER_TIMEOUT_MS` (10 000) in `packages/db-p2p/src/rpc-deadline.ts`:
  - declared → `validDeclaredMs('pingHandlerTimeoutMs', …, 2^31 − 1)`, returned as given (never raised);
  - else `connectionMonitor.pingTimeout.maxTimeout` finite and > 0 → `min(2^31 − 1, max(10 000, 2 × maxTimeout))`;
  - else 10 000 (the library's own value, passed explicitly — behaviour identical to before).
  - Tripwire `NOTE:` on the function: stock-config pairs keep the 10 s default even though libp2p's adaptive monitor can rise toward its 60 s default max.
- `NodeOptions.pingHandlerTimeoutMs` (doc beside `connectionMonitor`: cause, default rule, both-ends assumption, cost). Resolved at the top of `createLibp2pNodeBase` next to the other deadline resolvers (so a bad value throws before anything is acquired), passed as `ping({ timeout })`. The "constructed bare" `NOTE:` at the ping service is updated; `maxOutboundStreams` untouched.
- Readme React Native section: new paragraph "The answering side's ping timeout is the third bound". Release note under Unreleased.

## Tests (in `test/connection-monitor-ping-overlap.spec.ts`, new describe `pingHandlerTimeoutMs — the answering side never fires first`; header comment extended)

- "defaults strictly above a declared monitor deadline…" — pure: maxTimeout 30 000 and 3 000 both yield a default above them (60 000 exactly for 30 000), cap at 2^31 − 1, no `maxTimeout` / no monitor → 10 000.
- "uses a declared value as given and refuses an unusable one" — 300 returned despite a 30 s monitor; NaN, ∞, 0, −1, 2^31 throw naming the field.
- "aborts an inbound ping stream the pinger never closes at the declared timeout" — real two-node arm: listener with `pingHandlerTimeoutMs: 300`, dialer raw-dials `/ipfs/ping/1.0.0`, sends 32 bytes, reads until the stream ends; asserts ≥ 300 ms (clocked before the dial) and < 5 000 ms (well under the library's 10 s), proving the option reaches the service.

## Validation

- `yarn build` (db-p2p) clean; targeted grep run: 6 passing; `yarn lint:docs` clean. Full `yarn test` in db-p2p: 3474 passing, 73 pending, 0 failing.

## Known gaps / for the reviewer

- The default derives only from `maxTimeout`; a deployment that declares only `minTimeout` (with libp2p's 60 s default `maxTimeout`) gets 10 s. Matches the ticket's design, but worth a look — `min(maxTimeout default)` reasoning is the same as the tripwire.
- `resolvePingHandlerTimeoutMs` silently ignores a non-finite/≤0 `maxTimeout` (falls back to 10 s) rather than throwing; that field belongs to libp2p and is passed through unchecked elsewhere.
- No slow-link simulation of the original Sereus symptom (deliberately, per ticket).
