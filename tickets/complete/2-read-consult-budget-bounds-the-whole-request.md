description: When a node asks its cohort peers about a block, a hidden 3-second limit used to cut every request short, whatever per-peer time limit the deployment configured, so on links with a round trip near 3 seconds the node never confirmed a block with its cohort. The configured per-peer limit is now the only limit on those requests.
files:
  - packages/db-p2p/src/rpc-deadline.ts (`withinRequestBudget`, `RequestBudgetExceededError`, `REQUEST_BUDGET_EXCEEDED_ERROR_CODE`)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer`)
  - packages/db-p2p/src/protocol-client.ts (`ProtocolClient.processMessage`: dial-phase abort throws the caller's reason; `dial:aborted` / `response:aborted` log lines)
  - packages/db-p2p/src/libp2p-key-network.ts (`Libp2pKeyPeerNetwork.connect` docblock)
  - packages/db-p2p/src/network/open-protocol-stream.ts (`OpenProtocolStreamOptions.negotiateFully` doc)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (module NOTE on `negotiateFully`)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.cohortQueryTimeoutMs` doc)
  - docs/transactions.md, docs/debugging.md, packages/db-p2p/docs/cluster.md
  - packages/db-p2p/test/protocol-client-dial-timeout.spec.ts (dial-abort test strengthened in review)
  - packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts (premise spec from the fix stage)
----
# The read-path consult's per-peer budget bounds the whole request

## What was built

`clusterPolicy.cohortQueryTimeoutMs` is the per-peer budget for the two read-path requests: the latest-revision consult (`clusterLatestCallback`) and the archive fetch (`fetchArchiveFromPeer`). Both used to call `SyncClient.requestBlock` with no options, so the sync client's 3000 ms dial and 10000 ms response defaults ran underneath the budget. Opening a stream costs one round trip even on an open connection (`@libp2p/multistream-select@7` ignores `negotiateFully: false`), so above a 3 s round trip every consult failed at 3 s whatever the configured budget (sereus measured declines exactly 3.00–3.02 s apart at budgets of 5000 and 7000).

- `withinRequestBudget(peer, protocol, budgetMs, request)` (`rpc-deadline.ts`) runs one RPC with the budget as its only limit: explicit `0` phase deadlines ("no cap") and an `AbortController` + `unref`'d timer signal that aborts with `RequestBudgetExceededError`, cleared in a `finally`. It is a self-disposing wrapper rather than the helper-plus-disposer the plan asked for, so no caller can forget the cleanup.
- Both read-path callers run under it with the one resolved `consensusConfig.cohortQueryTimeoutMs` (the same number the coordinator's `withDeadline` uses). `fetchArchiveFromPeer` lost its `Promise.race`, whose losing side kept the stream open for up to 10 s.
- `ProtocolClient.processMessage` now throws the caller's `signal.reason` when the caller aborted during the dial or negotiation, as the read phase already did, and logs `dial:aborted` / `response:aborted`. This applies to every `ProtocolClient` caller.
- The three `negotiateFully` comments say the option is currently ignored; the premise spec is the tripwire if libp2p honours it again.
- Docs say the field is the whole budget for each request, to size it for two round trips on a reused connection, and that it bounds only these two requests.

## Review findings

Read the diff of `ticket(implement): read-consult-budget-bounds-the-whole-request` first, then every file it touched and the docs that cite the field.

**Correctness — checked, no defect.**
- `0` phase deadlines: `withRpcDeadlineDefaults` keeps an explicit `0`, and `processMessage` builds no dial controller and no response timer for it, so the budget signal alone bounds both phases (the dial through `connect`'s signal, the read through `stream.abort(signal.reason)`).
- The budget is the resolved value: `consensusConfig = resolveClusterPolicy(options)`, and the coordinator factory is built from `...consensusConfig`, so `CoordinatorRepo.cohortQueryTimeoutMs` and the budget are the same number. `resolveCohortQueryTimeoutMs` rejects values that would overflow `setTimeout`, so the new timer inherits that guard.
- The three-way contract of `ClusterLatestCallback` is intact: the budget abort rejects (silence), and a `success:false` or empty archive resolves `undefined` (absent). `fetchArchiveFromPeer` still resolves `undefined` on every failure.
- Timer order: the budget timer is armed synchronously inside the callback before `withDeadline` arms its own, so it fires first; either rejection counts the peer silent. No behavioural difference.
- The `processMessage` dial-phase change reaches every client. Nothing in db-core, db-p2p or the Quereus plugin classifies errors by `AbortError` name or by libp2p's error text (grepped for `RepoClient timeout`, `AbortError`, `isAbort`), so surfacing the caller's reason changes only which error object and log line appear. `RepoClient`'s combined signal already carries its `'RepoClient timeout'` reason, which now surfaces from the dial phase too. When a `dialTimeoutMs` controller exists and the parent aborts, the controller's reason is the parent's, so it falls through to the new branch and the parent's reason still wins, consistently.
- Hermes: `abort(reason)` / `signal.reason` is the pattern `processMessage` and `RepoClient` already rely on, and libp2p requires the `throwIfAborted` polyfill (which throws the reason) anyway; no new platform requirement, and no `AbortSignal.timeout` / `AbortSignal.any`.

**Resource cleanup — checked, no defect.** The budget timer is cleared on every exit; the stream is aborted on expiry and closed in `processMessage`'s `finally`; parent-abort listeners are removed in both phases.

**Minor, fixed inline.**
- `fetchArchiveFromPeer`'s new catch comment claimed `protocol-client` had already logged "which of those it was" for every failure. It logs dial failures and budget expiry, but not an unreadable reply (`No response received`, a parse error, an oversized frame). The comment now says exactly what is and is not logged.
- The new dial-phase branch in `processMessage` had no test: the existing "forwards parent signal abort to the dial" test's fake network rejected *with the signal's reason*, so it passed before and after the change. Strengthened that test instead of adding one: the fake dial now rejects with an error of its own, which pins that the caller's reason is what surfaces. It passes; by reading, it fails against the pre-change code.

**Considered, no change.**
- If the budget expired between a successful dial and the send, `processMessage` would abort the stream before `stream.send`, which can throw a stream-state error outside the read's translation, so the caller would see that error instead of the budget reason and no `response:aborted` line. The call still rejects and the peer still counts silent; only the error text differs. A timer cannot fire between the dial's resolution and its continuation, so the window needs libp2p to complete a dial after the signal aborted. Not worth extra code.
- `withinRequestBudget` has no dedicated test: it has no branching of its own, and its two contracts (phase caps off, budget reason surfaces) rest on `withRpcDeadlineDefaults` and the `processMessage` paths pinned above. The optional `RUN_LONG_TESTS=1` end-to-end spec (1600 ms one-way link, 7000 ms budget) was not written in implement and was not written here; proof at full scale is sereus re-running their measurement.
- `RestorationCoordinator.queryPeer` still calls `requestBlock` with no options, and writes on slow links still dial under the 3000 ms default. Both belong to `declared-link-round-trip-derives-every-dial-deadline` (in implement/, with this ticket as its prereq); no new ticket.
- The consult and the archive fetch making the same request twice is already an accepted-tradeoff `NOTE:` at `fetchArchiveFromPeer`. Its revisit condition (read-repair latency on slow links needs cutting) is nearer now that budgets above 3 s take effect, but it has not tripped.

**Docs — checked.** `transactions.md`, `debugging.md`, `cluster.md`, the `structs.ts` field doc and the three `negotiateFully` comments describe the new behaviour; the `internals.md` passages that cite the field (`reconcilePassTimeoutMs`, the self-dial list) are unaffected. `yarn lint:docs` clean.

**Tripwires / tickets filed:** none.

**Validation:** `yarn workspace @optimystic/db-p2p build` clean; db-p2p `yarn test` 3134 passing, 63 pending, 0 failing; eslint clean on the touched source and spec; `yarn lint:docs` clean.
