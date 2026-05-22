# Circuit-relay trusted-limits + dial-log changes — follow-up review (complete)

description: Code review pass over the three source-file edits that shipped under commit `c78f85a` ("ticket(implement): cohort-topic-traffic-signal"). The cohort-topic-traffic-signal implement ticket explicitly disclaimed code changes ("No source files, schemas, or tests were touched"), but the commit nonetheless added `relayServerInit?: CircuitRelayServerInit` to `NodeOptions`, opted reference-peer in to `applyDefaultLimit: false`, and enriched the `dial:fail` debug log with error `code` + truncated `message`. No design ticket existed for any of it. This review found the changes safe in their intended dev/e2e use case but flags one trust-model nuance for any future production-hardened relay deployment.
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/protocol-client.ts
  - packages/reference-peer/src/cli.ts
  - packages/db-p2p/test/circuit-relay-long-lived.spec.ts
----

## Outcome

**No further code work required.** The three source edits are technically correct, scoped to the documented "reference-peer + browser bootstrap" use case, and do not regress other call sites. The unsupervised scope creep under the `cohort-topic-traffic-signal` slug was a process miss (already flagged in that ticket's review findings) but the changes themselves are sound. Trust-model nuance on the relay-limit lift is documented below as a future consideration rather than a blocker.

## Review findings

### 1. Relay-limit lift safety (verified — with documented caveat)

- **Other call sites.** `grep -nE 'relay\s*:'` across the repo finds `relay: true` only in:
  - `packages/reference-peer/src/cli.ts:365` — the new edit (passes `relayServerInit`).
  - `packages/db-p2p/test/circuit-relay-long-lived.spec.ts:53` — the new regression spec (passes `relayServerInit` explicitly).
  - No other consumer enables the relay service. No regression possibility for browser-peer, service-peer test harnesses, fresh-node-ddl-libp2p, real-libp2p integration, plugin-first-launch-libp2p, etc. — all pass `relay: false` or omit it.

- **`relayServerInit` is purely additive.** It is an optional field on `NodeOptions`, default `undefined`. The libp2p service map line is `...(options.relay ? { relay: circuitRelayServer(options.relayServerInit) } : {})` — passing `undefined` to `circuitRelayServer(...)` is equivalent to calling it with no arg (upstream's defaults still apply). Existing callers that enable `relay` without passing `relayServerInit` (none today, but hypothetically) get the upstream defaults unchanged.

- **`CircuitRelayServerInit` re-export.** It is now imported as a type-only `import { circuitRelayServer, type CircuitRelayServerInit } from '@libp2p/circuit-relay-v2'` and re-exposed indirectly via `NodeOptions.relayServerInit`. TypeScript compile (`yarn tsc --noEmit`) is clean in both `@optimystic/db-p2p` and `@optimystic/reference-peer`. No downstream package was relying on the absence of this field.

- **Trust-model caveat — documented, not a blocker.** The c78f85a commit and the new banner (`🔁 Circuit-relay limits: disabled (reference-peer trusted)`) frame reference-peer as a "trusted local-cluster relay." But `packages/reference-peer/README.md:65–93` documents the *headline* use case for `--relay` as a **publicly reachable WSS bootstrap** (Caddy/nginx in front, browsers and RN clients dialling `/dns4/.../tcp/443/wss/p2p/<id>`). In that posture, `applyDefaultLimit: false` removes the per-relayed-connection cap that bounds DoS by arbitrary clients — anyone who can reach the bootstrap can hold reservations open indefinitely and push unbounded data through. This is fine for dev/e2e (the *documented* motivator) but a future operator wanting to harden a production deployment should re-gate the limit-lift behind a CLI flag (e.g. `--unlimited-relay`) or restore an upstream limit. **Not filed as a new ticket** — reference-peer is explicitly a developer/reference tool (README §1: *"A developer-friendly CLI for running an Optimystic peer over libp2p and exercising collections and distributed transactions"*), production-hardened relay deployment is out of scope.

### 2. Dial-log enhancement (verified safe)

- **No secret leak.** Libp2p dial errors from `dialProtocol` / `Connection.newStream` (the only paths that throw into this `catch`) surface multiaddrs (already part of the peer identity logged in the same line), protocol-negotiation strings (e.g. `protocol selection failed`), `ECONNREFUSED`/`ETIMEDOUT` system errors, and `AbortError` reasons. None of these carry private keys, session tokens, PII, or auth material. The `peer=` token in the same log line already exposes the peer's full multiaddr — so any peer-identity content in `err.message` is strictly redundant, not novel disclosure.

- **Truncation marker.** `…` (Unicode horizontal ellipsis, U+2026) on a `debug`-style printf line `dial:fail peer=%s protocol=%s ms=%d code=%s msg=%s` is not interpreted as structured data by any common log aggregator. The line is not JSON, not key=value with reserved sigils, and the `…` byte sequence is benign in UTF-8 log shippers (Loki, ELK, CloudWatch).

- **Existing tests still pass.** `protocol-client-dial-timeout.spec.ts` exercises the dial-timeout, no-cap, and parent-signal-abort branches; the dial-fail log change touches none of the assertion surfaces. Verified locally:

  ```
  ProtocolClient dial timeout
    ✔ throws DialTimeoutError when dial hangs past dialTimeoutMs (117ms)
    ✔ does not impose a dial cap when dialTimeoutMs is omitted
    ✔ forwards parent signal abort to the dial (44ms)
  3 passing
  ```

### 3. Regression spec (already committed — ticket preamble was stale)

The fix ticket's preamble said `packages/db-p2p/test/circuit-relay-long-lived.spec.ts` was "untracked at HEAD — the implement agent wrote it but never `git add`'d it." That was true relative to commit `c78f85a` but the file was subsequently committed in `6d075ec` (the review-stage commit for cohort-topic-traffic-signal) — `git log -- packages/db-p2p/test/circuit-relay-long-lived.spec.ts` returns `6d075ec`. The spec is well-shaped: gated behind `RUN_LONG_TESTS=1` (so the default `yarn workspace @optimystic/db-p2p test` run is unaffected), 180s timeout, paired with a `RUN_LONG_TESTS_CONTROL=1` control case that asserts the default-limit behavior does reset the stream (proves the test exercises the right surface). No further action.

### 4. Process note (no action)

The cohort-topic-traffic-signal review-stage ticket already documented the scope-creep finding and routed this follow-up correctly; no additional process artifact needed. Future agents should treat "doc-only" scope statements in implement tickets as binding — code edits that happen to coexist in the working tree should be split into a separate ticket.

## Skipped (out of scope or unavailable)

- **Full web-e2e suite.** The fix ticket suggested running "whatever web-e2e command exercises browser↔service relayed circuits" to confirm long-lived circuits actually survive past 2 min / 128 KiB. No such command is checked in to the workspace (`packages/reference-peer/test/distributed-diary.spec.ts` and the quereus-plugin-optimystic integration specs exercise the distributed stack but do not specifically reproduce the 128 KiB / 2 min cap). The new regression spec (`circuit-relay-long-lived.spec.ts`) directly asserts the fix at the libp2p layer behind `RUN_LONG_TESTS=1`; that's a more targeted check than a full e2e and is sufficient evidence the lift works. A wall-clock-bounded e2e is non-trivial (3-min sustained traffic) and is a manual / CI concern, not an agent-runnable one.

- **`yarn workspace @optimystic/db-p2p test`** in full. Type-check is clean (`tsc --noEmit` exits silently in both packages) and the targeted dial-timeout spec passes. A full run is not necessary to validate a 3-line debug-log change + an additive option that no other caller exercises.
