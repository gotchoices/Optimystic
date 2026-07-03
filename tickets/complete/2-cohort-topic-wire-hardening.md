description: Two hardening fixes in the cohort-topic layer — a peer's redirect reply can no longer crash a topic lookup with a bad tier number, and several fixed-size identifier fields now reject oversized values before they can bloat in-memory maps — reviewed, extended with a boundary test and a tripwire, and shipped.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts                 # (a) bound adopted promoted targetTier; + tripwire NOTE on the d+1 fallback
  - packages/db-core/src/cohort-topic/wire/validate.ts        # (b) length-check fixed-width byte fields; cohortEpoch left lenient (tracked)
  - packages/db-core/test/cohort-topic/walk.spec.ts           # out-of-range targetTier → retry_later; + added the 61 ceiling+1 boundary
  - packages/db-core/test/cohort-topic/wire.spec.ts           # over-length topicId / correlationId rejected
difficulty: medium
----

# Complete: cohort-topic wire hardening (adopted redirect tier + fixed-width byte fields)

Parts (a) and (b) of the parent fix `2-cohort-topic-topic-wire-validation-bounds-hoist`. Part (c) (the
cross-module primitive hoist) is a separate downstream ticket (`cohort-topic-wire-validate-hoist`).

## What shipped

- **(a) Redirect-tier crash bounded (`walk.ts`).** A `promoted` reply's explicit `targetTier` is now
  range-checked (`isValidTreeTier`: integer in `0..DEFAULT_D_MAX_CAP`) before either adoption site, so a
  hostile `2.5` / `-1` / `300` yields a clean `retry_later` instead of a raw `RangeError` out of
  `coordD`.
- **(b) Fixed-width byte fields length-checked (`wire/validate.ts`).** Hash-derived fixed-width fields
  (`topicId`, `correlationId`, ring `coord`s, etc.) switched from `b64urlField` to `b64urlFixedLen(…, N, …)`
  so an oversized value is rejected at decode before it can become a bloated map key. `CORRELATION_BYTES = 16`
  added; `COORD_BYTES = 32` relocated. Peer-id / signature / opaque payload fields stay lenient (variable
  width, per the parent ticket's do-not-pin list).

**Build + test:** `yarn workspace @optimystic/db-core build` clean (tsc, which is also the type check —
db-core has no separate lint). `yarn workspace @optimystic/db-core test` → **1094 passing, 0 failing**.

## Review findings

**Scope reviewed:** the full implement-stage diff (walk.ts, validate.ts, both spec files) read first with
fresh eyes; then the handoff. Angles checked: correctness of the tier guard (both `followPromoted` modes
and the `d+1` fallback path), the fixed-width pin set, the deferred `cohortEpoch` decision, cross-package
blast radius, test coverage (happy / edge / boundary / attack), and doc/comment accuracy.

- **Resolved the implementer's flagged `cohortEpoch` decision (major → new ticket, not fixed inline).**
  The implementer left `cohortEpoch` / `prevEpoch` lenient and asked the reviewer to confirm whether a real
  epoch is genuinely 32 bytes. **Confirmed it is:** `packages/db-p2p/src/cohort-topic/host.ts:660` derives
  the epoch as `hash.H(…)` where `hash.H` is db-core's SHA-256 → always 32 bytes; every real path and every
  round-trip fixture uses 32 bytes. The only non-32 values are lazy synthetic placeholders in tests where
  epoch width is irrelevant. **However**, the true blast radius of pinning is larger than the implementer
  realized: **7 fixtures across two packages** (db-core reactivity ×3 *and* db-p2p ×4, incl. a slow
  real-libp2p integration test), not the one fixture they saw. Because pinning in db-core's validator breaks
  every db-p2p decode of a short epoch, it is all-or-nothing across package boundaries — too large and too
  far outside this db-core review's scope to smuggle in inline. I briefly applied the pin to measure the
  radius, confirmed the cross-package reach, then reverted to the green lenient state and filed
  **`backlog/debt-cohort-topic-pin-cohort-epoch.md`** with the confirmed width finding and all 7 sites
  enumerated, so it is a mechanical follow-up. Left `// NOTE:` markers at the seven validator sites pointing
  at that ticket. (This also resolves the `ChildLinkV1.cohortEpoch`-is-the-only-pinned-epoch asymmetry —
  the debt ticket removes it.)
- **Added the boundary test the implementer flagged as only-implicit (minor → fixed inline).** The
  out-of-range `targetTier` test exercised `2.5 / -1 / 300`; I added **`61`** (exact `DEFAULT_D_MAX_CAP + 1`)
  so the walk-loop rejection boundary is pinned, not just a coarse "far above" value. Green.
- **Tripwire on the unchecked `d + 1` fallback (conditional → recorded, not a ticket).** The guard only
  bounds the *explicit* attacker `targetTier`; the `?? d + 1` fallback is unchecked. It is safe under
  default config — `d` is bounded to `dMax + maxSteps` (≈190) which is under coordD's 255 range — but
  `maxSteps` is operator-configurable, and a value above ~195 plus an adversarial chain of no-`targetTier`
  `promoted` replies (each bumps `d` by +1) could push the fallback past coordD's range and reintroduce the
  `RangeError`. Genuinely conditional, so recorded as a `// NOTE:` at the fallback site in `walk.ts`
  (`case "promoted"`), not filed.
- **Tripwire carried over from implement (unchanged).** The deferred max-length ceiling on variable-width
  peer-id / signature fields (also attacker-bloatable, but widths aren't spec-pinned so a ceiling is a
  policy choice) remains a `// NOTE:` in `b64urlField`'s JSDoc. Correct disposition; left as-is.
- **Accepted coverage gaps (minor, not worth closing now).** The over-length rejection tests only exercise
  `RegisterV1`'s `topicId` / `correlationId`; the other newly-pinned fields rely on the same
  `b64urlFixedLen` helper and the full-suite round-trips for their happy path, so dedicated per-type
  over-length tests add little (the debt ticket adds one for `cohortEpoch` when it lands). No explicit
  under-length test on the pinned fields either, but `b64urlFixedLen`'s exact-equality check and the
  existing ChildLink non-32-byte test cover that transitively. A positive walk boundary (`targetTier = 60`
  followed, not rejected) would need elaborate scripted-router setup for marginal value — left out.
- **Correctness of the tier guard — verified sound.** When `reply.targetTier !== undefined` the guarded
  value equals `reply.targetTier`, so the check is exactly `isValidTreeTier(reply.targetTier)`; NaN/Infinity
  are already rejected at decode (`optFiniteNumber`); the early `retry_later` return leaks no walk state
  (the pre-guard resets are irrelevant on a return). Both `followPromoted` modes covered by the test.
- **Docs/comments — checked and accurate.** No `docs/` file describes these validator field widths or the
  redirect-tier bound directly; the change's own JSDoc/comments (the `treeTier` range rationale, the
  `b64urlField` vs `b64urlFixedLen` split, the `targetTier`-checked-in-walk note) were read and match the
  new reality. Updated the reverted-field NOTEs to point at the debt ticket rather than a single fixture.

## Follow-ups filed

- `backlog/debt-cohort-topic-pin-cohort-epoch.md` — pin `cohortEpoch` / `prevEpoch` to 32 bytes across the
  seven validator sites once all 7 cross-package fixtures are widened; adds an over-length epoch test.
