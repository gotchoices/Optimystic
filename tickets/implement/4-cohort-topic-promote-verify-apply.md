description: Make the host's promote-protocol handler verify a threshold-signed PromotionNoticeV1/DemotionNoticeV1 and apply it to local cohort state (gap 4), and add the db-core remote-apply path the promotion lifecycle currently lacks. Also broadcast notices a CoordEngine signs locally.
prereq: cohort-topic-threshold-assembly
files:
  - packages/db-p2p/src/cohort-topic/host.ts (promote handler: decode → verify → apply; broadcast on local sign)
  - packages/db-core/src/cohort-topic/promotion.ts (NEW applyPromotionNotice / applyDemotionNotice)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (verifyMessage — reused to verify notices)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (promotionNoticeSigningPayload / demotionNoticeSigningPayload)
  - packages/db-core/src/cohort-topic/wire/codec.ts (decodePromotionNoticeV1 / decodeDemotionNoticeV1)
  - packages/db-p2p/src/cohort-topic/protocols.ts (PROTOCOL_COHORT_PROMOTE)
----

# Cohort-topic: promote verify-and-apply

The `promote` protocol handler currently decodes nothing and replies `undefined`. With the real
threshold signature (prereq) in place, an inbound notice can be verified and applied. Two halves:

1. **Outbound:** when a `CoordEngine`'s `PromotionLifecycle.onParticipantCountChange` / `maybeDemote`
   returns a freshly threshold-signed `PromotionNoticeV1` / `DemotionNoticeV1` (currently the host
   drops it on the floor — `void this.deps.promotion...`), the host must broadcast it over the
   `promote` protocol to the cohort (and, for a demotion, to the parent cohort coord).
2. **Inbound:** the `promote` handler decodes the notice, verifies it via the participant-side
   `MembershipVerifier` (signers ⊆ the cohort's `MembershipCertV1` for the notice's
   coord/tier/epoch, `≥ minSigs`, signature valid), and **applies** it to the local `CoordEngine`.

## Design

### db-core: remote apply path

`PromotionLifecycle` today only sets `state.promoted` as a side effect of its **local** signing path
(`promote()`/`demote()`); there is no way for a member that did **not** originate the notice to adopt
the promoted/demoted state. Add:

```ts
applyPromotionNotice(n: PromotionNoticeV1, now: number): void   // sets promoted=true, promotedAt=now for n.topicId
applyDemotionNotice(n: DemotionNoticeV1, now: number): void     // clears promoted state for n.topicId
```

These set the same per-topic `PromotionState` the local path sets, **without** re-signing (the
notice is already a verified quorum decision). Idempotent: applying the same notice twice, or an
older notice (lower `effectiveAt`) than the current state, is a no-op (guard on `effectiveAt`).
`isPromoted(topicId)` then reflects remotely-applied state, so a member that learns of promotion via
gossip/notice answers `Promoted(d+1)` to subsequent registrations even though it didn't originate it.

Verification stays in db-p2p/the verifier — `applyPromotionNotice` trusts its caller verified the
signature (document this precondition; do not re-verify inside db-core, which is crypto-free).

### Host: inbound handler

`promote` handler:
1. Decode `decodePromotionNoticeV1` / `decodeDemotionNoticeV1` (try one, then the other).
2. Compute the cohort coord the signers should belong to: for a promotion, `coord_{fromTier}(P, topicId)`
   — but the host receiving the notice is itself a member of that cohort, so use the **served coord**
   of the `CoordEngine` for `(topicId, fromTier)`; for a demotion arriving at the parent, the parent
   `CoordEngine`'s served coord. Resolve the target `CoordEngine` via the registry.
3. `await verifier.verifyMessage(signers, coord, tier, payload, sig)` where `payload` is rebuilt with
   `promotionNoticeSigningPayload(notice)` / `demotionNoticeSigningPayload(notice)`. The verifier
   fetches/uses the cohort's `MembershipCertV1` (now real) and checks the quorum.
4. On `"verified"`, call `engine`'s promotion `applyPromotionNotice` / `applyDemotionNotice`. On
   `"untrusted"`, drop (log).
5. Reply `undefined` (one-way) — or an ack frame if the broadcaster awaits; keep one-way to match the
   gossip-style fan-out.

### Host: outbound broadcast

Where the engine surfaces a signed notice (the `accept` path's `onParticipantCountChange` and the
periodic `maybeDemote`), capture the returned notice and broadcast it: encode and `sendOneWay` to
each cohort member over the `promote` protocol (reuse the gossip transport's peer resolution around
the served coord). For a demotion, also send to the parent coord's cohort. Expose this as a
`CoordEngine` callback (`onNotice(notice)`) the engine/host wires, rather than reaching into engine
internals.

## Edge cases & interactions

- **Self-application:** the originating member already set its local state in `promote()`/`demote()`;
  receiving its own broadcast back must be a no-op (idempotency guard on `effectiveAt` + already-set).
- **Stale notice:** a notice with `effectiveAt` older than the current `promotedAt` is ignored
  (prevents a replayed old promotion from un-demoting). Test ordering.
- **Untrusted notice:** signers not a `≥ minSigs` subset of the cohort cert, or a bad signature →
  dropped, state unchanged. Test with a forged single-signer notice (the interim-style sig) — must be
  rejected now that minSigs is enforced.
- **Cert unavailable:** if the verifier cannot obtain a `MembershipCertV1` for the coord (cohort
  hasn't published yet), `verifyMessage` returns `untrusted` after its single refetch → notice
  dropped; the cohort converges once the cert publishes (periodic-driver ticket). Document this
  ordering dependency.
- **Demotion to parent:** the parent cohort applies "drop me from your tier-(d+1) children",
  affecting `childCohortCount`. For the single-cohort milestone (no children) this path is exercised
  only in a unit test, not the tier-0 e2e; ensure it doesn't throw when no parent engine exists.
- **Epoch mismatch:** the notice's `cohortEpoch` must match the cert used to verify (within the
  one-rotation tolerance from the verifier). A notice signed under a rotated-away epoch verifies
  against the matching cert or is dropped.
- **Promote/register race:** a registration arriving between local `state.promoted=true` and the
  broadcast landing on siblings is handled by the existing `Promoted(d+1)` bounce on whichever
  members are already promoted; siblings not yet applied still `accept` until the notice lands
  (bounded by one round) — consistent with the documented gossip-lag overshoot.

## TODO

- Add `applyPromotionNotice` / `applyDemotionNotice` to `PromotionLifecycle` (idempotent,
  `effectiveAt`-guarded, no re-sign); document the "caller verified" precondition.
- Host: decode + verify (`verifier.verifyMessage` over the rebuilt payload) + apply in the `promote`
  handler; resolve the target `CoordEngine` via the registry.
- Host: capture signed notices from the engine and `sendOneWay`-broadcast them over `promote` to the
  cohort (and parent coord for demotion) via an `onNotice` callback.
- Tests: verified promotion notice flips a remote member's `isPromoted`; forged/short-quorum notice
  rejected; stale (older `effectiveAt`) notice ignored; self-broadcast is a no-op; demotion with no
  parent engine doesn't throw.
- Run `yarn test:db-core`, `yarn test:db-p2p` (stream with `tee`), and the type-check before handoff.
