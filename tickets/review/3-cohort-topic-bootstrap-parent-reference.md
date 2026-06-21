description: A node can now let a new topic start up for free (no proof-of-work) when it presents a signed pointer to a parent topic the node can confirm already exists in the network — replacing the temporary reputation-based stand-in.
files:
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts (NEW parentRefSigningImage)
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts (NEW — verifier + existence view)
  - packages/db-p2p/src/cohort-topic/membership-source.ts (NEW has(coord))
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy + parentTopicView wiring)
  - packages/db-p2p/src/libp2p-node-base.ts (committed-reader deferral note)
  - packages/db-p2p/test/cohort-topic/bootstrap-parent-reference.spec.ts (NEW)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (parent-ref cases; interim T0 referee test replaced)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 impl note, §Membership source)
----

# Review: cohort-topic real parent-reference bootstrap-evidence verifier (db-p2p)

## What landed

The interim **reputation stand-in** for `verifyParentReference` (left by
`cohort-topic-bootstrap-evidence-verifiers`) is replaced with a **real signed-parent-reference verifier**.
A cold-start `bootstrap: true` register can now carry `parentRef = { parentTopicId, sig }`, and a
configured cohort admits it iff:

1. **Signed reference (anti-replay).** The participant peer-key-signed a new db-core
   `parentRefSigningImage(reg, parentTopicId)` — the bound tuple `(topicId, tier, participantCoord,
   timestamp)` **extended with `parentTopicId`**, under a distinct discriminator tag
   (`"BootstrapParentRefV1"`). So a reference minted for one `(topic, tier, peer, time, parent)` cannot be
   lifted onto another register, and it cannot collide with a `bootstrapBoundImage` reputation/PoW
   signature (domain separation). Verified against the participant's own peer key → self-contained even in
   key-less mode.
2. **Existence.** The parent topic must exist in locally-available state, via a **synchronous, injectable**
   `BootstrapParentTopicView.exists(parentTopicId, tier)` — never a network dial (a round-trip inside an
   admission gate is itself a DoS amplifier). The verifier is **total** (any decode/verify failure → `false`).

A **self-referential** `parentTopicId == topicId` is rejected (a topic cannot vouch for its own existence).

### Existence view (the design decision)

`createDefaultParentTopicView({ membershipSource, addressing, committedReader?, maxNoPowTier? })` is
tier-routed exactly like the membership-source router:

- **T2/T3** → `FretMembershipSource.has(coord_0(parentTopicId))` (new synchronous read over the in-memory
  `byCoord` cache). A cached `MembershipCertV1` means a cohort genuinely serves the parent → **real today.**
- **T0/T1 (committed tiers)** → an optional `committedReader`; **fail closed without one.** A FRET-cached
  cert must NOT vouch for committed-tier existence (committed-tier integrity).

The host builds the default from its `membershipSource` + `addressing`; `antiDos.parentTopicView` is a test
seam that overrides it. The gate becomes "configured" (and thus runs the real verifier) the moment any
`reputation` view / `bootstrapEvidence` override is supplied; an **entirely unconfigured host stays
permissive-but-logged** (preserves `service.spec.ts` / `live-tier` / scale / reactivity-mesh flows that
bootstrap tier-0 without evidence).

## How to validate

- **Unit (`bootstrap-parent-reference.spec.ts`, 12 cases):** valid signed ref + existing parent → admit;
  bad/wrong-key sig → reject; sig over the plain `bootstrapBoundImage` (not the parentRef image) → reject
  (domain separation); valid sig + unknown parent → reject; absent/PoW-only/malformed envelope → reject
  (no throw); replay across topic / participant / timestamp / **parentTopicId** → reject; self-referential
  → reject; tier passed through to the view. Default-view: FRET-cached cert satisfies T2 but not T0/T1
  (integrity); tier routing consults committed vs FRET via two distinct stubs; a supplied `committedReader`
  is honored.
- **Host (`host-antidos-coldstart.spec.ts`):** a configured host admits a T0 bootstrap with a valid
  parent-ref to a known parent and denies an unknown one; denies a bad-signature parent-ref; admits a T2
  bootstrap via a valid parent-ref alone (the `PoW || reputation || parent-ref` disjunction) and denies an
  unknown-parent T2; the bare permissive tier-0 path still passes.
- **Commands:** `yarn workspace @optimystic/db-p2p test` (945 passing; the only 2 failures are the
  pre-existing flaky `reactivity/mesh-cold-to-hot.spec.ts` CPU-timeout — see below).
  `yarn workspace @optimystic/db-p2p build` → OK. `yarn workspace @optimystic/db-core build` → OK.
  db-core `bootstrap-evidence-envelope.spec.ts` → 36 passing.

## Known gaps / honest flags for the reviewer

- **T0/T1 has no committed backing yet → fails closed on real nodes.** No coord-keyed
  committed-membership index exists (the tx-log commit certificate is keyed by *action*, not `coord_0`), so
  `libp2p-node-base.ts` wires **no** `committedParentTopicReader`. Net effect on a production node today:
  **T0/T1 parent-ref existence always fails closed; T2/T3 parent-ref is fully real.** This is intentional
  (committed-tier integrity) and documented in code + `docs/cohort-topic.md`, but it means the headline
  "no-PoW T0/T1 path" is not yet end-to-end functional on a real node — a reviewer should confirm this is
  the accepted interim posture. The dedicated committed backing (and the richer "the parent's committed
  record names *this* child" check) is the existing backlog ticket `cohort-topic-parent-ref-tx-log-content`.
- **node-base touch is a documentation/seam note, not functional wiring** — for the reason above. The host
  option `committedParentTopicReader` exists so a future index plugs in without API churn; an operator can
  also pass one via `cohortTopic.host.committedParentTopicReader`.
- **`parentRefSigningImage` has no dedicated db-core unit test** — its anti-replay/domain-separation
  behavior is covered transitively by the db-p2p verifier spec (all replay axes + the
  plain-bootstrapBoundImage rejection). A reviewer may want a direct db-core unit test as a floor.
- **Existence is "a cohort serves the parent," not "the parent anchors this child."** By design (the
  richer content check is the follow-on). A participant could reference an unrelated-but-existing T2/T3
  parent to satisfy the gate today.
- **Pre-existing failure:** `reactivity/mesh-cold-to-hot.spec.ts` times out under full-suite load (already
  triaged once in commit `8298b12`, which bumped its timeout to 30s). It is outside this diff — the
  reactivity mesh runs bootstrap-permissive (`configured === false`), so `verifyParentReference` is byte-for-
  byte unchanged there. Recorded in `tickets/.pre-existing-error.md`.

## Suggested review focus

- Domain separation / anti-replay of `parentRefSigningImage` vs `bootstrapBoundImage` — confirm no
  signature from one path can be replayed into the other (the verifier spec asserts this; sanity-check the
  image construction).
- The "configured" predicate in `createBootstrapEvidencePolicy`: confirm an unconfigured host stays
  permissive and a configured one fails closed on every unfilled verifier (so a banned referee can't slip
  the T2/T3 disjunction now that parent-ref is real, not a referee stand-in).
- Whether T0/T1-fail-closed-on-real-nodes is the right interim posture, or whether node-base should wire
  the membership cache as an interim committed backing (the trade-off: it would relax committed-tier
  integrity — a FRET cert vouching for committed existence — which this implementation deliberately avoids).
