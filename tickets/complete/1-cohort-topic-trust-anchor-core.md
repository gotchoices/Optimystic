description: Membership certificates are no longer believed just for being internally consistent — a forged one signed by the wrong keys is now rejected once a node can trace the real cohort, and legitimate key rotations are recognized by a signed hand-off from the prior cohort.
prereq:
files:
  - packages/db-core/src/cohort-topic/ports.ts
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/src/cohort-topic/membership/publisher.ts
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/test/cohort-topic/membership.spec.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - docs/cohort-topic.md (§Bootstrapping trust, §Membership fetch)
----

# Complete: trust-anchor framework for MembershipCertV1 (db-core)

The db-core half of the membership-cert trust-anchor fix. `CachingMembershipVerifier` now gates a
(re)fetched `MembershipCertV1` through `certIsTrusted(cert, tier)`: a cert must be self-consistent
**and** anchored by a trust root, a `"anchored"` direct anchor, or a valid rotation-attestation chain,
else it falls to an interim TOFU fallback (first-use only; once a coord holds a trusted cert, an
un-anchored cert for it is rejected — the "lock"). A `"rejected"` direct-anchor verdict is fatal. New
optional, backward-compatible `prevEpoch`/`rotationSig`/`rotationSigners` wire fields (validated
all-or-nothing, not part of `membershipCertSigningPayload`) carry the predecessor cohort's hand-off
signature. Production wiring (FRET anchor, genesis roots, attestation production) is intentionally
deferred to the prereq-chained db-p2p tickets.

See the original implement handoff (commit `c8eba08`) for the full surface description and the design
rationale of the "lock" model.

## Review findings

### Verified (build / tests / lint)
- `yarn build` green in db-core and db-p2p (db-p2p confirms the new optional params are backward-compatible).
- `yarn test` green in db-core: **963 passing, 0 failing** (962 from implement + 1 added this review).
- Lint: the repo `lint` script is a stub (`echo 'Lint not configured for all packages'`); `tsc` is the
  effective type/lint gate and passes clean. No real linter to run — stated explicitly, not skipped silently.

### Correctness / security (checked, sound)
- **Signing-payload isolation.** `membershipCertSigningPayload` uses `Pick<…, "cohortCoord" | "cohortEpoch" | "members" | "stabilizedAt">`, so the rotation fields are provably excluded from the signed image — legacy certs decode and the round-trip is stable. Confirmed against `sig/payloads.ts` (unchanged).
- **Trust gate ordering** (`certIsTrusted`): self-consistency precondition → trust-root → direct anchor (`"anchored"`/`"rejected"`/`"unknown"`) → chain → fallback. A `"rejected"` verdict is fatal and a non-self-consistent cert never reaches the trust-root/chain checks. Verified by reading + the suite.
- **Reject never poisons the cache.** `loadFrom` returns `undefined` on `"reject"` *before* any `byCoord.set`, so a rejected refetch leaves a prior trusted/TOFU entry intact and the message correctly returns `untrusted`. The single refetch still fires (rejected == absent). Confirmed.
- **Trusted-cache invariant.** Only `"trusted"` certs (`cache()` self-publish / trust-root / `"anchored"` / valid chain) set `trusted: true`; a `"tofu"` cert cannot anchor a rotation. `chainGrantsTrust` requires `predecessor.trusted`, a matching `prevEpoch`, non-self-reference, and a `≥ minSigs` quorum of the predecessor's members over the successor payload. Covered by the trusted-vs-TOFU contrast tests.
- **`cache()` trusted=true is safe in production.** Traced the only non-test caller: db-p2p `host.ts` `onCertPublished` → fed exclusively this node's own freshly-published cert via `publishAndCache`. No path passes a network-received cert to `cache()`, so the "a node trusts what it published" assumption holds.
- **Wire all-or-nothing validation** (`validateRotationAttestation`): partial sets (all 6 shapes), non-base64url `prevEpoch`/`rotationSig`, and non-array `rotationSigners` are rejected; per-element signer decode is deferred and a malformed signer surfaces as `CohortWireError` → "no cert" via `loadFrom`'s try/catch (same contract as `signers`). Confirmed in `wire.spec.ts`.
- **Exports reachable.** `ports.ts` symbols flow through `cohort-topic/index.ts` (`export *`); `RotationAttestation`/`MembershipVerifierDeps` via `membership/index.js`. (The implement note "Exported via index.ts" is via wildcard re-export, not an explicit line — verified compiling consumers see them.)

### Tests added/strengthened this pass (minor — fixed inline)
- Added `'threads the verifying cert and the router tier into the direct anchor'` (`membership.spec.ts`): a
  recording anchor asserts `directAnchor` is consulted **exactly once** with the loaded cert's
  `cohortCoord`/`cohortEpoch` and the **same tier** the router dispatched (T3). This closes the
  implementer-flagged "tier threading is untested end-to-end" gap — previously every test used a
  `constAnchor` that ignored both args, so nothing pinned the binding to the right cert/tier.

### Design trade-off confirmed (the "lock")
The lock model (un-anchored cert rejected once a coord is trust-established) is the correct reading: it is
the only one under which "epoch rotations are protected by the chain once any cert is trusted" is literally
true, and it gives the forged-rotation test its teeth. **Confirmed as intended.** The modified existing
test (`'stale cached cert triggers exactly one refetch'` reseeded via `source.current()` TOFU instead of
`cache()`) is a correct re-interpretation, not a regression — `cache()` now trust-locks, which would
(rightly) reject the un-anchored `GOOD` refetch; the test still exercises the stale→refetch→verify liveness
path it was written for.

### Major finding → new ticket filed
- **`tickets/backlog/cohort-topic-trust-anchor-locked-cert-staleness-recovery.md`** — a host that
  self-published a coord (trust-locking it) and later loses local authority over it (demotion → direct
  anchor returns `"unknown"`) can get **permanently stuck** on the stale locked cert if it missed an
  intermediate rotation: the refetched later-epoch cert's `prevEpoch` no longer matches the cached
  predecessor, so the chain breaks, the lock rejects it, and recovery only happens on host restart. This
  is a real (narrow, low-severity, safety-preserving) liveness regression vs. the pre-gate verifier, and
  it is **not** closed by the two prereq-chained follow-ons (fret-binding only helps coords the node still
  has authority over; rotation-production does not repair a verifier on the wrong side of a chain gap).
  Filed to backlog because the fix is a design question (bounded re-TOFU vs. staleness eviction vs.
  drop-lock-on-demotion). Low severity → not stage-blocking.

### Acknowledged interim gaps (by design, already ticketed — not re-filed)
- **No production teeth yet.** `host.ts` builds the verifier with no `anchor`/`trustRoots`, so production
  is pure TOFU today (no regression, no new protection). Closed by `cohort-topic-trust-anchor-fret-binding`
  (implement, prereq-after-this) + `...-rotation-production`; distant T2/T3 and T0/T1 by the backlog
  `...-fret-stabilization-proof` / `...-txlog-committed-binding`. Honest decomposition, not a defect.
- **Predecessor-trusted-via-root/anchor + rotation** is not exercised (rotation tests establish the
  predecessor via `cache()`); the code path is identical (`predecessor.trusted` is the only gate). Minor
  test gap, left as-is.
- **RefetchBound × trust gate** not exercised together; **concurrency** over the plain `Map` cache is a
  pre-existing shape. Neither introduced here; not addressed.

### Pre-existing failures
None encountered — the full db-core suite is green at this SHA. No `tickets/.pre-existing-error.md` written.

## Follow-on tickets (filed; not part of this review)
- `cohort-topic-trust-anchor-fret-binding` (implement) — binds `FretTrustAnchor` + seeds genesis roots.
- `cohort-topic-trust-anchor-rotation-production` (implement) — produces rotation attestations.
- `cohort-topic-trust-anchor-fret-stabilization-proof`, `...-txlog-committed-binding` (backlog).
- `cohort-topic-trust-anchor-locked-cert-staleness-recovery` (backlog) — **new, filed this review.**
