description: When a node already holds a record, reading it now returns that copy right away and checks with the other members in the background, instead of making the read wait several seconds for a member that is connected but not answering, or for a dial that hangs on the first read after a restart (GitHub #25 and #34). Implemented and reviewed.
architecture: docs/transactions.md#lazy-read-repair-window
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `logRepairTriggered`, `settleHeldBlockConsults`, `nextPassSeq`, `recordAheadClaim`, `AheadClaimState.writtenBy`, `MAX_HELD_BLOCK_CONSULTS`, `awaitWindowConsults`)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`clusterPolicy.readRepairMode`, `clusterPolicy.readRepairWindowMs`, `resolveReadRepairWindowMs`, `MAX_READ_REPAIR_WINDOW_MS`)
  - packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairMode` / `readRepairWindowMs` doc comments)
  - packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts, coordinator-repo-read-repair.spec.ts, coordinator-repo-unavailable.spec.ts, coordinator-repo-small-cohort-arming.spec.ts, coordinator-repo-commit-freshness.spec.ts
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-p2p/test/two-phones-over-relay.integration.spec.ts, packages/db-p2p/test/util/two-machine-lifecycle.ts
  - docs/transactions.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/cluster.md, packages/quereus-plugin-optimystic/README.md
difficulty: hard
----

# Complete: a read of a block this node holds does not wait on the cohort consult

GitHub #25: https://github.com/gotchoices/Optimystic/issues/25 — GitHub #34: https://github.com/gotchoices/Optimystic/issues/34. Implemented in `ticket(implement): a-read-does-not-wait-on-a-connected-but-silent-member`; this ticket records the review pass.

## What landed

In the default `lazy` read-repair mode, a read of a block this node holds whose consult only the window asked for is served from the local copy at once, and the consult runs behind it (`startHeldBlockConsult` in `packages/db-p2p/src/repo/coordinator-repo.ts`). What the consult learns (a repair, the window's stamp, the `unconfirmedAheadRev` doubt memo, arming, a deadlock report) reaches the next read of the block. A missing block, a held block whose read carries a floor above it, and every consult under `'paranoid'` still block the read, as before. One pass per block at a time, at most 16 passes per node (`MAX_HELD_BLOCK_CONSULTS`); past the cap the read is served, nothing starts, and `cluster-tx:read-repair-deferred` is logged. Every pass takes a sequence number, and a pass that started before the one that wrote a block's doubt memo may not weaken it (`cluster-fetch:stale-pass-ignored`). `readRepairMode` and `readRepairWindowMs` are settable on a node through `clusterPolicy`, the window validated at construction. The worst-case staleness bound is now one window plus one consult; docs/transactions.md § Lazy read-repair window states it, with the first-read-after-restart consequence and the `'paranoid'` escape.

## Review findings

**Read first:** the implement commit's full diff (source, tests, docs), before the handoff summary.

**Checked, and found sound:**

- The three blocking cases are gated exactly as documented: `background` requires `isStale`, no floor demand, mode `'lazy'` and the seam off; a missing block never reaches it because both demand flags are false for one.
- The background pass stamps, records the memo, arms and reports through the same `fetchBlockFromCluster` the blocking path uses, so no exit was duplicated. The pass never rejects; `settleHeldBlockConsults` cannot spin, because the stored promise is the one whose `finally` removed the entry.
- The sequence gate sits ahead of the silent-claimants check and only on the weakening branch; raising stays ungated and a same-revision join keeps the newer sequence. Traced the four orderings of an older background pass A and a newer floored pass B by hand (A then B recording, B then A refuting, A refuting after B retired, both unsettled); only "A lands an unsettled claim after B retired the memo" leaves a stale doubt, and only until the next consult that reaches the claimants, so it is flagging-direction. Parked as a `NOTE:` at the retirement branch of `recordAheadClaim`.
- The consult cap's rationale was verified: `clusterLatestCallback` in `packages/db-p2p/src/libp2p-node-base.ts` opens one `SyncClient` stream per peer on the sync protocol, which `SyncService` registers with libp2p's default stream limits, so the arithmetic in the constant's doc is right. The number itself is reasoned, not measured, and the `NOTE:` there says so.
- `ResolvedClusterPolicy` is `ClusterConsensusConfig & {...}`, so the two pass-through fields are typed without a declaration change, and the `consensusConfig` spread into `CoordinatorRepo` carries them. The window ceiling and its reason differ from `resolveSlotHoldWindowMs` (no ceiling, clock-compared); both doc comments state their own reason and the ticket asked for the ceiling, so left as is.
- The integration helper `expectReadableEventually` keeps `expectReadable`'s meaning and shares its row comparison; the relay spec's phase 3 change matches the design (B's first read after its restart is served from its pre-restart copy, and the data blocks the refreshed log names are floored and so consult blocking). The mesh spec uses the deterministic settle seam rather than polling.
- Docs: `docs/transactions.md`, `docs/internals.md`, `docs/debugging.md`, the db-core config doc comments and the plugin README were read against the code and agree. The "stop within about one read-repair window" sentence in the below-floor section of `docs/debugging.md` was already loose before this change (a floored read consults at once) and is left alone.

**Found and fixed in this pass (minor):**

- **The trigger line over-counted consults.** `cluster-tx:read-repair-triggered` was logged before `startHeldBlockConsult` deduplicated or deferred, so in background mode every read that landed while a block's pass was still running logged a trigger for a consult that never started. `docs/debugging.md` reads that line as one per consult (the GitHub #8 count depends on it). Extracted `logRepairTriggered`; the background branch now logs it only when a pass actually starts (`startHeldBlockConsult` returns whether it did), the blocking branch is unchanged. The debugging entry's `background` bullet says a read that finds a pass in flight or the cap reached emits no line.
- **That over-count had been hiding a spec gap.** *leaves the empty-cohort exit unarmed: every read re-triggers* in `coordinator-repo-solo-read-repair-window.spec.ts` builds its repo inline, missed the `awaitWindowConsults` seam its sibling factory sets, and passed only because each of its nine reads logged a trigger whether or not a consult started; with the line corrected it counted five. Set the seam there with a comment; the spec's claim (the exit does not arm, so every read that finds no pass in flight starts one) holds in background mode too.
- **The background pass dropped the read's floor and context.** A floor the read carried but that did not demand the consult (met by the local copy, or already consulted under) was not recorded with the stamp, so the next floored read consulted once more than the blocking path would have; and the pass's read-back ran without the triggering read's context where the blocking path's refreshed read has it. Both are now passed through; neither changes what the pass decides.
- **Timing margin in the new spec.** The silent-peer test asserted two reads finished under 400 ms against a 500 ms budget. Widened to under 1 000 ms against 2 000 ms so a slow machine cannot blur a blocked read from a served one. Costs 1.5 s of settle time in one test.
- **Knob listing.** The `ClusterConsensusConfig` listing in `packages/db-p2p/docs/cluster.md` gained the two read-repair knobs now that they are node-settable.

**Tests:** the implementer's four new tests each pin a contract (latency and dedup, repair served one read later and arming, unsettled claim flagging the next read, the sequence gate) and none restate the implementation or verify a mock; all kept, none added. The seam changes to existing specs were checked one by one and each is on a spec that asserts what a consult concluded.

**Tripwires recorded (not tickets):** the `NOTE:` at the retirement branch of `recordAheadClaim` (an older pass re-recording a retired doubt); the `NOTE:` at `heldBlockConsults` (no stop; a pass in flight at shutdown runs out its deadlines) and at `MAX_HELD_BLOCK_CONSULTS` (raise or queue if `read-repair-deferred` shows steadily), both from the implement pass and confirmed as genuinely conditional.

**Major findings:** none. Nothing here needed a ticket: no finding serves an anchor beyond this one, and no class-level invariant emerged. **Considered and declined:** none; no finding landed at a site carrying an accepted-tradeoff note.

**Validation (after the review edits):** `yarn lint`, `yarn lint:docs`, `yarn build` clean. Full `@optimystic/db-p2p` suite: 3280 passing, 70 pending, 1 failing (the solo-window spec above; fixed, then the read-repair spec family of 7 files re-run: 112 passing). `two-phones-over-relay.integration.spec.ts` under `OPTIMYSTIC_INTEGRATION=1`: 5 passing. `coordinator-repo-integration.spec.ts` is in the unit suite and passed there. Not re-run: the other workspaces' suites and the rest of the integration suite, which no file in this pass touches (the implementer ran both green).
