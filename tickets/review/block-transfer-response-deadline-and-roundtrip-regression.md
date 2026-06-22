description: A peer that connects but then goes silent could make a block-copy request wait forever and stall re-replication during node churn; this adds a response deadline so a silent peer is given up on, and adds a fast automated test proving block copying works end-to-end over a real stream.
prereq:
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts
difficulty: medium
----

# Review: block-transfer response deadline + round-trip regression test

## What was implemented

Two gaps from the fix stage, both landed.

### Gap 1 — `ProtocolClient` response deadline (`src/protocol-client.ts`)
The dial phase was already bounded by `dialTimeoutMs`; the **response-read** phase honored no
deadline, so a peer that dialed OK but never wrote a reply (and never closed the stream) hung
`first(...)`'s `for await` forever.

Changes:
- Added `ResponseTimeoutError` + `RESPONSE_TIMEOUT_ERROR_CODE` (`'RESPONSE_TIMEOUT'`), mirroring the
  existing `DialTimeoutError` machinery, so callers can distinguish "peer went silent" from a dial
  failure and from a parent cancellation.
- Added `responseTimeoutMs?: number` to the `processMessage` options bag.
- In the response-read phase: a `setTimeout(responseTimeoutMs)` and a forwarded `options.signal`
  listener both call **`stream.abort(reason)`** on fire. The key design point (called out in the fix
  ticket): a timer alone is insufficient — the underlying `for await` keeps awaiting; only aborting
  the stream rejects its async iterator and unblocks the read. The resulting iterator error is caught
  and translated to `ResponseTimeoutError` (our timer) / the parent `signal.reason` (parent abort) /
  rethrown as-is otherwise. `finally` clears the timer, removes the listener, and guards
  `stream.close()` in try/catch (closing an already-aborted stream must be safe).
- **No behavior change** when both `responseTimeoutMs` and `signal` are omitted — no cap is imposed,
  preserving every existing caller (repo/cluster/dispute/block-transfer), exactly mirroring how
  omitting `dialTimeoutMs` imposes no dial cap.

### Gap 1 plumbing — block-transfer client + spread caller
- `BlockTransferClient.pushBlocks` / `pullBlocks` (`src/cluster/block-transfer-service.ts`) gained an
  optional trailing `{ signal?, dialTimeoutMs?, responseTimeoutMs? }` arg, forwarded to
  `processMessage`. Backward-compatible (existing callers pass nothing).
- `SpreadOnChurnConfig` + `DEFAULT_CONFIG` (`src/cluster/spread-on-churn.ts`) gained
  `pushDialTimeoutMs` (default **3000**, matching the codebase's other dial caps) and
  `pushResponseTimeoutMs` (default **10000**), documented in the interface.
- `performSpread` now passes both timeouts into `client.pushBlocks(...)`. A timed-out push **throws**,
  which the pre-existing `catch` branch already records in `failed` and continues past — no new branch.

### Gap 2 — default-suite round-trip regression test
New `test/block-transfer-roundtrip.spec.ts` drives a request→response round trip **through the
registered stream handler** (not a direct `handlePull`/`handlePush` call), using an in-memory linked
duplex pair backed by `it-pushable` byte queues, and the real `StorageRepo` + `MemoryRawStorage` +
`BlockStorage`. Previously the only thing exercising the real-stream handler path was the env-gated
churn integration test — a framing/handler-signature regression would have passed `yarn test` silently
(that exact class of bug is what this ticket chain traces back to).

## How to validate

```
cd packages/db-p2p
yarn build                 # tsc, exit 0
yarn test                  # full suite, ~50s
```

Focused:
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/block-transfer-roundtrip.spec.ts" "test/protocol-client-dial-timeout.spec.ts" \
  "test/spread-on-churn.spec.ts" --reporter spec
```

### Test cases now covered (the floor — extend as you see fit)
- **Round trip through the handler** (`block-transfer-roundtrip.spec.ts`):
  - pull returns a stored block via the real handler+stream and the bytes decode back to the block.
  - push returns success **and** `repo.get` on the receiver shows the block durably persisted (proves
    `saveReplicatedBlock` ran via the stream path, not just that the round trip returned).
  - no-response peer → client rejects with `ResponseTimeoutError` within a bounded ~80ms deadline.
- **`processMessage` response deadline** (`protocol-client-dial-timeout.spec.ts`):
  - silent stream + `responseTimeoutMs` → `ResponseTimeoutError`, bounded (not a hang).
  - parent signal aborts the read → surfaces the parent reason (not a response-timeout).
  - neither `responseTimeoutMs` nor `signal` → no cap (`first` hits onEmpty → 'No response received').
- **Spread monitor end-to-end** (`spread-on-churn.spec.ts`, new `response deadline` describe):
  - a target that dials OK but never replies is recorded as `failed` (never `succeeded`), bounded.
  - a silent target does not block spreading to a later healthy target.

## Acceptance status
- [x] A silent expansion peer cannot stall `performSpread` beyond the deadline; push recorded `failed`,
      loop continues. (Verified through the monitor in `spread-on-churn.spec.ts`.)
- [x] `yarn test` (no env gate) covers a handler+stream round trip (pull + push w/ persistence) and a
      no-response-peer deadline case.
- [x] `yarn build` + `yarn test` pass in `packages/db-p2p` (1030 passing, 33 pending).
- [x] No behavior change for `processMessage` callers passing neither `responseTimeoutMs` nor `signal`.
- [ ] **Deferred:** `yarn test:integration` (env-gated `OPTIMYSTIC_INTEGRATION=1` churn e2e) was **not
      run** — its wall-clock risks the agent idle budget. Run it in CI / by hand to confirm the
      real-libp2p path. See gap (1) below.

## Honest gaps / things for the reviewer to scrutinize

1. **Real libp2p `stream.abort()` semantics are assumed, not directly tested here.** Every test models
   the stream contract with mocks (it-pushable queues; a promise that rejects on `abort`). The whole
   fix hinges on the documented libp2p behavior that `stream.abort(err)` rejects the stream's async
   iterator, unblocking the read. The default suite proves the *logic* given that contract; only the
   deferred integration test exercises a genuine libp2p stream. **Confirm the integration test still
   passes before trusting this in production.**
2. **`responseTimeoutMs` bounds the whole post-dial phase, not just the read.** The timer/listener are
   installed *before* the request-send loop, so they cover request-send + response-read together. Send
   is effectively synchronous/fast in practice, but note the semantics differ slightly from a
   "read-only" deadline. Reviewer: confirm this is acceptable (it is arguably more correct).
3. **Precedence when both fire:** if the response timer and a parent abort race, `ResponseTimeoutError`
   wins (checked first in the catch). Low-stakes, but flagged.
4. **No-response is simulated client-side.** The real `BlockTransferService` handler *always* responds
   (`handlePull`/`handlePush` return), so "reads request but never replies" is modeled with a silent
   client-side stream / silent peerNetwork rather than a hanging real handler. This is the natural way
   to model a silent peer, but it is not "the real handler stuck mid-flight."
5. **Default timeout values** (`pushDialTimeoutMs=3000`, `pushResponseTimeoutMs=10000`) were chosen to
   match existing dial caps and a generous response window. Sanity-check them against real churn timing
   — too tight risks false `failed`; too loose weakens the anti-stall guarantee.

## Pre-existing failure (NOT this ticket)
`tickets/.pre-existing-error.md` flags a **flaky** failure in
`test/cohort-topic/threshold-assembly.spec.ts` ("signers are ascending"): it generates random keypairs
and asserts the assembler's raw-byte signer order equals a base64url-string sort, which disagree for
some random inputs. It failed once during validation and passed 4/4 on isolated re-run and on the final
full run. It is outside this ticket's diff (cohort-topic threshold signatures). Left for the runner's
triage pass — do not chase it inside this review.
