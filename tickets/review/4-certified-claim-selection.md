----
description: Repair selection can now accept a claim proven by a cohort-signed commit proof from a single peer, and a shared helper module classifies and anchors those proofs for both repair paths.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/certified-claims.spec.ts
----

# Review: certified short-circuit in selection + shared certification module

First of three tickets from the `accept-certified-claims-in-repair` split. The next two
(`certified-claims-read-repair`, `certified-claims-reconcile-and-persist`, both in `implement/`)
wire these helpers into the two repair paths — nothing built here is called from production code
yet, by design.

## What was built

**`quorum-restore.ts` (selection, stays pure/synchronous — verdicts arrive as injected booleans):**

- `RevClaim.certified?: boolean` and `BlockHashCandidate.certified?: boolean` — set by a caller
  that verified the attached cohort commit proof; the `proof` field itself stays unread by
  selection. `QuorumRev.certified?: true` tells callers which path won.
- `selectQuorumRev` precedence, exactly as the ticket settled it: no certified claims → today's
  corroboration result unchanged; a corroborated pair at a STRICTLY higher rev than every
  certified claim wins (legacy uncertified tail stays readable); otherwise the top certified rev
  wins (covers certified-vs-uncorroborated-higher and the equal-rev tie) — unless two distinct
  actionIds are certified at that top rev, which is equivocation and declines the entire
  selection (`undefined`).
- `certifiedEquivocation(claims)` exported so callers can log that decline distinctly from a
  plain no-quorum. Returns the conflicting `{ rev, actionIds }` only for the TOP certified rev.
- `selectQuorumBlock`: exactly one distinct certified hash → returned outright; two-plus →
  decline (certified content equivocation); none → existing unique-hash quorum unchanged.
- `corroboratorCapacity` untouched, as the ticket demanded.

**`cluster/certified-claims.ts` (new; mirrors `verifyInvalidationCertificate`'s layered posture):**

- `certifyClaim(proof, claim, thresholds, anchoring)` → `{ certified, failure? }` and
  `certifyContent(..., block, ...)` → `{ revCertified, contentCertified, failure? }`. Content
  failures `digest-mismatch` / `no-digest-declared` report rev-certified TRUE (the claim half
  passed before content was checked).
- `MAX_PROOF_SIGNERS = 256` cap on `proof.peerIds.length`, checked before any hashing/signature
  work; declines as helper-local failure `'oversized-cohort'`, classified non-attributable.
- `NON_ATTRIBUTABLE_PROOF_FAILURES` set plus `isAttributableProofFailure()` predicate. The
  predicate exists because `no-digest-declared` is a three-state oddity: not in the
  non-attributable set, yet never a penalty (it is a verdict, not misbehavior) — one function so
  the two repair paths cannot drift on that classification.
- Anchoring layer: capability absent → log + `onUnanchored('no-recompute-capability')`;
  infeasible → same with `'recompute-infeasible'`; feasible → signer/cohort overlap LOGGED only,
  never gated (zero overlap accepts — historic cohort rotation makes it legitimate).
  `onUnanchored` exceptions are swallowed.

## Validation

- `yarn workspace @optimystic/db-p2p build` clean (tsc type-checks `test/` too).
- Targeted run: `test/quorum-restore.spec.ts` (pre-existing, untouched — pins byte-identical
  uncertified behavior), `test/quorum-restore-certified.spec.ts` (new, 18 tests),
  `test/certified-claims.spec.ts` (new, 15 tests, real signed proofs via
  `test/support/commit-proof-fixtures.ts`), `test/commit-proof.spec.ts` (pre-existing) —
  100 passing.
- Full db-p2p suite NOT run — the ticket assigns that to the last ticket in the chain
  (`certified-claims-reconcile-and-persist`). Reviewer may want to spot-check that the additive
  optional fields really are inert for `coordinator-repo.ts` / `reconcile-block.ts`, the two
  existing `RevClaim` producers.

## Use cases worth probing in review

- **Precedence edges**: certified 5 vs uncorroborated 9 → 5; certified 5 vs corroborated 9 → 9;
  equal-rev tie → certified even when the certified actionId DIFFERS from the corroborated one
  (tested — the cohort-signed action beats what peers now assert); equivocation at the top
  certified rev declines even when a corroborated pair exists at that same rev (tested); a
  certified conflict at a lower rev than either kind of winner is ignored (tested both ways).
- **`certified: false` vs absent**: must behave identically (tested) — the flag records a
  verdict, never a weight.
- **Replay**: a genuine proof presented for a different rev fails `claim-not-in-message` and is
  attributable (tested) — this is the classification the read-repair ticket's penalty logic
  will key on.
- **Oversized cohort**: 257 fake peerIds returns `'oversized-cohort'`, not
  `'membership-mismatch'`, proving the cap fired before hashing (tested); exactly 256 proceeds
  to real verification (tested).
- **Anchoring is observational**: zero-overlap feasible recompute certifies with no
  `onUnanchored` call; throwing `onUnanchored` cannot un-certify (both tested).

## Judgment calls beyond the ticket's letter (flag if you disagree)

- **Anchoring also runs on `digest-mismatch` / `no-digest-declared`** in `certifyContent`, not
  only on full success — rationale: the claim half passed, so a proof WAS accepted as evidence,
  which is the event anchoring observes. The ticket only specified anchoring "on success" for
  `certifyClaim`.
- **A THROWING `recomputeBlockCohort` degrades to `'recompute-infeasible'`** instead of
  propagating. The invalidation precedent lets its recompute throw through; here the
  certification verdict is already decided when anchoring runs, so letting an observational
  layer throw would un-certify a cryptographically-valid proof. Tested and documented at the
  site.
- **`isAttributableProofFailure` helper added** (not in the ticket) — see above.
- **`certified-claims.ts` is NOT barrel-exported** from `src/index.ts` (commit-proof is;
  quorum-restore is not). Its consumers are in-package; the wiring ticket
  (`certified-claims-reconcile-and-persist`) owns the export decision along with docs.

## Known gaps (honest)

- Zero production callers until tickets 4.1/4.2 land — this module is exercised only by its
  specs today. If the chain stalls, this is dead code with strong opinions.
- The overlap log line reports counts only; no metric/threshold advice for operators. Deliberate
  (overlap semantics are undecided until a real recompute capability exists), but a reviewer may
  want a NOTE somewhere the wiring ticket will see.
- `docs/cluster.md` mentions the old two-peer-only rule and was NOT updated — docs are
  explicitly the last chain ticket's job.
