description: Review the new in-process mesh test harness and suites that exercise push-notification reactivity (commit → fan-out → delivery, mobile resume, tail rotation, partition healing, slow subscribers) end-to-end without a real network.
prereq:
files:
  - packages/db-p2p/src/testing/reactivity-mesh-harness.ts
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts
  - packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts
  - packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts
  - docs/reactivity.md
  - docs/architecture.md
  - tickets/backlog/optimystic-network-reactive-watch-integration-test.md
difficulty: hard
----

# Review: reactivity e2e mock-transport tier

## What was built

A new in-process **mock-transport e2e tier for reactivity**, layered on the cohort-topic mesh harness
(`cohort-topic-mesh-harness.ts`) exactly as `matchmaking-mesh-harness.ts` is — *not* a fork.

- **Harness** `packages/db-p2p/src/testing/reactivity-mesh-harness.ts` (`ReactivityMesh`, `buildReactivityMesh`).
- **5 suites** `packages/db-p2p/test/reactivity/mesh-*.spec.ts` — 23 new tests (38 total in `test/reactivity/`
  including the pre-existing 15 manager/origination unit tests).

The harness drives the **real** reactivity pipeline end-to-end:

1. **Origination** — `commit()` does a real `StorageRepo.pend`+`commit`, which fires the real
   `makeCohortTopicChangeNotifier` (local-change-notifier bridge) → the real `ReactivityOriginationManager`,
   which builds the `NotificationV1` reusing a **real threshold `CommitCert`** (every tail-cohort member
   signs `utf8(commitHash + ":approve")` with its real Ed25519 key, assembled by `buildCommitCert`). No
   re-signing — the notification `sig` is the commit cert's bytes.
2. **Forwarding** — the real `createReactivityForwarder` receive path (verify → dedupe → `W`-ring + rolling
   checkpoint) over a real `PushState`.
3. **Delivery** — the real `ReactivitySubscriptionManager` (register at T3 via the real
   `CohortTopicService.register` walk, verify, contiguity, gap→backfill, dedupe, surface). Verification is
   **real Ed25519 collected-multisig** against the tail cohort's `MembershipCertV1` cached into every node's
   service verifier (same construction as `reactivity-real-crypto.spec.ts`, now over the mesh's real cohort).
4. **Recovery** — real `serveBackfill` / `serveResume` from the tail `PushState`, applied by the manager's
   real `resume()` / backfill seam.
5. **Rotation / backpressure** — real `BlockFillTracker`, `buildRotationHint`, `planReRegistrationWave`,
   `buildRotationHandoffCheckpoint`/`applyRotationHandoff`, `TailDrainGate`, and `PushState.perSubscriberQueue`.

## How to validate

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/reactivity/**/*.spec.ts" --colors   # 38 passing
yarn build    # tsc clean
```

Full mock tier: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter dot`
→ **725 passing, 17 pending, 1 failing**. The 1 failure is **pre-existing and unrelated**
(`peer-reputation-review.spec.ts`, a wall-clock time-decay race: `expected 2 to equal 1.9999992…`; passes in
isolation). It is documented in `tickets/.pre-existing-error.md` for the triage pass. No env gating; the
suites are deterministic (virtual clock).

## Scenario → claim map (every doc scenario covered or tagged)

`docs/reactivity.md` now has a **## Mock-tier e2e coverage** section with the full mapping table. Summary:

- **Cold-to-hot + delivery** (`mesh-cold-to-hot.spec.ts`): subscribers across nodes, contiguous/verified
  delivery to all, untrusted-drop (real crypto), dedupe, late-subscriber baseline, promotion-fires signal.
- **Mobile resume, 4 variants** (`mesh-mobile-resume.spec.ts`): `lag<W`→Backfill, `W≤lag<W+Wc`→CheckpointWindow,
  `lag≥W+Wc`→OutOfWindow→chain-read, stale tail→TailRotated. Scaled `W=4`/`W_checkpoint=12` for speed.
- **Tail rotation** (`mesh-tail-rotation.spec.ts`): pre-announce + jittered plan carrying `lastRevision`,
  **gap-free revision continuity across the handoff**, handoff checkpoint landed on the new tail, drain gate
  (serve renewals/replays, bounce new subs with a `Promoted`-shaped redirect, `drained` after `T_drain`),
  re-registration wave within `cap_promote_fast`.
- **Partition healing** (`mesh-partition-healing.spec.ts`): heal-via-backfill (no loss), duplicate dedupe (no
  double-delivery), forwarder sliding-dedupe drops exact retransmit, forged retransmit rejected pre-buffer.
- **Slow-subscriber** (`mesh-slow-subscriber.spec.ts`): drop-oldest + `dropped` counter + gap→backfill
  **without stalling fast subscribers**; Edge-never-forwards (T3 consumer fine, producer off).

## Known gaps / honest limitations (review these as starting points, not finish lines)

1. **Single-tier-0 reach (modeled, like matchmaking).** The cohort-topic substrate serves a single tier-0
   cohort; a multi-tier *serving* forwarder fan-out is gated on cohort-topic follow-ons. So "a tree forms /
   depth tracks subscriber count" is asserted only as **promotion fires + delivery-to-all**, with the deep
   multi-tier fan-out + quantitative depth tagged `[unimplemented:mock-tier]` in `mesh-cold-to-hot.spec.ts`.
   Worth a reviewer's eye: is the promotion-fires assertion (`capPromote: 4` + T3 admission) meaningful
   enough, or should it drive a real `Promoted` walk outcome?
2. **Notification transport is modeled.** The harness fans out in-process via the real per-subscriber bounded
   queues; it does **not** dial primaries/child cohorts over a protocol. Real-network fidelity is
   `substrate-e2e-real-libp2p-tier`'s job. Origination is installed on the node nearest the *initial* coord_0
   and stays there across rotation (the "new tail primary" is modeled, not re-routed).
3. **`serveResume` does not read `inheritedCheckpoint`.** The rotation handoff lands on
   `PushState.inheritedCheckpoint` (asserted in `mesh-tail-rotation.spec.ts`), but the real `serveResume`
   classifier reads only the rolling `checkpoint` — so a checkpoint-window resume whose span *crosses a
   rotation* is **not** served from the inherited checkpoint. This is a genuine seam gap in the **production**
   code (`packages/db-core/src/reactivity/resume.ts`), not just the harness; `rotation.ts`'s docstring claims
   the resume classifier reads `inheritedCheckpoint` but it does not yet. Candidate for a follow-up fix ticket.
4. **Slow-subscriber backfill is async/fire-and-forget.** The manager's `requestBackfill` seam is
   `void`-dispatched, so draining a deep dropped queue can interleave several backfill RPCs. The test asserts
   the **converged set** (`{1..20}`, no loss/no dup) after a small settle `delay(50)`, not an exact backfill
   count/order. This reflects the manager's real behavior; a reviewer may want a tighter invariant.
5. **At-scale magnitudes are the simulator's.** `W=256`/`W_checkpoint=4096`/`16×`/rotation-burst=32 are
   validated quantitatively by `packages/substrate-simulator`; the mesh suites use scaled-down values and
   assert the *classifier/boundary behavior*, not the production magnitudes. Production config is imported
   from `config.ts` (no hard-coded drifting numbers in the harness).
6. **Cohort crash-failover** (§Failure — cohort fully fails / mid-notification) is the cohort-topic layer's
   recovery (`cohort-topic-scale-lifecycle.spec.ts`); tagged `[unimplemented:mock-tier]`. Reactivity's
   no-loss-on-failover is exercised indirectly via the partition-heal backfill.
7. **Edge node may sit in a tail cohort.** The harness doesn't exclude an Edge node from FRET cohort
   assembly; the Edge-never-forwards test asserts the **policy** (`mayServeAsReactivityForwarder`) + delivery,
   not cohort-membership exclusion (that's the willingness layer's, cohort-topic-tested).

## Docs / supersession

- `docs/architecture.md` Doc Sync Status: **reactivity Mock-tier e2e → done** (real-libp2p still pending); the
  prose paragraph + table row updated.
- `docs/reactivity.md`: new **## Mock-tier e2e coverage** section (claim-map table + the
  windows-are-the-simulator's note).
- `tickets/backlog/optimystic-network-reactive-watch-integration-test.md`: annotated **superseded in part** —
  the reactivity-surface intent is now covered; the residual **real-libp2p socket + Quereus `Database.watch`**
  wakeup belongs to `substrate-e2e-real-libp2p-tier` and was **not** duplicated here.

## Suggested review focus

- The real-crypto seam in the harness (`buildTailCert` + `cacheTailCert`): does the membership-cert/signer
  encoding round-trip match production (`peerIdToBytes` ↔ `bytesToB64url`) for *all* cases, or only the
  all-members-sign path the harness uses? (A below-`minSigs`/subset-signers mesh case is **not** covered here;
  it is in `reactivity-real-crypto.spec.ts`.)
- Gap #3 (`serveResume` not reading `inheritedCheckpoint`) — decide whether to file a fix ticket.
- Whether the modeled fan-out (#2) understates anything the reviewer would want a real-transport assertion for.

