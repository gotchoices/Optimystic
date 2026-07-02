description: A node that used to serve part of the network could get permanently stuck distrusting it after that part changed membership while the node wasn't watching; it now heals itself instead of needing a restart. Review the self-healing logic and its safety gate.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/test/cohort-topic/membership.spec.ts
  - packages/db-core/src/cohort-topic/ports.ts (TrustAnchorVerdict, IMembershipTrustAnchor — unchanged, context)
  - packages/db-p2p/src/cohort-topic/host.ts (onCertPublished seam ~L738-753 — NOTE comment only)
  - docs/cohort-topic.md (§Bootstrapping trust, "Stale trust-lock recovery" paragraph)
difficulty: medium
----

# Review: verifier-side recovery from a stale trust-locked cert

## What the change does (plain language)

`CachingMembershipVerifier` "trust-locks" a cohort coordinate `C` once it holds a cert it fully trusts for
it (e.g. a cert the node published itself while serving `C`). After that, the lock refuses to believe any
re-fetched cert for `C` that isn't independently re-anchored — this is deliberate: it stops a forger from
downgrading an established coord back to trust-on-first-use (TOFU).

The bug: a node that **served `C`, then left `C`'s cohort** keeps the lock but loses every way to satisfy it.
Its authority signal (`directAnchor`) now says `"unknown"` for `C`, and if `C` rotated its membership more
than once while the node wasn't watching, the later cert's back-pointer (`prevEpoch`) no longer matches the
stale epoch the node has cached, so the rotation chain can't reconnect. Result: the node distrusts every
message from `C` **until the process restarts**. It's a liveness problem, never a safety hole — a forgery is
still rejected.

The fix (all inside `verifier.ts`) is **bounded re-TOFU on a demonstrated chain gap**: after a small number
of *consecutive* refetches that each present an explicit rotation gap, the lock is released and the coord
re-enters the TOFU regime a never-member is already in.

## Implemented mechanics (what to review)

- **New dep `staleGapRecoveryStrikes?: number` (default `3`)** on `MembershipVerifierDeps`. On by default —
  `0`/negative disables recovery (re-opening the bug), so it is deliberately defaulted on. The db-p2p host
  does **not** thread this through `createCohortTopicHost` options; it uses the default (verifier.ts ctor).
- **New per-coord strike map `staleGapStrikes`** (base64url coord key).
- **Recovery decision** lives in the new `staleGapRecovery(cert)` helper, called from `certIsTrusted` only
  in the `verdict === "unknown"` branch, and only when `fallbackTrust` would return `"reject"` — which is
  exactly the "coord is trust-locked" state. A refetch is a *gap strike* only when **all** hold:
  1. the coord is locked (guaranteed by the `fallback === "reject"` gate);
  2. the cert is self-consistent (checked earlier in `certIsTrusted`);
  3. it carries a full rotation attestation whose `prevEpoch` differs from **both** its own `cohortEpoch`
     (not self-referential) **and** the cached locked epoch (a real gap, not a forgery off the current
     predecessor);
  4. the direct anchor said `"unknown"` (a `"rejected"` verdict is fatal earlier and never reaches here;
     an `"anchored"` one recovers on the normal path);
  5. it did not already earn trust by root/anchor/chain (those return before the fallback).
  On the `staleGapRecoveryStrikes`-th consecutive strike it returns `"tofu"`, so `loadFrom` re-caches the
  cert as **untrusted** (must not launder trust into a rotation) and the message-verify retry succeeds.
- **Consecutive reset**: `verifyMessage` clears the coord's strike count on **any** successful message
  verify (both the cached-cert hit and the post-refetch hit).
- **Comments** at the recovery site spell out the invariant and the `RefetchBound` pacing interaction.

## Why the safety gate holds (the crux to scrutinise)

The lock's headline invariant — *an un-anchored cert whose `prevEpoch == cachedEpoch` stays rejected* — lives
entirely in the `prevEpoch == cachedEpoch` regime, which the gap condition (3) **excludes**. So a forged
rotation off the current trusted predecessor (adversary keys, `prevEpoch == N`) is **not a gap**, never
increments a strike, and stays rejected forever. Recovery only fires on a cert that *proves* the network
rotated past the cached epoch through an epoch the node never witnessed. Accepting it via re-TOFU is no
weaker than the documented TOFU baseline: a former member returns to the same regime a never-member is
already in. **This is the property a reviewer should try hardest to break.**

Also note recovery is naturally scoped to *former* members: a coord the node still serves has an
`"anchored"`/`"rejected"` anchor verdict, never `"unknown"`, so it never reaches `staleGapRecovery`.

## Tests added (`membership.spec.ts`, new describe "stale trust-lock recovery" — 6 cases, all green)

Reuse `buildCertOver` / `rotationSigOver` / `QueueSource` / `constAnchor`; `gapCertN2()` builds the N+2 cert
whose `prevEpoch = N+1 ≠` the cached N.

1. **Recovery** — locked at N, anchor `"unknown"`, gap cert refetched: first two return `untrusted`, the
   third recovers (`verified`), and subsequent messages verify from cache with no further refetch.
2. **Forged-off-predecessor never strikes** — a `prevEpoch == N` adversary cert presented 12× stays
   `untrusted` and accrues no strikes (the genuine gap cert afterward still needs its full 3).
3. **Interleaved** — alternating gap/forged: the forged calls stay `untrusted` and neither reset nor
   accelerate the real gap's consecutive count (recovers on the 3rd gap).
4. **`"rejected"` anchor fatal** — a gap cert with a `"rejected"` verdict is dropped regardless of strikes.
5. **No premature recovery** — with threshold 5, four strikes stay locked.
6. **Consecutive reset** — a legit N-cohort message verifying from cache between strikes resets the counter.

Validation run: `yarn --cwd packages/db-core test` → **1005 passing**. db-p2p cohort-topic suite
(`test/cohort-topic/**`) → **187 passing, 5 pending, 0 failing** (confirms the default-on recovery path
regresses nothing; the "parent unreachable" console line is expected output from a negative-path test).

## Known gaps / things to probe (tests are a floor, not a ceiling)

- **Post-recovery is full TOFU, by design.** Once recovered, the coord holds an *untrusted* cert, so it is
  back in the TOFU regime: the next cert that arrives on a cache **miss** (e.g. behind a forged message that
  the cached cert can't verify) would be TOFU-accepted from `source.fetch()`. This is the documented TOFU
  baseline, not a regression (a never-member behaves identically, and `RefetchBound` still caps the dial
  rate), and it is **why the tests only assert the forged cert stays rejected while the lock is in force**
  (cases 2–3), not after recovery — asserting otherwise would contradict TOFU semantics. A reviewer wanting
  more should probe: can an adversary who controls the message stream *and* `source.fetch()`'s reply do worse
  post-recovery than against any first-sight TOFU coord? (Belief: no — same trust model.)
- **The gap cert's `rotationSig` is intentionally not validated for gap detection.** `chainGrantsTrust` bails
  on the `prevEpoch`/predecessor-epoch mismatch *before* decoding `rotationSig`, and the recovered cert is
  re-cached as **untrusted**, so a bogus attestation can't launder trust. The tests use filler
  `rotationSig` bytes to reflect this. Confirm you agree gap detection *should* key on `prevEpoch` structure
  (a demonstrated gap) rather than a valid predecessor signature the node by definition cannot check.
- **Strike-map key consistency.** `staleGapRecovery` keys the map by `cert.cohortCoord`; `verifyMessage`
  resets by `bytesToB64url(expectedCoord)`. These are equal only under the pre-existing invariant that a
  fetched cert's `cohortCoord` matches the requested coord (the same assumption `byCoord` already relies on).
  Worth a glance that nothing feeds a mismatched-coord cert here.
- **Threshold default of 3 is a heuristic**, not derived. It trades recovery latency (3 bounded refetches)
  against resistance to transient gaps. Not exposed as a host/network config knob (out of scope); if a
  network needs to tune it, `createCohortTopicHost` would need a new option threaded to
  `createMembershipVerifier`.

## Tripwire (do NOT file as a ticket — parked as knowledge)

The **root-cause** fix is *drop-the-lock-on-demotion*: have the host forget a coord's verifier entry when it
stops serving that coord, so a former-member coord is never locked at all. It needs (a) a
`MembershipVerifier.forget(coord)` / downgrade API and (b) an engine-reclaim / demotion signal the host does
not emit today (`createCoordRegistry` never evicts — see the existing NOTE at host.ts ~L765-767). This is
conditional on reclaim infrastructure that does not exist yet, so it is a tripwire, not queued work. Parked
as a `NOTE:` code comment at the `onCertPublished` / `verifier.cache()` seam in
`packages/db-p2p/src/cohort-topic/host.ts` (~L738) and documented in `docs/cohort-topic.md` §Bootstrapping
trust. When engine reclaim lands, prefer that over (or alongside) the strike-counter heuristic.
