description: Wire the new "is this membership certificate from the right cohort?" check into the live network for the cases a node can actually judge, and seed the initial trusted cohorts so forged certificates get rejected where it matters most.
prereq: cohort-topic-trust-anchor-core
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createMembershipVerifier call ~L676; cohortAround ~L520)
  - packages/db-p2p/src/cohort-topic/membership-source.ts
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts
  - packages/db-p2p/test/cohort-topic/ (new fret-trust-anchor.spec.ts; live-tier.spec.ts)
  - docs/cohort-topic.md (§Bootstrapping trust, §Membership source)
difficulty: hard
----

# Bind the trust anchor to FRET ring agreement + seed genesis trust roots (db-p2p)

## Problem

`cohort-topic-trust-anchor-core` adds the db-core trust gate (`IMembershipTrustAnchor`, trust roots,
attestation chain) but ships only a `noAuthorityTrustAnchor` default — so until db-p2p binds a real
anchor, every coord is `"unknown"` and the gate stays at interim TOFU. This ticket binds the **direct
anchor** to the one coord→keyset authority available today and seeds the genesis trust roots, so the
forged-cert attack is actually rejected on the path the source ticket calls out.

## What authority is available (resolved)

p2p-fret 0.5.0 exposes **no transferable stabilization proof** — there is no membership-cert/attestation
API; the `fretAttestation` field is never populated (db-p2p `host.ts` builds `CohortSnapshot` without
it). The only coord→keyset authority FRET offers is `FretService.assembleCohort(key, wants)` /
`expandCohort` — the ring's two-sided closest-`k` selection — which is **local**: it answers correctly
only for coords the node's routing table covers (i.e. coords the node is near / serves). This is exactly
the `promote`-handler path (`verifyAndApplyNotice` verifies against `target.servedCoord`, a coord the
node serves) — the amplification-exposed path named in the trust-anchoring problem.

So the binding gives FRET-covered coords full anchoring and returns `"unknown"` elsewhere (the db-core
fallback then keeps distant verification at no-regression TOFU).

## Design

### `FretTrustAnchor` (new, db-p2p) implementing `IMembershipTrustAnchor`

`directAnchor(cert, tier)`:

- Decode `cert.members` (base64url PeerId strings) into the FRET id form and `cohortCoord` into ring
  bytes.
- Ask FRET whether it has local authority for `cohortCoord`. A node has authority when the coord falls
  within its routing-table coverage — concretely, when `assembleCohort(coord, wants)` returns a full
  `k`-sized cohort drawn from a populated neighborhood (not a near-empty/partition result). If FRET
  cannot cover the coord (cold table, distant coord), return `"unknown"`.
- Compute the authoritative cohort `expected = assembleCohort(coord, k)` (with `expandCohort` to reach
  the cert's `k` if needed). Compare `expected` against the cert's first-`k` / quorum-relevant members
  as a set:
  - members agree with the ring selection (allowing the documented stabilization skew — the cert's
    `signers` quorum must be ⊆ the ring-expected set, see below) → `"anchored"`;
  - members are a *known-different* set (the ring says a disjoint/quorum-incompatible cohort owns this
    coord) → `"rejected"`;
  - genuinely ambiguous within churn tolerance → `"unknown"` (do not over-reject on transient skew).
- **Skew tolerance.** Membership stabilizes slightly behind the live ring (the cert is published at
  stabilization; `assembleCohort` reflects the current table). Anchor on the **quorum**, not exact
  equality: require the cert's `signers` (the `≥ minSigs` that actually signed) to be a subset of the
  ring-expected cohort (optionally `expandCohort`-widened by a small slack). A cert whose signing quorum
  cannot be a subset of any reasonable ring view of the coord is a forgery → `"rejected"`. Pick and
  document the slack (suggest: expand to `k + churn_slack`, `churn_slack ≈ 2`); justify in the ticket.

### Seed genesis trust roots

The participant's initial trust roots are the genesis-block-related cohorts, validated against the
genesis block hash known out-of-band. Add a host/config seam (`genesisTrustRoots?: TrustRoot[]` or a
`genesisBlockHash` + resolver) that the host passes to `createMembershipVerifier({ ..., trustRoots })`.
For this ticket the seam + plumbing is the deliverable; the concrete genesis-cohort derivation is
network-config (document the expected shape and leave a typed, empty-by-default config point if the
genesis cohort set is not yet defined for the test networks — do **not** invent fake roots).

### Wire it in

- `host.ts` (~L676): pass `anchor: new FretTrustAnchor(fret, { k, churnSlack })` and the seeded
  `trustRoots` into `createMembershipVerifier`.
- Keep `minSigs`, the membership router, and the `RefetchBound` promote-path call unchanged.

## Edge cases & interactions

- **Cold / partitioned routing table** — `assembleCohort` returns `< k` or near-empty → `"unknown"`,
  never `"rejected"` (don't reject legit certs during bootstrap/partition; FRET's `detectPartition()`
  may help gate).
- **Self in cohort** — the node is itself a member of the coord's cohort: ring selection includes self;
  ensure the comparison matches the cert's representation (db-p2p prepends/dedups self when building its
  own snapshot — `cohortAround`). Reuse the existing peer-id byte/string codec (`peer-codec.ts`) so the
  set compare is apples-to-apples.
- **Stabilization skew** — legit cert lags the live ring by a few members; the quorum-subset rule with
  bounded slack must accept it (test a 1–2 member rotation) while still rejecting a disjoint keyset.
- **Forged cert on a covered coord** — adversary mints a self-consistent cert for a coord this node
  serves with an unrelated keyset → ring says a different cohort owns it → `"rejected"` → verifier
  returns `"untrusted"` (the headline end-to-end test on the `promote` path).
- **Distant coord** — reactivity tail coord the node is nowhere near → `"unknown"` → db-core TOFU
  fallback → no regression (legit notifications still verify).
- **tier routing** — T0/T1 route to the committed source; `FretTrustAnchor` should return `"unknown"`
  for committed tiers (its authority is the FRET ring, not the tx-log) so it composes with — not
  fights — the future tx-log anchor. Confirm the tier→source routing is unaffected.
- **Genesis roots absent** — empty `trustRoots` must behave exactly as today (no roots = chain bottoms
  out at direct anchor / TOFU); the network must not break when no genesis cohort is configured.

## Key tests (db-p2p)

- `fret-trust-anchor.spec.ts`: over a small in-memory ring/digitree, a cert whose members match the ring
  cohort → `"anchored"`; a disjoint keyset on the same coord → `"rejected"`; a coord outside the table →
  `"unknown"`; a 1–2 member stabilization skew within slack → `"anchored"`.
- `live-tier.spec.ts` (extend): a forged `MembershipCertV1` served over `/membership` for a coord the
  verifying node serves is rejected by `verifyAndApplyNotice` (`promote` path) — the multisig is
  self-consistent but the keyset is unrelated → `"untrusted"`/notice dropped.
- regression: existing live-tier acceptance (legit promote/demote/membership) still passes with the
  anchor wired; distant reactivity verification unaffected.
- `yarn build` + `yarn test` green for db-p2p (and db-core unchanged).

## TODO

- Implement `FretTrustAnchor` over `FretService.assembleCohort`/`expandCohort` + the peer-id codec, with
  the documented quorum-subset + bounded-slack anchoring rule and the cold-table/partition `"unknown"`
  guard.
- Add the `genesisTrustRoots` (or `genesisBlockHash` + resolver) config seam to the host and thread it
  into `createMembershipVerifier`.
- Wire `anchor` + `trustRoots` into the `createMembershipVerifier` call in `host.ts`.
- Tests above; update `docs/cohort-topic.md` §Bootstrapping trust + §Membership source to record the
  FRET-ring direct anchor, the genesis-root seam, and the documented distant/T0-T1 limits.
