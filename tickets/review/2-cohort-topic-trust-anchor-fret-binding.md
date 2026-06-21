description: Review the new check that rejects forged cohort-membership certificates by comparing them against who the peer-routing ring actually says owns that slot, and the empty-by-default seam for seeding the network's initial trusted cohorts.
prereq: cohort-topic-trust-anchor-core
files:
  - packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts (new — the FRET-ring direct anchor)
  - packages/db-p2p/src/cohort-topic/host.ts (anchor + genesisTrustRoots wired into createMembershipVerifier ~L690; genesisTrustRoots option ~L214)
  - packages/db-p2p/test/cohort-topic/fret-trust-anchor.spec.ts (new — 10 unit cases)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (new test 7 — forged-cert promote path + TOFU control)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (the gate this binds into — unchanged)
  - packages/db-core/src/cohort-topic/ports.ts (IMembershipTrustAnchor / TrustRoot — unchanged)
  - docs/cohort-topic.md (§Membership source, §Bootstrapping trust)
difficulty: hard
----

# Review: FRET-ring direct trust anchor + genesis-root seam (db-p2p)

## What this delivers (plain terms)

A cohort-membership certificate (`MembershipCertV1`) is self-signed by the cohort it claims to be. Proving
it is *internally* well-formed (a `≥ minSigs` quorum signed its own member list) does **not** prove that key
set is the *legitimate* cohort for the ring coordinate — an adversary holding `k − x` keys can mint a
self-consistent cert for a coord it does not own. `cohort-topic-trust-anchor-core` added the db-core trust
gate (`IMembershipTrustAnchor`, trust roots, attestation chain) but shipped only `noAuthorityTrustAnchor`
(every coord `"unknown"` → interim trust-on-first-use). **This ticket binds the real direct anchor** to the
one authority FRET exposes today — the ring's local two-sided cohort assembly — so a forged cert on a coord
the node serves is actually rejected, and adds the (empty-by-default) seam for seeding genesis trust roots.

## Design landed (`FretTrustAnchor.directAnchor(cert, tier)`)

p2p-fret 0.5.0 has **no transferable stabilization proof** (`cert.fretAttestation` is never populated), so the
only coord→keyset authority is `assembleCohort(coord, wants)`, which is **local** — correct only for coords
the node's routing table covers (coords it serves; the amplification-exposed `promote`-handler path).

- **Committed tiers (T0/T1)** → `"unknown"` — the tx-log commit cert is their authority, not the FRET ring;
  this composes with (does not fight) the future tx-log anchor. (`maxCommittedTier`, default
  `DEFAULT_MAX_NO_POW_TIER = 1`, mirrors `createMembershipSourceRouter`'s `isCommittedTier`.)
- **No local authority** → `"unknown"`: a partition (`detectPartition()`), a cold/short table
  (`assembleCohort` yields `< k`), or a **distant** coord the node is not itself part of (`self ∉
  assembleCohort(coord, k)`). The db-core gate then falls through to chain / interim TOFU → **no regression**.
- **Covered coord** → compare the cert's **signing quorum** (`cert.signers`) against the ring view, widened
  to `k + churnSlack` (default 2) for stabilization skew:
  - quorum ⊆ slack-widened ring → `"anchored"`;
  - quorum **wholly disjoint** from the ring → `"rejected"` (forgery, fatal even if self-consistent);
  - partial overlap beyond the slack → `"unknown"` (ambiguous churn — deliberately do **not** over-reject).

**Why anchoring on `signers` (not member-set equality) is sound:** a forged cert must sign with
adversary-controlled keys (else the multisig fails), and those keys are not in the ring cohort → disjoint →
rejected. A legit quorum is real cohort members → in the ring (within slack) → anchored. Full-set equality
would be brittle across churn; the quorum-subset rule keeps teeth without it.

**Genesis-root seam:** `createCohortTopicHost({ genesisTrustRoots })` → `createMembershipVerifier({ trustRoots })`.
Empty by default (network-config; validated out-of-band before seeding) — **no fake roots invented**. With
none configured, behavior is identical to before the seam.

## How to validate / exercise

- `yarn build` (tsc) in `packages/db-p2p` — clean (exit 0).
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/fret-trust-anchor.spec.ts" "test/cohort-topic/live-tier.spec.ts" --reporter spec` → **17 passing**.
  - `fret-trust-anchor.spec.ts` (10): anchored / rejected / skew-within-slack / partial-overlap→unknown /
    distant(self∉)→unknown / cold(<k)→unknown / partition→unknown / committed-tier→unknown / both FRET tiers /
    undecodable-signer totality.
  - `live-tier.spec.ts` test 7 (**headline**): a forged unrelated-keyset cert for a coord the node serves,
    fed through a real `FretTrustAnchor` + `createMembershipVerifier` + `verifyAndApplyNotice` (the promote
    path) → `"untrusted"`, promotion **not** applied. **Control:** the same forgery through a verifier with
    *no* anchor (db-core default) is TOFU-`"applied"` — proving the rejection is the anchor's doing.
  - Existing live-tier tests 1–6 (tier-0 / committed) still pass — anchor returns `"unknown"` at T0, so no
    behavior change on those flows.

## Reviewer focus / known gaps (treat tests as a floor)

1. **Coverage predicate.** Authority = `self ∈ assembleCohort(coord, k)` **AND** `length ≥ k`. This is the
   chosen reading of the ticket's "populated neighborhood the node covers". Scrutinize: in a large *sparse*
   table could `self` land in the top-`k` of a coord it does not truly cover (spurious authority → a wrong
   ring view → a wrongful `"rejected"` of a legit distant cert)? The `length ≥ k` guard mitigates but does
   not formally exclude this. (Real `FretService` keeps a dense neighborhood around served coords, so in
   practice a served coord is dense and a distant coord omits self — but a hostile/degenerate table is worth
   a thought.)
2. **Heuristic thresholds.** `churnSlack = 2`, and the disjoint→reject / partial→unknown split, are
   engineering choices, not a derived churn bound. Consider an adversary who pads the cert's *members* with
   some real ring members but still **signs** with a quorum it controls: signers stay disjoint → still
   rejected (good). But a quorum mixing a few real members (whose keys the adversary cannot have, so it can't
   actually produce those chunks) is not reachable — confirm that reasoning holds.
3. **Integration faithfulness.** The headline test builds a standalone verifier mirroring the host wiring
   (the host does not expose its `FretMembershipSource` for forged-cert injection, and `/membership` only
   serves a node's own published cert). It uses the *real* `FretTrustAnchor`, `createMembershipVerifier`, and
   `verifyAndApplyNotice` over the mesh's real FRET facade — but not the full libp2p socket fetch. A reviewer
   may want an over-the-wire variant (would need a host test seam to inject/serve an arbitrary cert).
4. **`detectPartition` is best-effort.** Real `FretService.detectPartition()` needs ≥10 observations +
   confidence ≥ 0.3; the mock mesh facade omits it (optional in `FretRingView`). So the partition guard is
   only meaningfully exercised by the unit stub, not the live mesh.
5. **Committed-tier coupling.** `maxCommittedTier` (1) must track `membership/source.ts`'s hard-coded
   `isCommittedTier (tier ≤ 1)`. If that split ever changes, both must move together — currently only a
   shared `DEFAULT_MAX_NO_POW_TIER` constant links them by convention.
6. **Genesis roots: seam only.** No concrete genesis-cohort derivation (intentionally — network-config).
   Follow-ons remain: `cohort-topic-trust-anchor-fret-stabilization-proof` (transferable proof so a
   *non-covering* node can anchor distant T2/T3) and `cohort-topic-trust-anchor-txlog-committed-binding`
   (the T0/T1 anchor). Distant first-sight T2/T3 and all T0/T1 stay TOFU until those land — documented in
   `docs/cohort-topic.md` §Bootstrapping trust.

## Note on the full-suite run

Full `db-p2p` suite: **958 passing, 30 pending, 1 failing**. The one failure
(`reactivity / mesh — slow-subscriber isolation`) is a **CPU-load timeout in an unrelated subsystem** — it
passes in isolation in 7.4 s, and the reactivity verify path caches its cert (`cacheTailCert`), which bypasses
the trust gate entirely, so this anchor is never on that path. Flagged in `tickets/.pre-existing-error.md`.
