description: Reviewed the new guard that throws out forged cohort-membership certificates by checking them against who the peer-routing ring says actually owns that slot, plus the empty-by-default hook for seeding a network's initial trusted cohorts.
prereq: cohort-topic-trust-anchor-core
files:
  - packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts (the FRET-ring direct anchor)
  - packages/db-p2p/src/cohort-topic/host.ts (anchor + genesisTrustRoots wired into createMembershipVerifier ~L699; genesisTrustRoots option ~L216)
  - packages/db-p2p/test/cohort-topic/fret-trust-anchor.spec.ts (12 unit cases — 2 added in review)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (test 7 — forged-cert promote path + TOFU control)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (the gate this binds into — unchanged)
  - packages/db-core/src/cohort-topic/ports.ts (IMembershipTrustAnchor / TrustRoot — unchanged)
  - docs/cohort-topic.md (§Membership source, §Bootstrapping trust)
----

# Complete: FRET-ring direct trust anchor + genesis-root seam (db-p2p)

## What landed

`FretTrustAnchor.directAnchor(cert, tier)` binds the db-core membership trust gate's *direct anchor* port
(`IMembershipTrustAnchor`, added by `cohort-topic-trust-anchor-core`) to the one coord→keyset authority FRET
exposes today — the ring's local two-sided `assembleCohort` assembly. For a **covered** T2/T3 coord (a
populated, non-partitioned neighbourhood the node is itself part of), the cert's **signing quorum**
(`cert.signers`) is compared against the ring view widened by a small `churnSlack` (default 2):

- quorum ⊆ slack-widened ring → `"anchored"`;
- quorum **wholly disjoint** → `"rejected"` (a forgery, fatal even though self-consistent);
- partial overlap beyond slack → `"unknown"` (ambiguous churn — defer, don't over-reject).

Committed tiers (T0/T1), distant coords (`self ∉ assembleCohort`), cold tables (`< k`), and a detected
partition all return `"unknown"`, so the db-core gate falls through to chain/TOFU — strictly no regression.
`createCohortTopicHost({ genesisTrustRoots })` threads genesis trust roots into
`createMembershipVerifier({ trustRoots })`, empty by default (network-config; no fabricated roots).

## Review findings

### Scope checked

Read the full implement diff (`5d7fecf`) with fresh eyes before the handoff, then traced every seam the
change binds into: the db-core verifier gate (`membership/verifier.ts`), the trust ports (`ports.ts`), the
membership-source router (`membership/source.ts`), the `verifyAndApplyNotice` promote path (`host.ts`), and
the full signer-byte chain (`threshold-crypto.ts` → `peer-sig.ts` → `peer-codec.ts`). Docs
(`docs/cohort-topic.md`) read line-by-line against the code.

### Correctness — the critical binding (verified sound)

The anchor decodes `cert.signers` via `bytesToPeerIdString(b64urlToBytes(s))` and compares the resulting
strings against `assembleCohort`'s output. Confirmed this round-trips: the real cohort signer bytes are the
**UTF-8 of the canonical peer-id string** (`peerIdToBytes`), produced by `FretCohortThresholdCrypto.assemble`
and verified by `verifyPeerSig` (which parses that same peer-id string to recover the embedded Ed25519 key),
while `assembleCohort` returns peer-id strings. So a legit quorum's signers always land in the ring view and
a forged (adversary-key) quorum is always disjoint — the rule has teeth and does not false-reject legit
certs. **No bug.**

Verified the check ordering that makes the anchor's `try/catch` totality safe rather than an attack surface:
db-core's `certIsTrusted` runs `certIsSelfConsistent` **before** the direct anchor, so by the time the anchor
sees a cert its signers are already proven to be real peer-key signatures (valid UTF-8 peer-ids). The
undecodable-signer / empty-quorum branches are therefore defensive, not reachable downgrade vectors.

### Aspect scrutiny

- **Wiring (SPP/DRY):** exactly one `createMembershipVerifier` call site in db-p2p, correctly wired with both
  `anchor` and `trustRoots`. `tsc` confirms `FretService` structurally satisfies the narrow `FretRingView`
  port — db-core stays FRET-free, as the layering rule requires.
- **Resource cleanup / error handling:** anchor is pure and total (no I/O, never throws — all decode failures
  → `"unknown"`). `detectPartition?.()` optional-chains cleanly when the ring view omits it.
- **Type safety:** `genesisTrustRoots?: readonly TrustRoot[]` threads through unchanged; default `[]`.
- **Double `assembleCohort` call** (k, then k+slack) is a deliberate, defensively-correct choice — truncating
  a k+slack two-sided assembly to k is *not* guaranteed equal to a direct k-assembly under the two-sided
  ordering, so recomputing is safer than slicing. Not a defect; left as-is.

### Found & fixed inline (minor)

- **Untested branches hardened.** Added 2 unit cases to `fret-trust-anchor.spec.ts` (now 12, all passing):
  (1) **empty signing quorum** → `"unknown"` (the `signers.length === 0` defensive guard, previously
  unexercised); (2) **default options** path — constructing the anchor without `churnSlack`/`maxCommittedTier`
  now exercises the `?? DEFAULT_CHURN_SLACK` / `?? DEFAULT_MAX_NO_POW_TIER` fallbacks (every prior test passed
  `churnSlack` explicitly), asserting the default slack still anchors a k+1 skew and the default committed
  tier still defers T1 while rejecting a disjoint quorum at T2.

### Confirmed acceptable (documented limits — no action)

- **Spurious-authority edge (handoff gap #1):** a hostile/degenerate routing table could in principle place
  `self` in the top-k of a coord it does not truly own, risking a wrongful `"rejected"` of a legit distant
  cert. Bounded: a wrongful reject is an *availability* degradation (the message is dropped → a possibly-legit
  promotion isn't applied), not a safety break, and only under table poisoning (a separate threat). The
  prepend-self quirk in `cohortAround` makes this strictly *more* conservative, not less. Properly disclosed.
- **Partial-compromise reasoning (handoff gap #2):** confirmed a quorum mixing real ring members with
  adversary keys requires the adversary to actually hold those real keys (else self-consistency fails);
  partial overlap → `"unknown"` → TOFU on an untrusted coord, which is no worse than pre-anchor behaviour. The
  anchor only *adds* the wholly-disjoint `"rejected"` teeth. Sound.

### Major findings filed as new tickets

**None.** No correctness, safety, or layering defect found that warrants a new fix/plan ticket. The remaining
follow-ons are pre-existing, already-tracked design extensions, not defects in this work:
`cohort-topic-trust-anchor-fret-stabilization-proof` (transferable proof for distant T2/T3) and
`cohort-topic-trust-anchor-txlog-committed-binding` (the T0/T1 anchor). Distant first-sight T2/T3 and all
T0/T1 remain TOFU until those land — documented in `docs/cohort-topic.md` §Bootstrapping trust.

### Validation run

- `yarn build:db-core` + `yarn build:db-p2p` (tsc) — clean (exit 0).
- `fret-trust-anchor.spec.ts` + `live-tier.spec.ts` → **19 passing** (10 → 12 anchor unit + 7 live-tier).
- Lint: not configured (root `lint` is a no-op) — nothing to run.
- **Pre-existing failure (not mine):** the full db-p2p suite's lone failure
  (`reactivity / mesh — slow-subscriber isolation`) is a CPU-load timeout under full-suite contention —
  **verified it passes in isolation (10.4 s)**. It is outside this diff (reactivity's verify path caches its
  cert, bypassing the trust gate entirely). The implement stage already flagged it via
  `tickets/.pre-existing-error.md`, which the runner has since consumed; no re-flag needed.

## End
