description: Most peer-to-peer requests can still wait forever if the other node connects and then goes quiet — only the block-copy path was just protected. Extend that same "give up if no reply" deadline to the remaining request types so one silent peer can't freeze a transaction, a sync, a cluster update, or a dispute.
prereq:
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts
difficulty: medium
----

# Fix: response deadline for the remaining ProtocolClient callers

## Background

`ProtocolClient.processMessage` (`src/protocol-client.ts`) now supports a `responseTimeoutMs`
option and forwards a parent `signal` to `stream.abort(...)` during the response-read phase, so a
peer that dials OK but never writes a reply (and never closes the stream) no longer hangs the
`for await` read forever. That primitive was wired into the **block-transfer** path only
(`BlockTransferClient` + `SpreadOnChurnMonitor`).

The identical response-hang vulnerability remains in the other `ProtocolClient` subclasses, which
were intentionally left out of the block-transfer ticket's scope:

- **`cluster/client.ts:27`** — `processMessage(message, protocol)` with no `signal` and no timeout.
  A silent cluster peer hangs the caller indefinitely. Cluster updates sit on the membership/
  coordination path, so a single dying member can stall coordination.
- **`sync/client.ts:32`** — `requestBlock` calls `processMessage(request, this.protocol)` with no
  `signal` and no timeout. A silent peer hangs block sync forever.
- **`dispute/client.ts`** — `sendResolution` (`:36`) passes no `signal`/timeout (unbounded).
  `sendChallenge` (`:25`) only passes a `signal` when the caller supplies `timeoutMs`; with the new
  code that signal now *does* tear down the read (good), but the unbounded paths remain.
- **`repo/client.ts:77`** — wraps `super.processMessage(...)` in a `Promise.race` against a
  `setTimeout(... 'RepoClient timeout')`. This bounds the **caller** (~30s default), but the race
  losing does **not** cancel the inner promise — the underlying stream read keeps running in the
  background, leaking a pending read (and the stream) on every timed-out repo RPC to a silent peer.
  It does forward `options?.signal`, so an aborted caller signal now tears the read down; but the
  `withTimeout` mechanism itself never aborts that signal, so the leak persists on plain timeout.

This is the same class of bug whose block-transfer instance traced back to a real churn hang. The
deadline primitive now exists; this ticket is about applying it consistently to the remaining RPC
clients.

## Expected behavior

Every `ProtocolClient`-based RPC should be bounded against a peer that connects and then goes
silent: the read phase must be torn down (via `stream.abort`) and the caller must observe a
distinguishable error (`ResponseTimeoutError`, or the parent `signal.reason`) within a bounded
deadline, rather than hanging or leaking a background stream read.

Specific outcomes to achieve:

- `cluster/client.ts` and `sync/client.ts` impose a sensible default response deadline (and accept
  an override), so a silent peer fails fast instead of hanging the caller.
- `dispute/client.ts` `sendResolution` is bounded; `sendChallenge`'s existing behavior is preserved
  (and confirmed to now tear down the read, not just the dial).
- `repo/client.ts` no longer leaks the underlying read on timeout: prefer driving the deadline
  through an `AbortController`/`responseTimeoutMs` passed into `processMessage` (which aborts the
  stream) instead of, or in addition to, the `Promise.race`, so the loser is actually cancelled.
  Preserve the existing redirect/retry and `RepoClient timeout` caller-facing semantics.

## Specifications / constraints

- Reuse the existing `responseTimeoutMs` + `signal` machinery in `processMessage`; do not add a
  parallel mechanism.
- Default values should match the codebase's conventions (dial caps ~3000ms; the block-transfer
  response default is 10000ms) and be overridable by callers. Sanity-check against real RPC timing
  so defaults are not so tight they cause false failures on healthy-but-slow peers.
- Backward compatibility: callers that pass nothing should keep working; adding a default deadline
  is a behavior change, so document it and make the values reviewable.
- No change to the wire protocol or the server-side handlers.

## Test cases to cover

- For each client (cluster, sync, dispute `sendResolution`, repo): a peer that dials OK but never
  replies → caller rejects with `ResponseTimeoutError` (or the parent reason) within a bounded
  deadline, not a hang. Model the silent peer the same way the existing tests do (a stream whose
  source never yields and whose `abort` rejects the read) — see
  `test/protocol-client-dial-timeout.spec.ts` and `test/block-transfer-roundtrip.spec.ts`.
- `repo/client.ts`: assert the underlying read is actually torn down on timeout (no leaked pending
  read), and that redirect/retry + the caller-facing `RepoClient timeout` semantics still hold.
- Regression: callers on the happy path (peer replies promptly) still succeed with the deadline
  configured.
