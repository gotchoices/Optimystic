description: When a cohort's membership changes, the outgoing members now co-sign the new membership list so peers can confirm the change is a legitimate hand-off rather than an impostor takeover. This ticket built the producing side; the verifying side already existed.
prereq: cohort-topic-trust-anchor-fret-binding
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (SignKind += "rotation" ~L229)
  - packages/db-core/src/cohort-topic/wire/validate.ts (SIGN_KINDS += "rotation" ~L399)
  - packages/db-core/src/cohort-topic/membership/publisher.ts (extracted+exported membershipCertSignable; publish() now uses it)
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (selfEligible option on FretCohortThresholdCrypto.assemble)
  - packages/db-p2p/src/cohort-topic/host.ts (RotationState, produceRotation, publishMembership, handleSignRequest "rotation" branch, registry.findByCoord, CoordEngine.cohortIdentityAt)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (excludeFromAssembly / includeInAssembly)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (tests 8–11)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (the chain check this feeds — UNCHANGED, the verify side)
  - docs/cohort-topic.md (§Bootstrapping trust — item 3 production note)
difficulty: hard
----

# Review: produce rotation attestations on epoch change (db-p2p)

## What this closes

The core ticket made the db-core verifier **accept** a successor cert via the attestation chain
(`chainGrantsTrust` in `membership/verifier.ts`): a cert carrying `prevEpoch`/`rotationSig`/`rotationSigners`
inherits trust when the node holds a *trusted* predecessor at `prevEpoch` whose members form a `≥ minSigs`
quorum over the successor's signing payload. **Nothing produced that `rotationSig`** — the db-p2p publisher
only emitted non-rotation certs, so the chain was verify-only. This ticket produces the attestation, closing
the loop: an epoch rotation now carries a verifiable hand-off the outgoing cohort co-signed.

## What landed

On a publish that changes the first `k − x` members (the publisher's existing republish trigger), the
served `CoordEngine`:

1. builds the **new** cert's canonical `membershipCertSignable` image (the SAME helper the publisher signs —
   now extracted to db-core and shared, so the signature image matches exactly);
2. threshold-signs that image under the **predecessor** cohort identity — a `/sign` round with a new
   `"rotation"` `SignKind`, `cohortEpoch = prevEpoch`, dialing the *outgoing* (prior-epoch) members;
3. attaches `{ prevEpoch, rotationSig, rotationSigners }` via the publisher's `rotation` arg (added in core).

The `/sign` endorsement gate for `"rotation"` checks **prior**-epoch membership: a member endorses only if it
(and the requester) were members of the cohort at `prevEpoch`, looked up from a two-deep observed-epoch
history per coord (`RotationState`). Self contributes its own chunk only when it was itself a prior member
(`selfEligible` on the threshold crypto), so the quorum is genuinely the outgoing cohort.

### Key design decisions (scrutinize these)

- **Producer/endorser state split.** `RotationState` tracks two things: `lastPublished` (the chain
  predecessor — drives *which* epoch a producer attests from and *whom* it dials) and a two-deep
  `current`/`prior` observed-epoch history (drives the *endorser's* "was I a member at prevEpoch" check). They
  are separate because a non-deciding member endorses rotations it never published. The observed history is
  refreshed inside the engine's `cohort()` wrapper (cheap: only rebuilds the member-string list on an actual
  epoch change), so the gossip-cadence driver keeps it fresh in production.
- **Rotation runs only on a first-`k − x` change**, detected host-side (`firstKxChanged`) against
  `lastPublished` — the same condition the publisher uses to republish — so the `/sign` round costs one round
  per rotation, never per tick. A periodic refresh (firstKx unchanged) carries no rotation fields.
- **Signature-image agreement** is enforced structurally: `membershipCertSignable(snapshot)` is the single
  source of the signed bytes for both the publisher's own cert and the rotation payload. A drift here would
  silently break the db-core chain check; test 8 round-trips a produced cert through the real verifier to
  guard it.

## How to exercise it (tests live in `live-tier.spec.ts` 8–11)

Setup uses `wantK = 4` over `N = 5` with `minSigs = 4` (= wantK), so the cohort is a strict subset and any
single membership swap changes the **whole** first-`k − x` set → a guaranteed rotation. The new harness
`mesh.excludeFromAssembly(idStr)` drops a node from FRET cohort assembly (changing the epoch) while leaving
it dialable, so the outgoing cohort can still co-sign.

- **8 — legit rotation accepted as a chain extension.** Publish epoch-N cert; exclude one prior member;
  republish → the cert carries a `rotationSig` whose signers are all prior-cohort members. A no-direct-anchor
  db-core verifier that `cache()`s cert N (trusted predecessor, which blocks TOFU) then accepts cert N+1 as
  `"verified"` — trust extended across the rotation with no fresh direct anchor.
- **9 — forged rotation rejected end-to-end.** Same cert, but the attestation is re-signed by the **new**
  cohort (which includes a node not in cert N's members). One non-prior signer makes
  `rotationSigners ⊄ predecessor.members`; with cert N cached, the chain fails and the fallback rejects
  (no TOFU downgrade) → `"untrusted"`.
- **10 — predecessor quorum unavailable.** Exclude *and* crash the prior member: the new cohort still reaches
  its own `minSigs`, but the outgoing cohort cannot, so the `/sign` round throws → the cert publishes **without**
  a rotation attestation (clean fallback to anchor/TOFU), `prevEpoch`/`rotationSig`/`rotationSigners` all absent.
- **11 — non-rotation refresh.** A periodic refresh past `T_membership_refresh` with unchanged membership
  republishes but emits no rotation fields.

### Validation run

- `yarn build:db-core` + `yarn build:db-p2p` (tsc) — clean (exit 0).
- `db-core` full suite — **963 passing** (publisher refactor + SignKind change, no regressions).
- `live-tier.spec.ts` — **11 passing** (7 prior + 4 new rotation tests).
- Affected db-p2p cohort-topic specs (threshold-assembly, promote-notice, gossip-cadence, service,
  host-node-activation, live-tier) in isolation — **60 passing** (confirms the `selfEligible` /
  `handleSignRequest` / `RotationState` changes don't regress the existing sign / promote / membership paths).
- `db-p2p` **full** suite — **963 passing, 30 pending, 2 failing**. The 2 failures are both
  `reactivity / mesh — cold-to-hot growth + delivery` (`mesh-cold-to-hot.spec.ts`) **60s-timeouts under
  full-suite CPU contention** — outside this diff (reactivity subsystem), and **pass in isolation** (that
  spec alone → 5 passing, the two tests complete in 32.1s / 52.8s). Flagged in `tickets/.pre-existing-error.md`
  for triage; same known class the fret-binding review already documented. **Not caused by this ticket.**

## Honest gaps / where to look hardest (reviewer: treat tests as a floor)

- **Production wiring of `onStabilized`.** The periodic driver (`createCohortTopicHost` `driveTick`) calls
  `pumpMembership` (the time-refresh `tick`) every gossip tick but does **not** call `onStabilized`. My
  `publishMembership` produces a rotation on **either** hook when `firstKxChanged` is true, so a firstKx change
  picked up by a refresh tick *will* rotate — but I did not change the driver, and I did not find a production
  caller of `onStabilized` outside tests. **Worth confirming** a real membership change actually reaches
  `publishMembership` promptly in production (vs. only on the 5-min refresh), and whether the driver should
  call `onStabilized` too. Tests drive `onStabilized` directly, so this path is not covered by an e2e wiring test.
- **Endorser history freshness depends on the driver.** The two-deep `current`/`prior` history is kept fresh
  by `cohort()` calls (every gossip round in production). The unit tests rely on `setupTopic` having warmed
  each cohort member's history at epoch N (via the willingness-merge `cohort()` calls). In production a member
  that has NOT recently assembled its cohort (e.g. just after restart) could miss `prevEpoch` and refuse to
  endorse — degrading to the predecessor-quorum-unavailable fallback (publish without attestation), which is
  safe but worth a sanity check against a cold-restart member.
- **firstKx-unchanged epoch change.** A refresh that changes the epoch because a *non*-firstKx member churned
  (epoch = H(all members), but the first `minSigs` are unchanged) republishes with **no** rotation attestation.
  For an un-anchored already-trusted coord the verifier would reject that successor. This follows the ticket's
  "firstKx change is the rotation boundary" framing and is masked in production by the FRET direct anchor on
  served coords, but it is a real edge the tests do not cover (all swaps here change the whole firstKx set).
- **`minSigs = wantK` in the tests** guarantees a firstKx change on any swap, which is convenient but means the
  tests never exercise a *partial* firstKx change (swap a member that is/ isn't in the first `minSigs` under
  `minSigs < wantK`). The production `minSigs = 14 / wantK = 16` path has slack; a reviewer may want a case
  where only some of the firstKx change.
- **No multi-node assembly of the rotation sig under real concurrency.** Test 8/9 produce the rotation via the
  real mesh `/sign` round (good), but the chain *acceptance* is checked against a standalone verifier, not a
  second live host's `service.verifier()`. The end-to-end "another node fetches N+1 over `/membership` and
  trusts it" path is implied, not directly asserted.

## Out of scope (correctly deferred, not defects)

- Multi-hop attestations across a rapid double rotation (N→N+1→N+2): each publish attests only its immediate
  predecessor; a participant cached at N receiving N+2 re-anchors. Documented.
- The `promotion`/`demotion` per-topic endorsement refinement (hot/cold `directParticipants`) remains deferred
  as before — `"rotation"` reuses the cohort+epoch gate shape, scoped to the prior epoch.

## End
