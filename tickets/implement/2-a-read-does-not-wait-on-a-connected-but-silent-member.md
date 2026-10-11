description: When a node already holds a record, reading it should return that copy right away and check with the other members in the background, rather than making the read wait several seconds for a member that is connected but not answering, or for a dial that hangs on the first read after a restart (GitHub #25 and #34).
architecture: docs/transactions.md#lazy-read-repair-window
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`, `shouldReadRepair`, `floorDemandsConsult`, `fetchBlockFromCluster`, `recordAheadClaim`, `AheadClaimState`, the `now`/`rand` test seams)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy`, the `clusterPolicy` option type: new `readRepairMode` / `readRepairWindowMs` fields)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairMode` / `readRepairWindowMs` doc comments)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`; no change expected, read for context)
  - packages/db-p2p/src/storage/storage-repo.ts (`saveReplicatedBlock`, `emitPromotions`: the change events a background repair already emits; no change expected)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, coordinator-repo-unavailable.spec.ts, coordinator-repo-read-repair-trust.spec.ts, coordinator-repo-small-cohort-arming.spec.ts, coordinator-repo-solo-read-repair-window.spec.ts, coordinator-repo-commit-freshness.spec.ts, coordinator-repo-integration.spec.ts (existing specs that assert on a held block's same-read consult)
  - docs/transactions.md (§ Lazy read-repair window, the knob table), docs/internals.md (§ Quereus vtab read path, the "plus one cohort consult per block per window" paragraph), docs/debugging.md (`cluster-tx:read-repair-triggered`), packages/db-p2p/docs/cluster.md (only if a sentence there says a held block's read waits on its consult)
difficulty: hard
----

# A read of a block this node holds does not wait on the cohort consult

GitHub #25: https://github.com/gotchoices/Optimystic/issues/25 — GitHub #34: https://github.com/gotchoices/Optimystic/issues/34. Sereus ranks these second and third; #34 is the user-visible React Native cold start.

## What is wrong

`CoordinatorRepo.get` reads local storage, then for every block runs `readRepairBlock`, which awaits a cohort consult (`fetchBlockFromCluster` → `queryClusterForLatest`, one `clusterLatestCallback` per cohort peer, each deadlined by `cohortQueryTimeoutMs`) whenever:

- the block is missing locally;
- the block is held and the lazy read-repair window says check it (`shouldReadRepair`: never stamped, older than `readRepairWindowMs`, or a sample hit); or
- the read carries a floor above the held revision (`floorDemandsConsult`).

The second trigger is the one both issues hit. A peer that is connected but not answering (#25: event loop blocked) or whose dial hangs rather than being refused (#34: SYN dropped behind NAT, or a port that moved when the other node restarted) makes the consult wait its whole per-peer budget — `cohortQueryTimeoutMs`, which is `max(1000, 3 × linkRoundTripMs)` on a node that declares its link (`resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`), so about 6–7 s on the reporters' relayed links. The read then returns the rows it already held. A refused dial costs nothing, which is why "peer offline" is fast.

- #25 (two Node processes, relay only, peer blocks its loop 8 s of every 10 s): read p90 3 ms → 7003 ms while the peer stalls.
- #34 (all blocks local, re-open after restart): the freshness stamps are in memory, so every block is unstamped after a restart and every first read consults. `hydrateCatalog` → `listTables` on `tree://optimystic/schema` makes two such reads in sequence: 0.09 s with a refused dial, 14.05 s with a hanging one. On an Android emulator the catalog hydrate spent 10.5–11.4 s idle in this wait. Separately, with the other node reachable and 20 ms per storage call, the first table scan after re-open took 4.3 s (one consult per first read of each block) against 0.12 s never-paired — healthy consults also add latency on the read that triggers them.
- The reporter's experiment — serve a present block at once and repair in the background, wait only for a missing block — took both slow cases to ~0.06 s with every other case unchanged.

The ~30 s rhythm in #25 (slow reads in pairs) was not pinned to one cause. What sets the consult cadence per held block is `readRepairWindowMs` (10 s default), plus the rule that a consult with any silent peer does not arm the window, so the next read after it consults again; how that beats against a 2 s poll and an 8-of-10 s stall is incidental. After this change no read waits on that cadence, so it is documented rather than chased.

## Decision

**In `'lazy'` mode, a held block whose consult is demanded only by the window is served from the local copy immediately, and the consult runs in the background. What the consult learns — a repair (promotion or acquisition), the window's stamp, the unsettled-claim memo behind `unconfirmedAheadRev`, the `cohort-too-small` arming, deadlock reports — applies to later reads.** This is the default, not opt-in.

What still blocks, unchanged:

- **A missing block.** Its absence verdict depends on the consult (the fail-closed rules in docs/internals.md, absence table under § Consensus Execution); a silent peer may be the sole holder.
- **A held block whose read carries a floor above the held revision** (`floorDemandsConsult`). The asker has proof the local copy is too old; the consult is what lets this node answer with the floor's revision (docs/internals.md, *The asker's floor rides out on the request*). This is also what keeps writes converging: a refresh after a refused write puts the refused revision on its tail read.
- **`readRepairMode: 'paranoid'`**, which is documented as "verifies on every read (no staleness window)" for callers that cannot tolerate staleness. It keeps the blocking consult on every read.
- **`'off'`** never consults a held block, as before.

Why this keeps the documented bound rather than weakening it in a way a maintainer must re-approve:

- Inside the window a held block is already served with no consult (docs/transactions.md § Lazy read-repair window). Serving the expiring read the same way extends the bound by at most one consult's duration: the consult starts on that read, and the next read after it lands sees its result.
- When the cohort is unreachable the held copy is already served unflagged (a merely-stale block keeps its real local answer whatever the consult did). The blocking consult only ever changed the answer when the cohort was reachable *and* ahead — exactly the case the background consult repairs before the next read.
- A background repair that lands content emits a collection change: `StorageRepo.saveReplicatedBlock` (acquisition) and `emitPromotions` (read-driven promotion) both call `emitCollectionChanges`, which the Quereus vtab turns into `notifyExternalChange`. So a `Database.watch` consumer is woken when the newer content lands, without polling.
- Writes are safe: a write computed on the older copy is refused by storage at pend, and the retry's refresh carries a floor, which consults blocking.
- Honesty is unchanged: the current read is still stamped from the unsettled-claim memo as it stands (`flagUnconfirmedCurrency`). Only the consult's *effort* moves off the read path — the same split the window already makes ("the window damps repair effort, not honesty").

The one real change of meaning is after a restart: the first read of each held block used to consult before answering, and now answers from the pre-restart copy while the consult runs. On a reachable, newer cohort that copy is corrected by the next read (or a watcher wake); on an unreachable cohort it was served anyway. docs/transactions.md currently states the old behaviour ("A restart arms nothing … so after one, the first read of each block consults the cohort") as a description, not a guarantee; rewrite it. Apps that need the old behaviour choose `'paranoid'`, which this ticket makes settable on a node (below).

Considered and not done:

- **Opt-in (`latencyHint: 'interactive'` per read or per node).** A per-read hint would have to cross `NetworkTransactor`, `RepoClient` and the wire; a per-node flag would leave the default node with the 7–14 s stalls the issues report. The cases where blocking helped are covered better by floors, `'paranoid'`, and the watcher wake.
- **A short grace (wait up to N ms, then background).** Keeps the healthy-peer per-block cost #34 measured (4.3 s first scan); the reporter measured pure background at ~0.06 s.
- **A shorter budget for a peer with no live connection (#34 direction b).** After this change the only remaining blocking consults are a missing block, a floor, and `'paranoid'` — all cases where silence must be waited out before the answer can be trusted, and where a shortened budget turns an honest slow answer into a flagged one. The read-path budget also already cannot cover a cold relayed open (the `NOTE:` above `withinRequestBudget` in `clusterLatestCallback`). Not pursued.

## Design

### Background consult for a held block

In `readRepairBlock`, split the stale case:

- `floorDemands`, or mode `'paranoid'`, or the test seam below → today's blocking path, unchanged.
- otherwise, `windowDemands` on a held block → `startHeldBlockConsult(...)`, then `flagUnconfirmedCurrency(results, blockId, blockGets.context)` and return. Do not touch `results[blockId]` from the background pass: the results object belongs to the caller once `get` returns.

`startHeldBlockConsult(blockId, context, localRev, asker)`:

- **One per block.** A `Map<BlockId, Promise<void>>` of in-flight held-block consults; if one is in flight for the block, the read joins nothing and starts nothing — it is served and returns. The entry is removed in a `finally`.
- **Bounded.** At most `MAX_HELD_BLOCK_CONSULTS` (16) in flight per `CoordinatorRepo`. At the cap, start nothing and log `cluster-tx:read-repair-deferred { blockId, inFlight }`; the block stays unstamped, so a later read starts it. Rationale: a table scan after a restart reads every block once, and each consult opens one stream per cohort peer on the sync protocol; unbounded, a cold scan opens one stream per block per peer at once. 16 is a conservative bound, not a measured one; check it against libp2p's default per-protocol outbound stream limit for the sync protocol's registration while implementing, and lower it if it does not leave headroom. Put a `NOTE:` at the constant: if deferred lines show steadily under normal load, raise it or queue instead of dropping.
- **The pass.** Capture the asker statement (`askerStatementFor`) from the triggering read, then `fetchBlockFromCluster(blockId, context, localRev, undefined /* no floor */, asker)`, then `recordAheadClaim(blockId, currency, passSeq)`, then log `cluster-tx:read-repair-applied` / `-noop` from `readLocalRev(blockId)` against `localRev`, exactly as the blocking path does. The absence verdict is ignored (the block is held). Use the triggering read's `context`.
- **Errors** are caught inside the pass and logged `cluster-fetch:error { blockId, background: true, error }`; the memo stands (a thrown consult refutes nothing, as on the blocking path). The returned promise never rejects, so no unhandled rejection.
- **Lifetime.** `CoordinatorRepo` has no stop. A pass in flight at node stop runs until its deadlines expire (per-peer `cohortQueryTimeoutMs`; acquisition `reconcilePassTimeoutMs`) and fails against the closed node, logged. Put a `NOTE:` tripwire at the map: if that ever delays process exit or test teardown measurably, give `CoordinatorRepo` a stop that aborts in-flight consults.

`cluster-tx:read-repair-triggered` gains `background: true | false`.

### The unsettled-claim memo must not be weakened by an older pass

A background pass can run for a full per-peer budget, so a floored blocking pass for the same block can start after it and finish before it. If the older pass then lands a weakening verdict (`nothing-ahead`, or a lower claim) built from answers that predate the newer pass's, `recordAheadClaim` would retire a claim the newer pass just recorded, and reads would be served unflagged below it until the next consult. The same race exists today between two concurrent `get`s; long-lived background passes make it likely.

Fix it at the memo: every pass (blocking and background) takes a sequence number from a per-repo monotonic counter when it starts (in `readRepairBlock` / `startHeldBlockConsult`, before `fetchBlockFromCluster`). `AheadClaimState` records the highest sequence number that has written its `rev`/`claimants`. `recordAheadClaim(blockId, currency, passSeq)` refuses to **weaken** (the existing `weakensPrior` test) a memo written by a later-started pass, logging `cluster-fetch:stale-pass-ignored { blockId, rev, passSeq, recordedBy }`. Raising stays unconditional (it errs toward flagging, the safe direction); when it writes, it stores `max(prior seq, passSeq)`. The deadlock-reported bookkeeping is unaffected. Stamps (`markBlocksSeen`) are not gated: an older pass stamping "checked" after a newer one is harmless, and an older background pass clearing a newer pass's `floorConsulted` costs at most one extra floored consult.

### Settable on a node

`readRepairMode` and `readRepairWindowMs` are not reachable from `createLibp2pNode` today: `resolveClusterPolicy` does not carry them, so every node runs `'lazy'` at 10 s. Add `clusterPolicy.readRepairMode` and `clusterPolicy.readRepairWindowMs` to the `clusterPolicy` option type in `cluster-policy.ts` and pass them through `resolveClusterPolicy` into the returned config (which `libp2p-node-base.ts` spreads into `coordinatorRepo(...)`). Validate `readRepairWindowMs` the way `resolveCohortQueryTimeoutMs` validates its field: absent → leave undefined (the coordinator's default of 10000 applies); not a finite number above 0 or above the largest timer delay → throw at construction with a message naming the field. `readRepairMode` is typed as the union and passed through. This is what lets an app that wants the old first-read-verifies behaviour choose `'paranoid'`, and answers #25's "can an app tune the rhythm".

### Test seams

Beside `now` and `rand`, add a public field `awaitWindowConsults = false` (documented "Test seam:"): when true, a window-demanded consult takes the blocking path. Existing specs whose assertions are about what a consult *concludes* (doubt memo, deadlock arming, flags, repair outcomes, callback counts) and that read a held block once set it in their repo factory, so they keep pinning those conclusions unchanged. Do not set it in a spec whose point is timing, and never in integration specs (they cannot reach it). Add `settleHeldBlockConsults(): Promise<void>` (awaits every in-flight held-block consult, looping until the map is empty) for the new specs.

Check each spec listed in `files:` rather than flipping the seam wholesale: a spec that reads a *missing* block, or carries a floor, or runs `'paranoid'`, is unaffected and should not set it.

## Edge cases & interactions

- **Hanging or silent peer, held block (#25, #34).** `get` resolves without waiting for the consult's deadline. Test (below).
- **First read after restart.** No stamp, empty memo → served immediately and unflagged; consult in background. Covered by the same test (a fresh repo has no stamps).
- **Background result reaches the next read.** Cohort corroborates a revision ahead, acquisition succeeds → after `settleHeldBlockConsults()`, the next `get` returns the new revision and the window is armed. Test.
- **Background consult leaves an unsettled claim.** First read unflagged; after settling, the next read carries `unconfirmedAheadRev`. Test (can share a spec with the previous case).
- **Duplicate reads during an in-flight consult.** No second consult starts. Verified in the hanging-peer test by counting callback invocations.
- **Floored read while a background consult is in flight.** Runs its own blocking consult; both record through the sequence gate. By inspection.
- **Older pass weakening a newer pass's memo.** Ignored. Test: pass A (background, controllable callback held open) starts; pass B (floored, blocking) starts later and records an unsettled claim from peer X; release A with X answering "nothing ahead" → memo still stands and the next read is flagged. This pins the one piece of new branching logic.
- **Cap reached.** Nothing started, block unstamped, `read-repair-deferred` logged. By inspection.
- **Missing block, `'paranoid'`, `'off'`, sync reads (`skipClusterFetch`).** Unchanged; existing specs cover them.
- **Solo-self cohort and `cohort-too-small` arming.** Both happen inside `fetchBlockFromCluster`, so they still arm when the pass runs in the background; the only difference is the stamp lands after the read returns. Existing specs under the seam; by inspection otherwise.
- **Remote reads (`RepoService` → `CoordinatorRepo.get`).** Same behaviour; the asker statement is captured at the triggering read and used by the pass. By inspection.
- **Reactive wake.** A background repair emits a collection change via `saveReplicatedBlock` / `emitPromotions`; no new code. By inspection.
- **Writes over a stale served copy.** Refused at pend; the retry's refresh carries a tail floor → blocking consult. Existing specs.
- **A commit landing while a background consult is in flight.** The commit stamps the window; the pass stamps again when it ends; `flagUnconfirmedCurrency` drops a memo once the served revision reaches the claim. By inspection.
- **Integration specs that relied on a held, stale block converging on the same read.** They now converge one read later (or on a watcher wake). If any fail, change them to poll for convergence and list them in the handoff; do not add the seam to production wiring.
- **Node stop with consults in flight.** Bounded by deadlines; tripwire `NOTE:` at the map.

## Tests

New, in `packages/db-p2p/test/` (one spec file, e.g. `coordinator-repo-held-block-background-consult.spec.ts`, following the construction in `coordinator-repo-read-repair.spec.ts`):

1. Held block, cohort peer whose `clusterLatestCallback` never answers, `cohortQueryTimeoutMs` ~500 ms: two `get`s back to back each resolve in well under 500 ms with the local revision and no flags; the callback for that peer was invoked once.
2. Held block at rev 1, peers corroborate rev 2 and acquisition supplies it: first `get` returns rev 1; after `settleHeldBlockConsults()`, the next `get` returns rev 2. Variant where acquisition fails: the next `get` carries `unconfirmedAheadRev: 2`.
3. The sequence gate, as described under edge cases.

Plus whatever the existing specs need (seam, or an extra read after settling). Do not add tests for the config pass-through or the cap.

## Docs

- docs/transactions.md § Lazy read-repair window: the window paragraph and the worst-case staleness bound (an expiring window starts a consult and serves the held copy; the bound grows by one consult's duration); the restart sentence; the knob table (`readRepairMode` row: `'lazy'` consults a held block in the background, `'paranoid'` blocks every read; both knobs now settable via `clusterPolicy`); what sets the consult cadence (`readRepairWindowMs` per held block, and every read while a consult with a silent peer leaves the window unarmed).
- docs/internals.md § Quereus vtab read path: "plus one cohort consult per block per window" — now off the read path.
- docs/debugging.md: `background` field on `cluster-tx:read-repair-triggered`; `cluster-tx:read-repair-deferred`; `cluster-fetch:stale-pass-ignored`.
- `ClusterConsensusConfig.readRepairMode` doc comment in packages/db-core/src/cluster/structs.ts.
- Run `yarn lint:docs`.

## TODO

- Add the in-flight map, cap constant, sequence counter and `startHeldBlockConsult` to `CoordinatorRepo`; split the stale case in `readRepairBlock`; add `background` to the trigger log.
- Thread `passSeq` through both paths into `recordAheadClaim`; add the seq field to `AheadClaimState`; implement the weakening gate and its log line.
- Add the `awaitWindowConsults` and `settleHeldBlockConsults` seams.
- Plumb `clusterPolicy.readRepairMode` / `readRepairWindowMs` through `resolveClusterPolicy`, with validation.
- Write the new spec; update existing specs (seam or extra read) per spec, not wholesale.
- Update the docs listed above; `yarn lint:docs`.
- Build (`yarn build`), then `yarn workspace @optimystic/db-p2p test`, `yarn test` and `yarn test:integration` from the root (stream output, or `tee` into `tickets/.logs/`). Report any integration spec changed for one-read-later convergence in the handoff.
