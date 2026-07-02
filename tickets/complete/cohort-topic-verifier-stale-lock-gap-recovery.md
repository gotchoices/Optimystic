description: A node that used to serve part of the network could get permanently stuck distrusting it after that part changed membership while the node wasn't watching; it now heals itself instead of needing a restart.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/test/cohort-topic/membership.spec.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - docs/cohort-topic.md
difficulty: medium
----

# Complete: verifier-side recovery from a stale trust-locked cert

## What shipped

`CachingMembershipVerifier` now self-heals a "trust-locked" cohort coordinate that a former member can no
longer anchor. When a node holds a fully-trusted cert for a coord (e.g. one it self-published while serving
that coord) it refuses any re-fetched cert that isn't independently re-anchored — deliberate, to stop a
forger downgrading an established coord back to trust-on-first-use (TOFU). The bug: a node that served a
coord, then *left* its cohort, keeps that lock but loses every way to satisfy it (its authority signal goes
`"unknown"`, and a missed intermediate rotation breaks the rotation chain), so it distrusts every message
from that coord until the process restarts. Pure liveness — a forgery was still rejected.

The fix, entirely in `verifier.ts`, is **bounded re-TOFU on a demonstrated chain gap**: after
`staleGapRecoveryStrikes` (default `3`) *consecutive* refetches that each present an explicit rotation gap
(`prevEpoch` ≠ both the cert's own epoch and the cached locked epoch), the lock is released and the coord
re-enters the TOFU regime a never-member is already in. A forged rotation off the *current* predecessor
(`prevEpoch == cachedEpoch`) is not a gap, never strikes, and stays rejected — so the lock's safety teeth
are preserved. The recovered cert is re-cached as **untrusted**, so it can never launder trust into a
rotation.

## Review findings

**Read the implement diff (`306bf7c`) first, then the handoff.** Scrutinised from correctness, safety,
DRY, resource cleanup, type safety, and test-coverage angles.

### Verified sound (no change needed)

- **The safety gate — the crux.** Recovery is gated behind `fallback === "reject"`, which is exactly the
  trust-locked state, and `isGap` excludes the `prevEpoch == cachedEpoch` regime where the lock's headline
  invariant lives. Traced the two realistic attackers:
  - *Message-injection only* (honest `source.fetch()`): forged messages trigger refetches that return the
    **real** current cert; strikes accrue on the genuine gap and recovery heals to the real cert — the
    intended outcome. Forged messages never verify. A non-gapped coord's real cert re-anchors via the chain
    (not a gap), so no spurious unlock. **Cannot force a wrong unlock.**
  - *`source.fetch()` MITM*: can drive recovery in 3 messages, but this reduces the coord to the documented
    TOFU baseline a never-member is already in under the same MITM. No net weakening. Matches the ticket's
    stated belief.
  - Confirmed recovery is naturally scoped to *former* members: a still-served coord's anchor returns
    `"anchored"`/`"rejected"`, never `"unknown"`, so it never reaches `staleGapRecovery`. (Also holds for
    trust-root coords: a current-epoch root matches `matchesTrustRoot` first; only a genuinely-unanchorable
    gapped root reaches recovery, where healing is again the intended behavior.)
- **Strike counting / reset semantics.** Exactly one strike per gap-signalled `verifyMessage`; reset on any
  successful verify (cached or refetched); threshold arithmetic (`strikes < threshold`) is correct for
  `1`, `3`, `5`; `> 0` guard correctly disables at `0`/negative.
- **Seed-path safety.** A locked coord always has a cached cert, so `verifyMessage` never routes it through
  `source.current()`; `staleGapRecovery` is only reachable on the refetch load. Confirmed.
- **Gap detection keying on `prevEpoch` structure, not a valid `rotationSig`.** Agreed correct: the cert is
  re-cached untrusted regardless, so an unvalidated attestation cannot launder trust; the node by definition
  cannot check the predecessor signature for an epoch it never witnessed.
- **Strike-map key consistency** (`cert.cohortCoord` vs `bytesToB64url(expectedCoord)`). Glanced as the
  ticket asked: a coord-mismatched fetched cert makes `locked` lookup miss → `isGap` false → reject, so no
  strike is ever set under a mismatched key. Benign; rests on the same `byCoord` invariant that predates
  this change.
- **Typecheck + build.** `yarn --cwd packages/db-core build` and `.../db-p2p build` both clean.

### Fixed inline (minor)

- **Missing test for the `staleGapRecoveryStrikes = 0` disable contract.** The docstring documents `0`/
  negative as disabling recovery (re-opening the liveness bug), and this is the branch that would silently
  weaken the safety guard if the `> 0` gate were ever dropped — yet it had zero coverage. Added
  `with recovery disabled (staleGapRecoveryStrikes = 0) a stale-locked coord never self-heals` to the
  "stale trust-lock recovery" describe. Suite now **1006 passing** (was 1005).

### Not filed (tests-as-floor gaps deemed low-value)

- Self-referential `prevEpoch == cohortEpoch` guard, RefetchBound-suppressed-refetch-accrues-no-strike, and
  post-recovery "coord is now unlocked so a *different* cert TOFU-accepts" are each exercised indirectly by
  existing cases and/or guarded by the same code path as covered branches. Not worth new tests; noted here
  for the record rather than filed.

### Tripwires (recorded, not filed as tickets)

- **Root-cause fix is drop-the-lock-on-demotion** — have the host `verifier.forget(coord)` when it stops
  serving a coord, so a former-member coord is never locked at all. Conditional on an engine-reclaim /
  demotion signal the host does not emit today (`createCoordRegistry` never evicts). Already parked as the
  `NOTE:` at `host.ts:742` (onCertPublished seam) and in `docs/cohort-topic.md` §Bootstrapping trust.
  Verified the comment's "see the NOTE below" correctly points at the eviction NOTE at `host.ts:775`. Prefer
  that fix over the strike heuristic when reclaim lands. **Left as-is.**
- **Unbounded per-coord maps** (`staleGapStrikes` joins the pre-existing `byCoord` / `lastFetchAt`). Entries
  clear on any successful verify; a coord that strikes 1–2× then goes silent keeps its entry. Same growth
  class as the existing never-evicted maps, itself covered by the `host.ts:775` eviction tripwire. No new
  action.
- **Threshold default of `3` is a heuristic, not exposed as a host/network knob.** If a network needs to
  tune recovery latency vs. transient-gap resistance, `createCohortTopicHost` would need a new option
  threaded to `createMembershipVerifier`. Documented in the ticket; not needed now.

### Docs

Read the full diff to `docs/cohort-topic.md` §Bootstrapping trust ("Stale trust-lock recovery" paragraph)
and both `host.ts` NOTE comments — all three reflect the shipped reality (default-on recovery, the gap
condition, the re-TOFU-as-untrusted invariant, and the drop-the-lock-on-demotion tripwire). No staleness.

## Validation

- `yarn --cwd packages/db-core test` → **1006 passing** (added one test; was 1005).
- `yarn --cwd packages/db-core build` and `yarn --cwd packages/db-p2p build` → clean (no lint script in this
  repo; typecheck is via `tsc` build).
