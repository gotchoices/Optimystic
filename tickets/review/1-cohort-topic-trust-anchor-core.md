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
difficulty: hard
----

# Review: trust-anchor framework for MembershipCertV1 (db-core)

## What this implements

The db-core half of the membership-cert trust-anchor fix. Before this, `CachingMembershipVerifier`
accepted any refetched `MembershipCertV1` on **self-consistency** alone (its own threshold sig is a
`≥ minSigs` quorum over its own members), which proves well-formedness but not that the key set is the
legitimate cohort for the coord — a `k − x`-key adversary could mint a self-consistent forgery. The
verifier now gates a (re)fetched cert through `certIsTrusted(cert, tier)`: it must be self-consistent
**AND** anchored by a trust root, a direct anchor, or an attestation chain, else it falls to an interim
TOFU fallback (first-use only).

### Surface added
- `ports.ts`: `TrustAnchorVerdict` (`"anchored" | "rejected" | "unknown"`), `IMembershipTrustAnchor`
  (`directAnchor(cert, tier)`), `TrustRoot` (`{coord, epoch, members}` raw bytes), and the default
  `noAuthorityTrustAnchor` (every coord `"unknown"`). Exported via `cohort-topic/index.ts`.
- `wire/types.ts` + `validate.ts`: optional, backward-compatible `prevEpoch` / `rotationSig` /
  `rotationSigners` on `MembershipCertV1`, validated **all-or-nothing** (a partial set is a
  `CohortWireError`). Not part of `membershipCertSigningPayload` (`sig/payloads.ts` unchanged).
- `verifier.ts`: `anchor?` / `trustRoots?` deps; `certIsTrusted`; the trusted-cache invariant; `tier`
  threaded into `loadFrom`. `RefetchBound` / freshness logic untouched.
- `publisher.ts`: optional `rotation?: RotationAttestation` on `onStabilized` / `tick` (attached
  verbatim; default path emits none). **Production** of attestations is out of scope (db-p2p ticket).

### Trust gate order (in `certIsTrusted`)
1. not self-consistent → **reject**
2. trust-root match (coord + epoch + order-independent member-set) → **trusted** (before the anchor, so a
   configured root is authoritative)
3. `directAnchor`: `"anchored"` → trusted; `"rejected"` → **reject (fatal)**; `"unknown"` → continue
4. rotation attestation present + valid against a **trusted** predecessor at `prevEpoch` (and not
   self-referential) → **trusted**
5. fallback — **the key design decision, see below.**

## ⚠️ Design decision the reviewer must validate (the "lock")

The ticket's prose was ambiguous about whether the interim TOFU fallback *always* applies on `"unknown"`,
or only on first use. I implemented the **lock** model: the fallback (`fallbackTrust`) accepts a
self-consistent cert via TOFU **only when the coord holds no trusted cert yet**. Once a coord is
trust-established (root / direct-anchor / chain / `cache`), an un-anchored cert for it is **rejected** —
no silent TOFU downgrade.

Rationale (why I chose this over "TOFU always applies on unknown"):
- It is the only reading under which the source ticket's claim *"Epoch rotations: protected by the
  attestation chain once any cert for the coord is trusted"* is literally true.
- It makes the **forged-rotation** security test return `untrusted` with the anchor returning `"unknown"`
  (a forged rotation off a *trusted* predecessor is dropped). Without the lock, a forged rotation on an
  unknown-anchor coord would be TOFU-accepted, and the chain would add no observable protection.
- It reconciles the edge cases: a *missing / TOFU-only* predecessor → coord not locked → cert falls to
  TOFU (matches "chain predecessor missing → falls to TOFU"); a *trusted* predecessor + bad rotation →
  coord locked → rejected (matches "forged rotation → not trusted").

**Consequence to scrutinize (liveness):** on a coord trusted via a genesis root or a prior chain, on a
tier with **no** direct-anchor authority, a *legitimate* membership rotation that arrives **without** a
rotation attestation will be marked `untrusted` (the node is "stuck" on the old trusted cert until it
re-anchors). This is acceptable under the interim model — legit rotations are meant to carry attestations
(db-p2p `cohort-topic-trust-anchor-rotation-production`) — and FRET-covered coords re-anchor via the
direct anchor, and TOFU-only coords are never locked. But it is a real behavior change; confirm it is the
intended trade-off. Documented in the `verifier.ts` header and `docs/cohort-topic.md` §Bootstrapping trust.

## ⚠️ One existing test was modified (not just added)

`membership.spec.ts` → "stale cached cert triggers exactly one refetch, then succeeds" previously seeded
the stale cert via `v.cache(...)`. Under the new semantics `cache()` marks a cert **trusted** (a node
trusts a cert it itself published, so it can anchor the next rotation), which would trust-lock the coord
and (correctly) reject the un-anchored `GOOD` refetch. The test now seeds the stale cert via
`source.current()` (TOFU), preserving the *liveness* behavior it checks (stale cached → one refetch →
verify). Confirm this re-interpretation is acceptable; the `currentCalls` assertion changed from 0 → 1.

## How to validate (use cases / tests)

`yarn build` and `yarn test` are green in db-core (**962 passing, 0 failing**); db-p2p `yarn build` is
also green (changes are backward-compatible — all new params optional, `verifyMessage` signature
unchanged). Run the focused suites:

```
cd packages/db-core
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/membership.spec.ts" "test/cohort-topic/wire.spec.ts" --reporter spec
```

Security / behavior cases covered (`membership.spec.ts` → "membership trust anchoring"):
- forged unrelated-keyset cert + anchor `"rejected"` → `untrusted` (headline).
- legit cert + anchor `"anchored"` → `verified`.
- unknown coord + anchor `"unknown"`, self-consistent → `verified` (TOFU, no regression).
- `"rejected"` overrides the TOFU that `"unknown"` would allow (same forged cert, verdict flipped).
- legit epoch rotation (trusted predecessor via `cache`, valid `rotationSig`, anchor `"unknown"`) → `verified`.
- forged rotation (trusted predecessor, `rotationSig` by wrong keys, anchor `"unknown"`) → `untrusted` (the lock).
- trusted-cache invariant: the **same** forged rotation off a merely-TOFU predecessor stays in the TOFU
  regime (`verified`) — the contrast with the previous case *is* the proof that trust propagates only
  from a trusted predecessor. (Read the comment — this `verified` is the documented interim limit, not a regression.)
- chain-trusted successor becomes a trusted anchor (forged grandchild then rejected) — uses a queued source.
- trust-root match by (coord, epoch, member-set); swapped keyset on a genesis coord → not a root → `untrusted`.
- self-referential rotation (`prevEpoch === cohortEpoch`) → rejected.

Wire (`wire.spec.ts` → "MembershipCert rotation attestation"): full-attestation round-trip; legacy cert
(no rotation fields) decodes; all-or-nothing rejection of all 6 partial shapes; non-base64url
`prevEpoch`/`rotationSig`; non-array `rotationSigners`. Publisher: rotation attached verbatim when given,
none on the default path.

## Known gaps / where the tests are a floor (probe these)

- **No production wiring yet.** `host.ts` still constructs the verifier with no `anchor` / `trustRoots`,
  so in production *today* every coord is `"unknown"` → pure TOFU (no regression, **no new protection**).
  The teeth are latent until db-p2p `cohort-topic-trust-anchor-fret-binding` (prereq-chained, implement/2)
  binds the FRET anchor and seeds genesis roots. The chain path is exercised only by tests until db-p2p
  `cohort-topic-trust-anchor-rotation-production` produces attestations. This is by design (prereq chain),
  but means the headline attack is not yet closed on the live network from this ticket alone.
- **tier threading is untested end-to-end.** `tier` is passed to `directAnchor`, but the test
  `constAnchor` ignores it, so nothing asserts the anchor receives the same tier the router used. A
  tier-sensitive mock anchor test would harden the "binding is tier-scoped" claim.
- **RefetchBound × trust gate** is not exercised together (the rate-limit tests use TOFU certs). The two
  are orthogonal in the code, but a combined test (forged cert under a refetch bound) would confirm a
  `"rejected"` cert still counts as a refetch attempt for rate-limiting.
- **Concurrency:** `verifyMessage` is async over a plain `Map` cache; concurrent verifies for the same
  coord could interleave `loadFrom` → `byCoord.set`. Pre-existing shape, not addressed here.
- **`setEqualsArray` duplicate-safety:** hardened (both-direction set check) as defense-in-depth, though
  self-consistency already blocks duplicate-inflated member lists at realistic `minSigs`.
- **Overwrite semantics:** a `trusted` cert is never overwritten by an un-anchored fetch (the lock
  rejects it, so it is not cached); a `tofu` cert is latest-wins as before. Worth a second look that no
  path caches a `"reject"` cert (it should return `undefined` and leave the cache untouched).

## Follow-on tickets (already filed, not part of this review)
- `cohort-topic-trust-anchor-fret-binding` (implement/2, prereq on this) — binds `FretTrustAnchor` +
  seeds genesis roots; closes the forged-cert attack on FRET-covered coords.
- `cohort-topic-trust-anchor-rotation-production` — produces rotation attestations on the cohort side.
- `cohort-topic-trust-anchor-fret-stabilization-proof`, `...-txlog-committed-binding` (backlog) — close
  the remaining distant-T2/T3 and T0/T1 TOFU gaps.
