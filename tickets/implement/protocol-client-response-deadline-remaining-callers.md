description: Most peer-to-peer requests can still wait forever if the other node connects and then goes quiet — only the block-copy path was protected so far. Wire the same "give up if no reply" deadline into the cluster, sync, dispute, and transaction request types so one silent peer can't freeze the system.
prereq:
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/src/cluster/spread-on-churn.ts
difficulty: medium
----

# Implement: response deadline for the remaining ProtocolClient callers

## Background (verified against HEAD)

`ProtocolClient.processMessage` (`packages/db-p2p/src/protocol-client.ts:50-188`) already supports
`dialTimeoutMs` and `responseTimeoutMs` options plus a parent `signal`. Its response-read phase
(lines 120-187) starts a timer that calls `stream.abort(new ResponseTimeoutError(...))`, forwards a
parent `signal` abort to `stream.abort(signal.reason)`, and translates the resulting iterator
rejection into either `ResponseTimeoutError`, `signal.reason`, or the raw error (lines 166-179).
When neither `responseTimeoutMs` nor `signal` is supplied, **no cap is imposed** — every existing
caller keeps working unchanged.

This primitive was wired into the block-transfer path only. `BlockTransferClient.pullBlocks` /
`pushBlocks` (`block-transfer-service.ts:260-295`) simply forward an `options` bag
(`{ signal?, dialTimeoutMs?, responseTimeoutMs? }`) into `processMessage`; the **defaults** live one
layer up in `SpreadOnChurnMonitor` config (`spread-on-churn.ts:78-79`,
`pushDialTimeoutMs: 3000`, `pushResponseTimeoutMs: 10000`, passed at `:250-251`). Those two numbers
are the codebase's reference conventions: **dial cap ≈ 3000ms, response cap ≈ 10000ms.**

The identical response-hang vulnerability remains in the other `ProtocolClient` subclasses. All four
were re-read and confirmed at HEAD:

- **`cluster/client.ts:27`** — `update()` calls `this.processMessage<unknown>(message, protocol)`
  with no `signal`/timeout. A silent cluster peer hangs the caller forever. Note the redirect-retry
  recursion at `:48-49` (`nextClient.update(record, hop + 1)`) — any options must thread through it.
  `ICluster` (`packages/db-core/src/cluster/i-cluster.ts:4`) declares `update(record): Promise<…>`;
  the impl already adds an internal `hop` param, so appending an **optional** `options` param is
  interface-compatible.
- **`sync/client.ts:32`** — `requestBlock` calls `processMessage(request, this.protocol)` with no
  `signal`/timeout. Silent peer → indefinite hang on block sync.
- **`dispute/client.ts`** — `sendResolution` (`:34-40`) passes no `signal`/timeout (unbounded).
  `sendChallenge` (`:22-31`) builds a `signal` only when the caller supplies `timeoutMs`
  (`AbortSignal.timeout(timeoutMs)`); with the current `processMessage` that signal now genuinely
  tears down the read (not just the dial), so its behavior is already correct and must be preserved.
- **`repo/client.ts:57-102`** — `processRepoMessage` wraps `super.processMessage(...)` in a
  `Promise.race` against `setTimeout(reject(new Error('RepoClient timeout')), msLeft)` where
  `msLeft = max(1, (options.expiration ?? Date.now()+30_000) - Date.now())`. This bounds the
  **caller** but the losing branch of the race does **not** cancel the inner `processMessage` — the
  underlying stream read keeps running, leaking a pending read + stream on every timed-out repo RPC
  to a silent peer. It forwards `options?.signal` and `options?.dialTimeoutMs` (`:78-80`), so an
  aborted caller signal tears the read down, but the `withTimeout` mechanism itself never aborts
  anything, so the leak persists on a plain deadline expiry.

## Design

### Shared pattern for cluster / sync (simple forwarders + defaults)

Mirror `BlockTransferClient`: accept an optional `options` bag and forward it to `processMessage`,
but — unlike block-transfer — apply **client-level defaults** so callers that pass nothing still get
a deadline (block-transfer left defaults to its monitor; these clients have many callers and no
single owning monitor, so the default belongs on the client).

```
const DEFAULT_DIAL_TIMEOUT_MS = 3000;       // matches spread-on-churn pushDialTimeoutMs
const DEFAULT_RESPONSE_TIMEOUT_MS = 10000;  // matches spread-on-churn pushResponseTimeoutMs

type RpcDeadlineOptions = { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number };

// merge so an explicit 0/undefined override is honored but absent keys get the default
const opts = {
  dialTimeoutMs: options?.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS,
  responseTimeoutMs: options?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
  signal: options?.signal,
};
```

- **`cluster/client.ts`**: add `options?: RpcDeadlineOptions` to `update(record, hop = 0, options?)`.
  Pass the merged `{ signal, dialTimeoutMs, responseTimeoutMs }` to `processMessage` at `:27`, and
  thread the **same `options`** (not re-defaulted again — pass the caller's original `options`
  through) into the redirect recursion `nextClient.update(record, hop + 1, options)` at `:49` so a
  redirected hop keeps the deadline. The structured-error envelope and redirect-loop guards are
  unchanged.
- **`sync/client.ts`**: add `options?: RpcDeadlineOptions` to `requestBlock(request, options?)` and
  forward the merged opts to `processMessage` at `:32`.

### dispute/client.ts

- `sendResolution` (`:34-40`): add `options?: RpcDeadlineOptions`, forward merged defaults (dial 3000,
  response 10000) to `processMessage`. This is a broadcast/ack, so the response cap is the important
  one.
- `sendChallenge` (`:22-31`): **preserve existing behavior.** It already derives a `signal` from
  `timeoutMs` via `AbortSignal.timeout`. Optionally also apply `DEFAULT_DIAL_TIMEOUT_MS` so a
  challenge to an unreachable arbitrator fails the dial fast even when no `timeoutMs` was given — but
  do **not** change the `timeoutMs`→`signal` semantics that callers already rely on. Add a brief
  comment that, post-`processMessage`-deadline-work, the `signal` now tears down the read (the
  desired behavior), not merely the dial.

### repo/client.ts (the leak fix — most care needed)

Replace the leaky `Promise.race` with a deadline that actually cancels the inner read, while keeping
the caller-facing `'RepoClient timeout'` message and the redirect/retry semantics intact.

Approach: drive the existing `msLeft` budget through an `AbortController` whose abort **reason is
`new Error('RepoClient timeout')`**, combined with the caller's `options.signal`, and pass the
combined signal into `super.processMessage(...)` as `signal`. Because `processMessage` forwards
`signal` to both the dial and the response-read phase and calls `stream.abort(signal.reason)` /
rethrows `signal.reason` on abort (see `protocol-client.ts:123-136, 175-178`), the loser is now
genuinely cancelled and the caller still observes an error whose `.message === 'RepoClient timeout'`.

```
const deadlineMs = Math.max(1, deadline - Date.now());
const deadlineController = new AbortController();
const timer = setTimeout(
  () => deadlineController.abort(new Error('RepoClient timeout')),
  deadlineMs
);
// combine caller signal + our deadline; whichever aborts first wins, reason propagates
const combined = options?.signal
  ? AbortSignal.any([options.signal, deadlineController.signal])
  : deadlineController.signal;
try {
  response = await super.processMessage<any>(message, preferred, {
    signal: combined,
    correlationId,
    dialTimeoutMs: options?.dialTimeoutMs,
  });
} finally {
  clearTimeout(timer);
}
```

Notes / gotchas to verify during implementation:
- `AbortSignal.any` is available on the project's Node target (Node ≥ 20). Confirm via the engines
  field / other usages; if not available, write a tiny manual combinator (listen on both, abort a
  fresh controller with the firing signal's `reason`). **Check first** — do not assume.
- The redirect retry at `:96-99` passes the **original `options`** to the recursive
  `processRepoMessage`, which re-derives a fresh deadline from `options.expiration`. That matches the
  old behavior (each hop got a fresh `withTimeout`); keep it that way. Do **not** thread the combined
  signal into the recursion — the recursion rebuilds its own.
- When `deadlineController` fires during the **dial** phase and `dialTimeoutMs` is set, note the dial
  path has its own `DialTimeoutError` controller; the combined signal aborting will surface as the
  generic abort branch (`throw err`) unless it is the `DialTimeoutError`. Confirm the surfaced error
  on a pure-deadline expiry (no `dialTimeoutMs`) is the `'RepoClient timeout'` Error, and on a dial
  timeout (`dialTimeoutMs` set + slow dial) is still `DialTimeoutError`. Both are acceptable
  caller-facing outcomes; the test should assert the timeout-during-response case yields
  `'RepoClient timeout'`.
- Consider whether to also pass `responseTimeoutMs` to `processMessage`. It is redundant with the
  combined signal (the signal already bounds the read at `deadlineMs`) and would introduce a second,
  shorter cap that could mask the `'RepoClient timeout'` message with `ResponseTimeoutError`. Prefer
  the signal-only approach so the caller-facing message is preserved; document the choice in a code
  comment.

## Constraints (from the fix ticket)

- Reuse the existing `responseTimeoutMs` + `signal` machinery in `processMessage`; do **not** add a
  parallel mechanism.
- Defaults overridable by callers; absent → default applied (cluster/sync/dispute), repo keeps its
  `expiration`-or-30s budget.
- Backward compatibility: callers passing nothing keep working. Adding a default deadline is a
  behavior change — document the new default constants with a comment and keep the numbers reviewable
  (dial 3000, response 10000, matching `spread-on-churn.ts`).
- No change to the wire protocol or server-side handlers.

## Test strategy

Model the silent peer exactly as the existing specs do. Two reusable harnesses already exist:
- `test/protocol-client-dial-timeout.spec.ts:19-29` — `silentStream()` (source never yields;
  `abort(err)` rejects the read). Use for direct `processMessage`-shaped tests.
- `test/block-transfer-roundtrip.spec.ts:50-67` — `makeLinkedPair()` for happy-path round trips, and
  `:165-175` — a silent-peer `connect` stub for the timeout case.

For each client construct a mock `IPeerNetwork` whose `connect` returns a silent stream, then assert
the caller rejects within a bounded deadline rather than hanging (use a tight per-test
`responseTimeoutMs` override + `this.timeout(2000)` so a regression fails fast). Add the new specs in
the `db-p2p` test dir (suggest one file `test/rpc-response-deadline.spec.ts`, or co-locate per
client — match the existing file-per-concern convention).

Run from the package: `yarn workspace @optimystic/db-p2p test` (stream the output with `2>&1 | tee`).
Also run the type check / build for the package. If a failure surfaces that is clearly unrelated to
this diff, follow the pre-existing-error flagging procedure.

## TODO

### Phase 1 — cluster + sync
- [ ] Add shared default constants (dial 3000, response 10000) — co-locate in each client or a small
  shared spot; do not over-engineer a new module if a per-client const is clearest.
- [ ] `cluster/client.ts`: add optional `options` to `update`, merge defaults, forward to
  `processMessage`, and thread the original `options` through the redirect recursion.
- [ ] `sync/client.ts`: add optional `options` to `requestBlock`, merge defaults, forward.

### Phase 2 — dispute
- [ ] `dispute/client.ts`: bound `sendResolution` with merged defaults; preserve `sendChallenge`'s
  `timeoutMs`→`signal` semantics (optionally add a dial default), add the clarifying comment.

### Phase 3 — repo (leak fix)
- [ ] Verify `AbortSignal.any` availability on the Node target; choose it or a manual combinator.
- [ ] Replace `withTimeout`/`Promise.race` with the deadline-`AbortController` + combined signal,
  abort reason `new Error('RepoClient timeout')`, `clearTimeout` in `finally`.
- [ ] Confirm redirect retry still rebuilds its own deadline and `'RepoClient timeout'` + redirect
  loop guards still hold.

### Phase 4 — tests + validation
- [ ] Silent-peer timeout test per client (cluster, sync, dispute `sendResolution`, repo) → rejects
  with `ResponseTimeoutError`/`'RepoClient timeout'` within a bounded deadline.
- [ ] repo-specific: assert the underlying read is torn down on timeout (no leaked pending read) and
  redirect/retry still works.
- [ ] Happy-path regression: peer replies promptly → success with the deadline configured.
- [ ] `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log` + package build/type
  check. Flag any clearly-unrelated failure via `tickets/.pre-existing-error.md`.
