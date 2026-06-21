description: A node can now let a new topic start up for free (no proof-of-work) when it presents a signed pointer to a parent topic the node can confirm already exists in the network — replacing the temporary reputation-based stand-in.
files:
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts (parentRefSigningImage + ParentRefEvidenceV1 JSDoc)
  - packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts (parentRefSigningImage floor cases)
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts (verifier + default existence view)
  - packages/db-p2p/src/cohort-topic/membership-source.ts (has(coord))
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy + parentTopicView wiring)
  - packages/db-p2p/src/libp2p-node-base.ts (committed-reader deferral note)
  - packages/db-p2p/test/cohort-topic/bootstrap-parent-reference.spec.ts
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts
  - docs/cohort-topic.md
----

# Complete: cohort-topic real parent-reference bootstrap-evidence verifier (db-p2p)

## What landed

The interim **reputation stand-in** for `verifyParentReference` (left by
`cohort-topic-bootstrap-evidence-verifiers`) is replaced with a **real signed-parent-reference verifier**.
A cold-start `bootstrap: true` register can carry `parentRef = { parentTopicId, sig }`, and a configured
cohort admits it iff:

1. **Signed reference (anti-replay).** The participant peer-key-signed the new db-core
   `parentRefSigningImage(reg, parentTopicId)` — the bound tuple `(topicId, tier, participantCoord,
   timestamp)` extended with `parentTopicId`, under a distinct discriminator tag (`"BootstrapParentRefV1"`).
   A reference minted for one `(topic, tier, peer, time, parent)` cannot be lifted onto another register and
   cannot collide with a `bootstrapBoundImage` reputation/PoW signature (domain separation). Verified against
   the participant's own peer key → self-contained even in key-less mode.
2. **Existence.** The parent topic must exist in locally-available state, via a synchronous, injectable
   `BootstrapParentTopicView.exists(parentTopicId, tier)` — never a network dial. The verifier is **total**
   (any decode/verify failure → `false`).

A **self-referential** `parentTopicId == topicId` is rejected. The existence view is **tier-routed**:
T2/T3 → `FretMembershipSource.has(coord0(parentTopicId))` (a cached `MembershipCertV1` → the parent is
served → real today); T0/T1 → an optional `committedReader`, **fail closed without one** (a FRET-cached cert
must not vouch for committed-tier existence — committed-tier integrity). The gate runs the real verifier the
moment any `reputation` view / `bootstrapEvidence` override is supplied; an entirely unconfigured host stays
permissive-but-logged.

## Review findings

Adversarial pass over commit `0ac3dd7` (implement) with fresh eyes on the diff before the handoff summary.

### Verifier correctness (SPP, type safety, error handling) — checked, no major issues

- `createParentReferenceVerifier` is total (whole body in `try/catch` → `false`) and synchronous, as
  required by `member-engine.ts` `runGuards`. Order is correct: parse → self-ref guard → signature →
  existence. The self-ref guard compares canonical b64url **strings** (`parentTopicId === reg.topicId`);
  a non-canonical re-encoding could slip the string compare, but the existence check keys on **decoded
  bytes** of a freshly-bootstrapping (uncached) topic and fails closed, so no free admission results — not
  exploitable, no change made.
- `createDefaultParentTopicView` tier-routing matches the membership source and the db-core policy's
  `maxNoPowTier` default (1). Host wires `committedReader: options.committedParentTopicReader` correctly;
  T2/T3 reads the FRET cache via the new synchronous `FretMembershipSource.has`.
- "Configured" predicate (`createBootstrapEvidencePolicy`) keys only on `reputation`/`bootstrapEvidence`;
  an unconfigured host stays permissive, a configured one fails closed on every unfilled verifier — so a
  banned referee cannot slip the T2/T3 `PoW || reputation || parent-ref` disjunction. Confirmed by
  `host-antidos-coldstart.spec.ts`.

### Docs / DRY (treated as out-of-date until read) — 2 minor fixes applied this pass

- **`ParentRefEvidenceV1` JSDoc was stale** — predated `parentRefSigningImage` and still said the sig was
  "over `bootstrapBoundImage`". Corrected to point at `parentRefSigningImage` (the bound tuple extended
  with `parentTopicId`). `bootstrap-evidence-envelope.ts`.
- **`antiDos.parentTopicView` host-option JSDoc overclaimed** — it said supplying the view makes the gate
  "configured". The `configured` predicate keys only on `reputation`/`bootstrapEvidence`; the view alone
  leaves the gate permissive (and the real verifier never runs). Corrected to say it overrides *which*
  existence view the real verifier consults, and must be paired with `reputation`/`bootstrapEvidence`.
  `host.ts`.

### Test coverage (implementer's tests are a starting point) — 1 floor gap filled this pass

- The handoff flagged `parentRefSigningImage` had **no direct db-core unit test** (covered only
  transitively by the db-p2p verifier spec). Added 4 floor cases to
  `bootstrap-evidence-envelope.spec.ts`: stability, differs across all 5 axes (topic/tier/coord/timestamp/
  **parentTopicId**), domain separation from `bootstrapBoundImage`, and the canonical array shape. 40
  passing (was 36).
- Existing db-p2p coverage is genuinely thorough — 12 verifier cases (every replay axis, domain separation,
  unknown parent, self-ref, malformed/no-throw, tier passthrough, default-view tier routing + committed-tier
  integrity) and 8 host cold-start cases (T0 admit/deny, bad-sig deny, T2 parent-ref-alone admit, banned-
  referee can't slip the disjunction, unconfigured-permissive). Edge/error/replay/interaction paths are well
  covered; no additional gaps warranting new tests.

### Accepted interim postures (verified, not regressions)

- **T0/T1 fails closed on real nodes.** No coord-keyed committed-membership index exists (the tx-log commit
  cert is keyed by *action*, not `coord_0`), so `libp2p-node-base.ts` wires no `committedReader`. Net:
  T0/T1 parent-ref existence always fails closed; T2/T3 is fully real. Intentional (committed-tier
  integrity), documented in code + `docs/cohort-topic.md`. The dedicated committed backing + the richer
  "the parent's committed record names *this* child" check is the existing backlog ticket
  `cohort-topic-parent-ref-tx-log-content`. Confirmed this is the accepted posture — no new ticket needed.
- **Existence is "a cohort serves the parent," not "the parent anchors this child."** By design; the
  richer content check is the same follow-on. A participant could reference an unrelated-but-existing T2/T3
  parent to satisfy the T2/T3 gate today — acceptable since T2/T3 also accept PoW/reputation.

### Major findings → new tickets

None. The two known design gaps above are already captured by the pre-existing backlog ticket
`cohort-topic-parent-ref-tx-log-content`; no new fix/plan tickets filed.

## Validation

- `packages/db-core` build → OK. `packages/db-p2p` build → OK (both `tsc` strict; lint is a repo-wide no-op
  echo, so the strict build is the effective static check).
- `bootstrap-evidence-envelope.spec.ts` (db-core) → **40 passing** (incl. the 4 new floor cases).
- `bootstrap-parent-reference.spec.ts` + `host-antidos-coldstart.spec.ts` (db-p2p) → all green
  (12 + relevant host cases).
- Full `@optimystic/db-p2p` suite → **946 passing, 30 pending, 1 failing**.

### Pre-existing failure (flagged, not mine)

The 1 full-suite failure is `reactivity / mesh — cold-to-hot` (`mesh-cold-to-hot.spec.ts`,
`CohortBackoffError: no willing primary right now`). It **passes 5/5 in isolation** — a load-induced
cold-start flake under full-suite CPU contention, outside this diff (the reactivity mesh runs the gate
bootstrap-permissive, so `verifyParentReference` is unchanged there), and already triaged once
(`8298b12` / `b4fc9eb`). Recorded in `tickets/.pre-existing-error.md` for the runner's triage pass.

## End
