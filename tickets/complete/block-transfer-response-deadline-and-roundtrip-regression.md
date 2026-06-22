description: A peer that connects but then goes silent could make a block-copy request wait forever and stall re-replication during node churn; this added a response deadline so a silent peer is given up on, plus a fast automated test proving block copying works end-to-end. Reviewed and accepted.
prereq:
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts
----

# Complete: block-transfer response deadline + round-trip regression test

## Summary of landed work

Two gaps from the fix stage, both implemented and verified in review.

- **`ProtocolClient` response deadline** (`src/protocol-client.ts`): the response-read phase
  now honors an optional `responseTimeoutMs` and a forwarded parent `signal`. On either, it
  calls `stream.abort(reason)` — the decisive action that rejects the stream's async iterator
  and unblocks the otherwise-infinite `for await`. The iterator error is translated to
  `ResponseTimeoutError` (our timer) / `signal.reason` (parent) / rethrown as-is. `finally`
  clears the timer, removes the listener, and guards `stream.close()`. When neither
  `responseTimeoutMs` nor `signal` is supplied, no cap is imposed — exact prior behavior.
- **Plumbing**: `BlockTransferClient.pullBlocks`/`pushBlocks` gained a trailing optional
  `{ signal?, dialTimeoutMs?, responseTimeoutMs? }`. `SpreadOnChurnConfig` gained
  `pushDialTimeoutMs` (default 3000) and `pushResponseTimeoutMs` (default 10000); `performSpread`
  passes both into `pushBlocks`, and a timed-out push is recorded `failed` by the pre-existing catch.
- **Round-trip regression test** (`test/block-transfer-roundtrip.spec.ts`): drives request→response
  through the *registered stream handler* (not a direct `handlePull`/`handlePush`), exercising the
  positional-arg handler-unwrap that was the original churn-hang bug — covers pull, push-with-persistence,
  and a no-response-peer deadline, all in the default (no env gate) suite.

## Review findings

### What was checked
- Read the full implement diff (`a1df9f2`) with fresh eyes before the handoff summary.
- Read every touched source file in full: `protocol-client.ts`, `block-transfer-service.ts`,
  `spread-on-churn.ts`, plus all three touched test files.
- Traced the response-deadline control flow across every branch: timer fire, parent-abort,
  no-cap, precedence-when-both-fire, success-with-timeout-configured, JSON-parse-error,
  no-response (`onEmpty`), and listener/timer cleanup in `finally` (no leaks across the
  dial→response phase transition).
- Verified the production stream contract: `IPeerNetwork.connect` returns a libp2p `Stream`
  obtained via `newStream`/`dialProtocol`; `.send()`/`.abort()` are already used in production
  by the service handler (`block-transfer-service.ts:155`) and other services, so the fix does
  not depend on an unproven API surface — only the "abort unblocks the read" semantic is
  integration-only (documented libp2p behavior).
- Confirmed config plumbing is reachable end-to-end: `libp2p-node-base.ts`
  (`spreadOnChurn?: Partial<SpreadOnChurnConfig>`) → `initSpreadOnChurnMonitor` → monitor, so
  the new timeout fields are configurable per node with no wiring change.
- Docs: grepped all `*.md` for the new config keys — no stale references outside this ticket;
  JSDoc on `pullBlocks`/`pushBlocks`/`SpreadOnChurnConfig` accurately reflects the new behavior.
- Build + tests, see below.

### Build / lint / tests
- `yarn build` (tsc) in `packages/db-p2p`: exit 0.
- Lint: root `lint` script is a no-op echo ("Lint not configured for all packages") — nothing
  to run; recorded explicitly rather than silently skipped.
- Focused suite (`block-transfer-roundtrip` + `protocol-client-dial-timeout` + `spread-on-churn`):
  36 passing.
- Full `yarn test` in `packages/db-p2p`: **1030 passing, 33 pending**, exit 0. The previously
  flagged flaky `threshold-assembly.spec.ts` ("signers are ascending") was already fixed by the
  runner's triage pass (`7042743`); `tickets/.pre-existing-error.md` no longer exists. No flakes
  observed this run.

### Findings
- **Minor — none requiring an inline fix.** The implementation is clean, mirrors the existing
  `DialTimeoutError` machinery (DRY), handles cleanup correctly, and is well-typed. Test coverage
  is genuinely adversarial (happy path, persistence proof, deadline bound, parent-abort precedence,
  no-cap, end-to-end through the monitor including "silent target does not block a later healthy
  target"). The new round-trip test would catch a regression of the original `data.stream` vs
  positional-arg handler bug.
- **Positive side effect noted:** the new signal-forwarding-to-`stream.abort` means
  `DisputeClient.sendChallenge` (which already passes `AbortSignal.timeout`) now actually tears
  down the *read* on timeout, not just the dial — a latent improvement this change delivers for free.
- **Major — filed as a new ticket** (`protocol-client-response-deadline-remaining-callers`): the
  same response-hang class still affects the other `ProtocolClient` callers. `cluster/client.ts:27`
  and `sync/client.ts:32` pass neither `signal` nor any timeout → a peer that dials OK then goes
  silent hangs the caller forever. `dispute/client.ts` `sendResolution` is likewise unbounded.
  `repo/client.ts` wraps the call in a `Promise.race` timeout, which bounds the *caller* (~30s) but
  does **not** abort the losing promise — so the underlying stream read leaks in the background on
  every timed-out repo RPC to a silent peer. Out of scope here (this ticket was scoped to
  block-transfer + spread); the deadline primitive now exists, so wiring it into these callers is a
  contained follow-up.

### Deferred (carried over from implement, not a review regression)
- `yarn test:integration` (env-gated `OPTIMYSTIC_INTEGRATION=1` churn e2e) was **not** run — its
  wall-clock risks the agent idle budget. It is the only test that exercises a genuine libp2p stream
  abort. Run it in CI / by hand to confirm the real-libp2p path before fully trusting the fix in
  production. Mitigation: `.send()`/`.abort()` are already proven in-repo on the production stream
  type (see above), so the residual risk is narrow.

## Acceptance status (all met)
- [x] A silent expansion peer cannot stall `performSpread` beyond the deadline (verified through the
      monitor in `spread-on-churn.spec.ts`).
- [x] `yarn test` (no env gate) covers a handler+stream round trip (pull + push w/ persistence) and a
      no-response-peer deadline case.
- [x] `yarn build` + `yarn test` pass in `packages/db-p2p` (1030 passing, 33 pending).
- [x] No behavior change for `processMessage` callers passing neither `responseTimeoutMs` nor `signal`.
- [~] Integration e2e deferred to CI (see above).
