description: A node can get permanently stuck distrusting a part of the network it used to serve after that part changes membership while the node wasn't watching; make it recover on its own instead of only after a restart.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/test/cohort-topic/membership.spec.ts
  - packages/db-core/src/cohort-topic/ports.ts (TrustAnchorVerdict ~L103; IMembershipTrustAnchor ~L117)
  - docs/cohort-topic.md (§Bootstrapping trust ~L522-588)
difficulty: medium
----

# Verifier-side recovery from a stale trust-locked cert

## Problem (reproduced)

`CachingMembershipVerifier` (packages/db-core/src/cohort-topic/membership/verifier.ts) trust-**locks** a
coord once it holds a *trusted* cert for it: after that, `fallbackTrust` returns `"reject"` for any
un-anchored refetch (`verifier.ts:255-257`), so no silent trust-on-first-use (TOFU) downgrade can happen.
A node trust-locks a coord in its own verifier by self-publishing its cohort cert — db-p2p feeds that cert
back through `verifier.cache()` from `onCertPublished` (host.ts:741), and `cache()` marks it `trusted`
(`verifier.ts:135-139`).

The lock has **no exit** for a node that has since lost authority over the coord. Concretely, a node that:

1. served coord `C`, self-published its cert → trust-locked `C` at epoch `Eₙ`; then
2. left / was demoted from `C`'s cohort → it no longer self-publishes `C`, and its injected direct trust
   anchor (`IMembershipTrustAnchor.directAnchor`) now returns `"unknown"` for `C` (no local authority); then
3. later receives a message threshold-signed by `C`'s cohort at a **later** epoch `Eₙ₊ₖ`.

`verifyMessage` misses against the stale locked `Eₙ` cert, refetches the `Eₙ₊ₖ` cert, and the refetch is
rejected: if the node **missed an intermediate rotation** the refetched cert's `prevEpoch` is `Eₙ₊ₖ₋₁ ≠ Eₙ`,
so `chainGrantsTrust` returns false (`verifier.ts:270-288`), and because the coord is trust-locked,
`fallbackTrust` returns `"reject"`. Every message from `C` then returns `untrusted` **until the host process
restarts** (which clears the in-memory `byCoord` map).

This was reproduced against the real verifier (a throwaway spec, now removed): a coord `cache()`-locked at
`Eₙ`, anchor `"unknown"`, then a refetched `Eₙ₊₂` cert carrying `prevEpoch = Eₙ₊₁` → `verifyMessage` returns
`untrusted` and stays there. It is a **liveness** degradation, never a safety hole (a forgery is still
rejected), it is narrow (former member of a now-multiply-rotated cohort, anchor `"unknown"`, chain gap), and
it self-heals only on restart. It is not closed by `cohort-topic-trust-anchor-fret-binding` (only anchors
coords the node still covers) nor `cohort-topic-trust-anchor-rotation-production` (produces attestations but
does not repair a verifier stuck on the wrong side of a chain gap).

## Chosen fix: bounded re-TOFU on a demonstrated chain gap

Of the three directions the source ticket sketched, implement **bounded re-TOFU on a broken chain**,
entirely inside `CachingMembershipVerifier`. Rationale for picking it over the alternatives:

- **Eviction-on-staleness (count all refetch-rejects, then drop the lock)** is *unsafe as stated*: a forger
  flooding the verify path with forged rotations that claim `prevEpoch = Eₙ` (the currently-cached epoch, the
  exact "forged rotation off the current trusted predecessor" the lock must reject) would each count as a
  refetch-reject and eventually evict the lock — after which the forged self-consistent cert TOFUs in. That
  breaks the headline invariant. So recovery must be driven **only** by refetched certs that present an
  *explicit chain gap* (a rotation attestation whose `prevEpoch ≠` the cached epoch), never by rejects whose
  `prevEpoch ==` the cached epoch.
- **Drop-the-lock-on-demotion (host explicitly forgets a coord it stops serving)** is the cleaner *root-cause*
  fix, but there is no signal to hook today: `createCoordRegistry` never reclaims engines
  (host.ts:765-767 NOTE) and `MembershipVerifier` exposes only `cache()` + `verifyMessage()`. Recorded as a
  tripwire / future direction below; do not build it in this ticket.

### Why the gap signal preserves the invariant

The recovery trigger is gated on `prevEpoch ≠ cachedEpoch`. The invariant the lock defends — *an un-anchored
cert for a coord whose cached trusted predecessor matches (`prevEpoch == cachedEpoch`) is still rejected* —
lives entirely in the `prevEpoch == cachedEpoch` regime, which the gap condition **excludes**. So:

- A forged rotation off the current trusted predecessor (`prevEpoch == Eₙ`, adversary keys) fails
  `chainGrantsTrust` **and** is not a gap → never increments the recovery counter → stays rejected forever.
- A real intermediate successor (`prevEpoch == Eₙ`, legit keys) passes `chainGrantsTrust` on the normal path
  → no recovery needed.
- Only a cert that *proves the network rotated past the cached epoch through at least one epoch the node never
  witnessed* (`prevEpoch ≠ Eₙ`) — combined with anchor `"unknown"` (no authority) — is recovery-eligible.

Accepting such a gap cert via re-TOFU is **no weaker than the documented TOFU baseline** for a coord this node
cannot anchor: a node that never served `C` already full-TOFUs any self-consistent cert for it
(docs/cohort-topic.md §Interim TOFU fallback, ~L582-588). Recovery merely returns a former-member node to that
same regime, instead of stranding it stricter-than-TOFU forever. This aligns with the already-documented
intent that "a participant cached at N that receives N+2 sees a gap and **re-anchors**"
(docs/cohort-topic.md ~L575-577) — for an anchorable node re-anchoring is the direct anchor; for an
unanchorable one it is re-TOFU.

### Mechanics

Add a per-coord **consecutive stale-gap strike counter** and a small configurable threshold.

- `MembershipVerifierDeps` gains `staleGapRecoveryStrikes?: number` (default e.g. `3`; `0`/`undefined` →
  disabled would *re-open* the bug, so default it **on**). Document it in the deps JSDoc.
- New field `private readonly staleGapStrikes = new Map<string, number>()` keyed by coord (base64url).
- A refetch is **recovery-eligible** for a coord when *all* hold:
  1. the coord currently holds a **trusted** cached cert (it is locked) — i.e. `byCoord.get(coord)?.trusted`;
  2. the refetched cert is **self-consistent** (`certIsSelfConsistent`);
  3. it carries a full rotation attestation (`hasRotationAttestation`) whose `prevEpoch ≠` the cached
     trusted cert's `cohortEpoch` (the explicit gap), and `prevEpoch !== cert.cohortEpoch` (not self-ref);
  4. the direct anchor returned `"unknown"` for it (no authority — a `"rejected"` verdict stays fatal, a
     `"anchored"` verdict already recovers on the normal path);
  5. it does **not** already earn trust by root / anchor / valid chain (those paths recover on their own).
- On a recovery-eligible refetch: increment the coord's strike count. If it reaches
  `staleGapRecoveryStrikes`, **recover**: replace the locked entry with this cert as `trusted: false`
  (TOFU-cached — a re-TOFU'd cert must not launder trust into a rotation, mirroring the existing tofu rule),
  reset the strike count, and let the message-verify retry run against it (so the inbound `Eₙ₊ₖ` message
  verifies and `verifyMessage` returns `"verified"`). Below the threshold, return the cert as rejected
  (message stays `untrusted`) exactly as today.
- **Reset** a coord's strike count to zero whenever a message verifies for that coord (the "consecutive"
  requirement) — i.e. on either the cached-cert hit or the post-refetch hit in `verifyMessage`.

The cleanest seam: `certIsTrusted` today returns `"trusted" | "tofu" | "reject"`. The recovery decision needs
the cached predecessor's epoch and must mutate the strike map, all of which `certIsTrusted`/`loadFrom`
already have in scope (they run under the coord being loaded). Thread the recovery check into the
`verdict === "unknown"` branch of `certIsTrusted` (right where the chain is tried and `fallbackTrust` is
otherwise consulted): if the chain does not grant trust and `fallbackTrust` would return `"reject"` because
the coord is locked, apply the gap-strike logic and return `"tofu"` on the threshold hit, else `"reject"`.
Keep `loadFrom`'s existing "reject → treat as no cert, so the single refetch still fires" behavior intact.

Note the strike increment must run on the **refetch** load, not the cheap `current()` seed — but both go
through `loadFrom`. That is fine: the `current()` path only runs when `byCoord` holds nothing yet
(`verifyMessage` seeds from cache first — `verifier.ts:147-150`), and a locked coord always holds a cached
cert, so `current()` is never consulted for a locked coord. The strike logic keys on "coord is locked", so it
naturally only engages on the refetch. Confirm this in a comment.

### Anti-amplification interaction

`RefetchBound` already rate-limits `source.fetch()` per coord (`verifier.ts:176-188`). When a refetch is
suppressed there is no gap cert to observe, so no strike accrues — recovery paces itself with the (bounded)
refetch rate. No change needed; note it in a comment so a future reader does not "fix" the pacing.

## Invariants to hold (assert in tests)

- **Recovery**: a coord `cache()`-locked at `Eₙ`, anchor `"unknown"`, refetch returns an `Eₙ₊₂` cert with
  `prevEpoch = Eₙ₊₁` → the first `N-1` verifies return `untrusted`, the `N`-th returns `"verified"`, and
  subsequent messages keep verifying (lock replaced).
- **Forged rotation off the current predecessor still rejected — during and after recovery**: a cert with
  `prevEpoch == Eₙ` (the cached epoch) signed by an adversary keyset returns `untrusted` no matter how many
  times it is presented (it never counts as a strike), even interleaved with the real gap cert's recovery.
- **`"rejected"` anchor stays fatal**: a gap cert whose anchor says `"rejected"` is dropped regardless of
  strike count.
- **No premature recovery**: below the threshold the locked coord keeps returning `untrusted`.
- **Counter is consecutive**: a successful verify between strikes resets the count.
- **No regression**: the existing `membership.spec.ts` trust-anchoring + verification suites still pass
  (the normal chain, TOFU-first-use, self-ref reject, trust-root, and forged-off-trusted-predecessor cases).

## TODO

- [ ] In `verifier.ts`: add `staleGapRecoveryStrikes?: number` to `MembershipVerifierDeps` (JSDoc it;
      default `3`), a `staleGapStrikes: Map<string,number>` field, and read the threshold in the ctor.
- [ ] Implement the gap-strike recovery inside the `verdict === "unknown"` branch of `certIsTrusted` (or a
      small helper it calls): detect recovery-eligibility (locked coord + self-consistent + rotation-gap
      `prevEpoch ≠ cachedEpoch` + not root/anchor/chain-trusted), increment/reset the strike map, and return
      `"tofu"` on the threshold hit else `"reject"`. Preserve the "reject → single refetch still fires" flow.
- [ ] Reset a coord's strike count on any successful message-verify in `verifyMessage` (both the cached-hit
      and post-refetch-hit branches).
- [ ] Add a `NOTE:` comment at the recovery site summarising the invariant (only a `prevEpoch ≠ cachedEpoch`
      gap on an `"unknown"` anchor recovers; `prevEpoch == cachedEpoch` forgeries stay rejected) and the
      RefetchBound pacing interaction.
- [ ] Extend `packages/db-core/test/cohort-topic/membership.spec.ts` with the six assertions above (reuse the
      existing `buildCertOver` / `rotationSigOver` / `QueueSource` / `constAnchor` helpers; the `QueueSource`
      is handy for feeding the same gap cert across N refetches).
- [ ] Update `docs/cohort-topic.md` §Bootstrapping trust: add a short paragraph under the TOFU-fallback
      subsection documenting stale-lock recovery — a locked coord whose anchor has gone `"unknown"` and that
      is repeatedly missed by a gap-signalled refetch re-enters the TOFU regime after `N` consecutive strikes,
      and *why* that is no weaker than the TOFU baseline (former member returns to the same regime a
      never-member is already in).
- [ ] Run `yarn --cwd packages/db-core test 2>&1 | tee /tmp/dbcore-test.log` and confirm green.

## Tripwire / follow-on (do NOT file as a ticket from here)

The root-cause fix is **drop-the-lock-on-demotion**: have the host forget a coord's verifier entry when it
stops serving that coord, so a former-member coord is never locked in the first place. It needs (a) a
`MembershipVerifier.forget(coord)` / downgrade API and (b) an engine-reclaim / demotion signal the host does
not emit today (`createCoordRegistry` never evicts — host.ts:765-767 NOTE). When engine reclaim lands, prefer
that over (or alongside) the strike-counter heuristic. Record this as a `NOTE:` code comment at the
`onCertPublished`/`verifier.cache()` seam in host.ts and mention it in the review findings index — it is
conditional on reclaim infrastructure that does not exist yet, so it is a tripwire, not queued work.
