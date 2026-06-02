description: Mesh-harness suites for the reactivity push-tree — cold-to-hot subscription growth, mobile resume windows (backfill/checkpoint/chain-read), tail-rotation continuity, partition healing, and slow-subscriber isolation — over the fast deterministic mock mesh.
prereq: reactivity-backfill-resume-checkpoints, reactivity-rotation-backpressure-policy, cohort-topic-e2e-mock-tier
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-p2p/test/reactivity-*.spec.ts (new)
  - docs/reactivity.md
  - docs/architecture.md
effort: high
----

# E2E mock-transport suite for reactivity

## Purpose

The **mock-transport e2e tier** for reactivity. It drives the real reactivity hot path (notification origination reusing the commit certificate, replay buffer, dedupe, fan-out) plus recovery (`reactivity-backfill-resume-checkpoints`) and rotation/backpressure (`reactivity-rotation-backpressure-policy`) over many logical nodes on the in-process mock mesh. Real-network fidelity is the `substrate-e2e-real-libp2p-tier` ticket's job; quantitative coverage-window math (W vs W_checkpoint, rotation-burst bounds) is the simulator's (`simulator-reactivity-replay`, folded into `docs/reactivity.md`).

This ticket **supersedes the intent** of the existing `backlog/optimystic-network-reactive-watch-integration-test` ticket — that stub asked for a single networked reactive-watch integration test; the suites here generalize it to the full reactivity surface at scale. Reference it; do not duplicate it.

## Test infrastructure

Build directly on the cohort-topic harness extensions from `cohort-topic-e2e-mock-tier` (do not fork the harness). Add reactivity-specific helpers:

```ts
// Additions layered on the cohort-topic mesh harness (sketch)
interface ReactivityMeshHarness extends CohortTopicMeshHarness {
	subscribe(node: number, collectionId: Uint8Array, opts?: {
		lastKnownRev?: number;          // resume / cold-start
		tailIdAtAttach?: Uint8Array;
		deltaMaxBytes?: number;
	}): Promise<SubscriptionHandle>;
	commit(collectionId: Uint8Array, count?: number): Promise<number>; // advances revision via local change-notifier bridge
	rotateTail(collectionId: Uint8Array): Promise<void>;               // fill block_fill_size -> new tailId
	sleepSubscriber(h: SubscriptionHandle, lagRevisions: number): void;// model mobile wake at a given lag
	injectJitter(h: SubscriptionHandle, ms: number): void;             // slow-subscriber modeling
	delivered(h: SubscriptionHandle): NotificationV1[];                // contiguous, deduped, verified
}
```

Commits flow through the **existing local change-notifier bridge** (`local-change-notifier-bridge`: `StorageRepo.onCollectionChange` → `CohortTopicService` → reactivity origination) so notifications originate exactly as in production. The virtual clock from the cohort-topic harness drives `T_drain`, `T_rejoin_jitter`, and TTL renewal.

## Scenario → claim mapping

Each suite maps to a §Worked scenario or §Failure mode in `docs/reactivity.md`; unimplemented doc expectations are tagged in the test name and noted in the doc.

- **Cold-to-hot subscription growth** (§Worked scenarios — cold collection becomes popular): a cold collection gains subscribers across nodes → cohort-topic promotes → assert a tree forms, notifications deliver to every subscriber contiguous and verified against `MembershipCertV1`, and depth tracks subscriber count per the simulator-validated regime.
- **Mobile resume windows** (§Resume, §Failure modes — subscriber wakes after long sleep):
  - lag `< W` → exactly one `BackfillV1` resolves the gap;
  - `W < lag < W_checkpoint` → one `CheckpointWindow` resume from a parent checkpoint;
  - lag `> W_checkpoint` → `OutOfWindow` → chain read;
  - stale `latestKnownTailId` → `TailRotated`.
- **Tail-rotation continuity** (§Tail rotation): rotate the tail during steady commit load → old tail drains for `T_drain` (accepts renewals/replays, bounces new subscriptions with `Promoted`), subscribers re-register jittered over `T_rejoin_jitter` staying within `cap_promote_fast` inside `T_drain`, and the delivered revision stream is **continuous with no gap** across the handoff (buffer folded into final checkpoint, handed to new tail).
- **Partition healing** (§Failure modes — fan-out interrupted; §Interaction — partition healing): partition a forwarder cohort, continue committing, heal → assert the sliding dedupe window + per-subscriber queue replay merges cleanly, `cohortEpoch` refreshes, bracketing-sig re-verification passes, and **no notification is lost or double-delivered**. Cross-check against `docs/partition-healing.md` two-tier rule model.
- **Slow-subscriber isolation** (§Slow-subscriber backpressure): one subscriber with injected jitter fills its bounded queue (`queue_max`) to drop-oldest, increments its dropped counter, then detects the gap on next delivery and backfills — **without stalling** fast subscribers in the same fan-out. Edge-profile subscriber never serves as a forwarder (T3 producer willingness off).

## Parameter sourcing

`W`, `W_checkpoint`, `dedupe_window`, `queue_max`, `delta_max`, `T_drain`, `warm_threshold`, `block_fill_size`, and the rotation-burst / coverage-window bounds come from the simulator-validated values recorded in `docs/reactivity.md` §Configuration by `fold-simulator-findings-into-design-docs`. Import production config; do not hard-code drifting numbers.

## TODO

### Phase 1 — harness extension
- Layer reactivity helpers (subscribe/commit/rotateTail/sleep/jitter/delivered) onto the cohort-topic mesh harness; route commits through the local change-notifier bridge.

### Phase 2 — hot-path + recovery suites
- Cold-to-hot growth + delivery verification; mobile resume across all four variants (backfill/checkpoint/out-of-window/tail-rotated).

### Phase 3 — rotation, partition, backpressure suites
- Tail-rotation drain + jittered re-registration + revision continuity; partition heal with dedupe/queue replay convergence; slow-subscriber drop-without-stall + Edge-never-forwards.

### Phase 4 — claim mapping + doc sync
- Map every §Worked scenario / §Failure mode in `docs/reactivity.md` to a named test; tag unimplemented expectations.
- Reference (and note supersession of) `backlog/optimystic-network-reactive-watch-integration-test`.
- Update `docs/architecture.md` Doc Sync Status: reactivity → mock-tier e2e **done** (real-libp2p e2e pending).

## Done when
- `yarn test` in `packages/db-p2p` is green (mock tier, no env gating, deterministic).
- `yarn build` passes for `db-p2p`.
- Every reactivity §Worked scenario / §Failure mode maps to a named or tagged-unimplemented test.
- `docs/architecture.md` Doc Sync Status reflects reactivity mock-tier e2e complete; the superseded backlog stub is referenced.
