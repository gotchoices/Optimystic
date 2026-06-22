description: Wired the existing "give up if no reply" deadline into the cluster, sync, dispute, and transaction request paths so a silent peer can no longer freeze them forever, and fixed a stream leak in the transaction client. Reviewed and accepted.
prereq:
files: packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/test/rpc-response-deadline.spec.ts, packages/db-p2p/src/protocol-client.ts
----

# Complete: response deadline for the remaining ProtocolClient callers

## What was built (carried over from implement)

`ProtocolClient.processMessage` already supported `dialTimeoutMs` / `responseTimeoutMs` / parent
`signal` and actively `stream.abort(...)`s the response read on expiry; only the block-transfer path
used it. This work wired the same primitive into the four remaining subclasses and fixed a
stream-leak in the repo client. No wire-protocol or server-handler changes.

- **`src/rpc-deadline.ts`** — new shared module: `RpcDeadlineOptions`, `DEFAULT_DIAL_TIMEOUT_MS = 3000`,
  `DEFAULT_RESPONSE_TIMEOUT_MS = 10000` (lifted from `spread-on-churn.ts`), and
  `withRpcDeadlineDefaults()` merging with `??` so an explicit value (incl. `0` = "no cap") wins.
- **cluster / sync / dispute** — `update` / `requestBlock` / `sendResolution` now forward
  `withRpcDeadlineDefaults(options)`; `sendChallenge` keeps its `timeoutMs`→`AbortSignal.timeout`
  contract and adds the default dial cap. Cluster redirect threads the caller's original options.
- **`repo/client.ts`** — replaced the leaky `Promise.race([processMessage(), setTimeout(reject)])`
  (whose losing branch left the inner read running) with an `AbortController` whose abort reason is
  `new Error('RepoClient timeout')`, combined with the caller signal via `AbortSignal.any`. The
  deadline now genuinely cancels the inner read; timer cleared in `finally`.

## Review findings

### Process
- Read the implement diff (`9e58b9b`) with fresh eyes, then all five changed source files in full
  plus `protocol-client.ts` (the unchanged primitive these callers depend on) and the production
  callers of each changed method.
- Build / type-check (the repo has no ESLint config or lint script — `tsc` is the lint gate):
  `yarn workspace @optimystic/db-p2p build` → **exit 0**.
- Targeted + related specs (`rpc-response-deadline`, `cluster-error-propagation`,
  `cluster-service-redirect`, `coordinator-cache-hint`, `dispute`) → **64 passing**.
- Full suite `test/**/*.spec.ts` → **1039 passing, 33 pending, exit 0**. The
  `cohort-topic cold-start: parent registration ... Error: parent unreachable` console line is an
  expected error-path log from a *passing* test (confirmed pre-existing, unrelated to this diff).

### What was checked, by aspect
- **Resource cleanup / the leak fix (most scrutiny).** Confirmed `processMessage` forwards `signal`
  to both dial and response read and `stream.abort(signal.reason)`s on abort, so the combined signal
  genuinely tears the read down. Verified the abort *reason* (`new Error('RepoClient timeout')`)
  propagates through `AbortSignal.any` so the caller still observes `.message === 'RepoClient
  timeout'`. Timer cleared in `finally`; `processMessage` removes its own listeners in its `finally`.
  The leak-fix test asserts `aborted() === true`, which is the decisive proof the read is cancelled,
  not leaked. **No leak.**
- **`AbortSignal.any` lifecycle.** Confirmed no listener accumulation on a long-lived caller signal
  reused across many RepoClient calls: Node's composite-signal implementation holds dependents via
  weak references (Node ≥18.17/20.3, satisfied by `@types/node` ^25). Each redirect hop builds a fresh
  controller and clears its timer before recursing. No retained references.
- **Error handling / identity.** Cluster/sync/dispute silent-peer path surfaces `ResponseTimeoutError`
  (`code === RESPONSE_TIMEOUT`); repo surfaces `Error('RepoClient timeout')`. Both verified by tests
  and by reading the catch ladder in `processMessage` (responseTimeoutError → signal.reason → raw).
- **DRY / SPP / modularity.** The shared `rpc-deadline.ts` removes per-client duplication; defaults
  are sourced from the codebase's reference convention (`spread-on-churn`). Clean.
- **Type safety.** New params are optional; `ICluster.update`'s interface (already tolerant of the
  pre-existing `hop` param) stays satisfied; `withRpcDeadlineDefaults` output is assignable to
  `processMessage`'s options. `tsc` clean.
- **Behavior change — new 10s response / 3s dial defaults on cluster/sync/dispute (the headline
  risk).** Audited every production caller:
  - Cluster `update`: `cluster-coordinator.ts` (`collectPromises`) and `cluster-repo.ts`
    (`propagateIfNeeded`) issue one single-round-trip `update` per member; 10s is a generous safety
    cap, not a consensus-wide budget. Byzantine/consensus/divergence specs pass unchanged.
  - Sync `requestBlock`: `libp2p-node-base.ts:537` already wraps it in a 1s `Promise.race`, and
    `clusterLatestCallback` / `restoration-coordinator-v2.queryPeer` swallow errors and fall back to
    the next peer — so the 10s cap is a strict upper bound that only helps; no large-block path
    relies on an unbounded wait. Acceptable; overridable via `responseTimeoutMs` if a slow link ever
    needs more.
  - Dispute `sendResolution`: broadcast/ack; the sole caller (`dispute-service.ts:520`) is
    fire-and-forget under `Promise.allSettled`. Fine.
- **Docs.** Grepped `docs/**` and package READMEs — no documentation describes these client timeout
  behaviors, so nothing is left stale by the new defaults.

### Findings & disposition
- **Major:** none. No new tickets filed.
- **Minor (fixed inline):** none required — the implementation is correct as written.
- **Noted residuals (no action, no current impact):**
  1. `sendChallenge` without a `timeoutMs` caps the dial (3s) but leaves the *response* uncapped — an
     intentional preservation of its existing contract. The only caller (`dispute-service.ts`, via
     `disputeArbitrationTimeoutMs`) always passes a `timeoutMs`, so no current path can hang. Left
     as-is by design; flagged here so a future no-`timeoutMs` caller is a conscious choice.
  2. Repo dial-phase abort identity (when `dialTimeoutMs` is also set) may surface a generic abort
     rather than `'RepoClient timeout'` — documented as acceptable; tests cover the deterministic
     response-phase case.
  3. Happy-path tests use canned-responder streams rather than a real registered server handler
     (cluster/sync/dispute have no in-memory handler harness). They exercise encode→decode + the
     deadline machinery; a fidelity gap, not a correctness gap.

### Verdict
Accepted. The leak fix is correct and proven by test; the deadline wiring is sound; the behavioral
change is the ticket's express purpose and is bounded by callers. Build and full test suite green.
