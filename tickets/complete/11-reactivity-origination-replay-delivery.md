description: Reactivity hot path — wire codecs, tail-anchored topic, notification origination (commit-cert reuse), W=256 replay ring + sliding dedupe, forwarder receive path, subscriber verify/deliver with gap→backfill seam, and db-p2p substrate wiring. Reviewed and completed.
files: packages/db-core/src/reactivity/*, packages/db-p2p/src/reactivity/*, packages/db-core/test/reactivity/*, packages/db-p2p/test/reactivity/managers.spec.ts, docs/reactivity.md
----

# Reactivity core — subscription, origination, replay buffer, dedupe, delivery (complete)

The reactivity hot path on the cohort-topic substrate: pure db-core logic (config, topic anchor, wire
codecs, origination assembler, sliding dedupe window, `W`-entry replay ring, `PushState` + gossip
codec, notification verifier, forwarder receive path, subscriber delivery) plus db-p2p substrate wiring
(subscription manager at T3, origination manager on `onLocalCommit`). Network transport for fan-out is
an intentional seam (see Review findings — filed as a follow-up).

## Outcome

- `yarn build` + `yarn test` green: **db-core 663 passing**, **db-p2p 605 passing / 9 pending** (after
  review fixes; was 662 / 603 at implement handoff — review added 3 tests).
- Behavior matches `docs/reactivity.md` §Anchor / §Subscription / §Notification origination /
  §Propagation / §Replay window / §Per-revision dedupe / §Delivery / §Wire formats; the "Implemented"
  doc callouts added by the implementer were confirmed accurate, including the honest flagging of the
  `digest`↔signed-commit-hash seam.

## Review findings

Adversarial pass over the implement diff (`50978a9`) read first with fresh eyes, then against the
handoff. Scrutinized for SPP/DRY/modularity, scalability, resource cleanup, error handling, type safety,
and test coverage (happy path, edges, error paths, regressions, interactions). Docs re-read against the
touched code.

### Minor — fixed inline (this pass)

1. **Subscription manager ignored `profile` for the delta budget (contract bug).**
   `ReactivitySubscriptionManager` documented `deltaMaxBytes` as "defaults to `0` on Edge, `delta_max`
   on Core via `profile`", and the codebase ships `deltaMaxForProfile` for exactly this — but the
   constructor unconditionally defaulted to `0` (`DEFAULT_EDGE_SAFE_DELTA_MAX`), so a Core subscriber
   relying on its profile would silently **decline all deltas** and always fall back to fetching,
   defeating the delta optimization. The existing test only asserted the Edge case (`0`), so the bug
   was invisible. *Fixed*: derive from `deltaMaxForProfile(profile)` when no explicit `deltaMaxBytes`
   is given, mirroring the existing `subscriberTtlForProfile` precedence. Added two tests
   (`managers.spec.ts`): Core profile → `DELTA_MAX_CORE_BYTES`, and explicit value overrides the
   profile-derived budget.

2. **`ReplayBuffer.range(from, to)` looped over every integer in `[from, to]` (unbounded-input DoS).**
   The backfill ticket (`reactivity-backfill-resume-checkpoints`) feeds this a **subscriber-supplied**
   `BackfillV1` range; a malicious/buggy subscriber sending `from=0, to=2^53` would spin the forwarder
   in a per-integer `Map.get` loop. The retained set is always ≤ `capacity`. *Fixed*: compute the
   intersection by filtering the (≤ `W`) retained entries instead of scanning the range — strictly
   better for wide ranges, identical results. Added a test asserting `range(0, MAX_SAFE_INTEGER)`
   returns just the window.

3. **Duplicate import in `verify.ts`** (`createTierAddressing` and `DEFAULT_FANOUT` imported in two
   separate statements from the same module). *Fixed*: merged into one import. Cosmetic.

### Major — filed as new tickets (not fixed here)

4. **`digest` ↔ signed-commit-hash alignment** → `plan/12.1-reactivity-digest-commit-hash-alignment`.
   Origination sets `NotificationV1.digest = b64url(utf8(actionId))`, but the reused threshold sig is
   over the transaction layer's **commit hash**. For a subscriber's *cryptographic* threshold-verify
   over `digest` to succeed against real Ed25519 these byte images must match; today they need not, so
   every crypto-path test uses a fake/pass-crypto verifier. Confirmed this is unowned by any sibling
   ticket (the backfill ticket only discusses the `mergedDigest` fold, not this preimage alignment).
   The mock-tier e2e does not depend on it; the real-libp2p tier does.

5. **No live notification transport + PushState gossip not on the bus** →
   `plan/12.3-reactivity-notification-transport`. The origination `emit` callback, the forwarder
   `"forward"` decision, and `PushState.serializeGossip`/`mergeGossip` are all in-process seams: no
   libp2p application protocol delivers `NotificationV1` frames to subscriber primaries / child
   cohorts, and nothing drives the replay/dedupe gossip over `CohortGossipBus`. So "any cohort member
   serves a replay" is proven in-process only. Confirmed unowned: `cohort-topic-host-node-wiring`
   (plan) makes origination *live* (bridge → `onLocalCommit`) but does not build the fan-out protocol;
   the e2e mock tier stands in a mock mesh. (Combines the implementer's gaps #2 and #3.)

### Checked — no action needed (with reasons)

- **Origination fidelity.** `buildNotificationV1` copies `commitCert.thresholdSig` and `signers`
  through unchanged (crypto-free assembler); delta-budget edges are correct — `<=` includes
  exactly-at-budget, over-budget and budget-`0` omit `delta`. Verified by reading + `notification.spec`.
- **Dedupe semantics.** Sliding `(revision, sigDigest)` set: exact repeat dropped, same-revision distinct
  sig admitted (partition-merge recovery), eviction bound `[highest - windowSize + 1, highest]` correct,
  merge idempotent/commutative within the window. The `(collectionId, revision)` subscriber-side dedupe
  is the documented backstop for window re-admission. Covered by `dedupe-replay.spec`.
- **Replay ring.** Revision-keyed (out-of-order retransmits land correctly), lowest-revision overflow
  eviction, `merge` per-revision tie broken by freshest `receivedAt`, idempotent. Covered.
- **Subscriber contiguity.** Fresh-subscribe baseline adoption vs. `lastKnownRev > 0` gap detection;
  gapped notification withheld until backfill re-feeds ascending; foreign-collection drop; one
  fetch-and-retry against the **real** `MembershipVerifier` (pass-crypto stub). Covered by
  `subscriber.spec`. Repeated-gap re-requests (each higher revision re-requests `[last+1, rev]`) are
  benign per the hint-only contract; left as-is.
- **Encoding loop.** Origination `encodeSigner` (`s ⇒ bytesToB64url(peerIdToBytes(s))`) is the exact
  inverse of the verifier's `b64urlToBytes` default; pinned by `managers.spec`.
- **`onLocalCommit` ownership.** The change-bridge is the *producer* (calls the hook); the origination
  manager is the *consumer* (sets it). Complementary, not conflicting. Both wrap the call in
  try/catch so origination can never break a commit. Single-consumer limitation (matchmaking would
  also want the hook) is future work, not this ticket.
- **Gap #5 (subscriber does not buffer across a gap).** By design (hint-only); the backfill ticket
  re-feeds the range through `onNotification` ("applies the merged digest, then replays the recent
  entries"). Dependency holds.
- **Docs.** `docs/reactivity.md` "Implemented" callouts for §Notification origination, §Delivery, and
  §Wire formats accurately describe the shipped code and honestly flag the digest seam. No drift.

## Sibling / follow-on tickets

- `implement/11.5-reactivity-backfill-resume-checkpoints` — consumes `requestBackfill`, `replayBuffer`,
  `parentCheckpoint`.
- `implement/11.5-reactivity-rotation-backpressure-policy` — tail rotation, `perSubscriberQueue`.
- `implement/13-reactivity-e2e-mock-tier` — drives the hot path over a mock mesh.
- `plan/12.1-reactivity-digest-commit-hash-alignment` — review finding #4.
- `plan/12.3-reactivity-notification-transport` — review finding #5.
- `plan/13.5-cohort-topic-host-node-wiring` — makes origination live in the production node.
