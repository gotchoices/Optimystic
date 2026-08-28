----
description: Repair selection can now accept a claim proven by a cohort-signed commit proof from a single peer, and a shared helper module classifies and anchors those proofs for both repair paths. Reviewed and hardened.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/certified-claims.spec.ts
----

# Certified short-circuit in repair selection + shared certification module

First of three tickets from the `accept-certified-claims-in-repair` split. The next two
(`certified-claims-read-repair`, `certified-claims-reconcile-and-persist`) wire these helpers
into the two repair paths — nothing here is called from production code yet, by design.

## What shipped

**`cluster/quorum-restore.ts` — selection stays pure and synchronous; verdicts arrive as
injected booleans, never verified here.**

- `RevClaim.certified?` / `BlockHashCandidate.certified?` — set by a caller that already verified
  the attached cohort commit proof. The `proof` field itself stays unread by selection.
  `QuorumRev.certified?: true` tells callers which rule won.
- `selectQuorumRev` precedence: no certified claims → today's corroboration result unchanged; a
  corroborated pair at a STRICTLY higher rev than every certified claim wins (a legacy uncertified
  tail stays readable); otherwise the top certified rev wins (covers certified-vs-uncorroborated-
  higher and the equal-rev tie) — unless two distinct actionIds are certified at that top rev,
  which is equivocation and declines the whole selection.
- `certifiedEquivocation(claims)` and `certifiedContentEquivocation(candidates)` let callers log
  a certified conflict distinctly from a plain no-quorum, on the rev side and the content side.
- `selectQuorumBlock`: exactly one distinct certified hash → returned outright; two-plus → decline;
  none → the existing unique-hash quorum, unchanged. `corroboratorCapacity` untouched.

**`cluster/certified-claims.ts` (new) — mirrors `verifyInvalidationCertificate`'s layered
posture.**

- `certifyClaim(...)` and `certifyContent(...)`, both total on hostile input.
- `MAX_PROOF_SIGNERS = 256` cap on `proof.peerIds.length`, checked before any hashing or signature
  work, declining as `'oversized-cohort'`.
- An exhaustive classification of every failure reason into "may the serving peer be penalized for
  this?", exposed as the `isAttributableProofFailure()` predicate with
  `NON_ATTRIBUTABLE_PROOF_FAILURES` derived from it.
- Anchoring layer: no recompute capability, or an infeasible one → certify anyway, log, and surface
  via `onUnanchored`. A feasible recompute LOGS signer/cohort overlap and never gates on it (zero
  overlap is legitimate — cohorts rotate over history).

## Validation

`yarn lint`, `yarn typecheck`, `yarn build`, and `yarn test` all pass from the repo root
(monorepo-wide, foreground). `@optimystic/db-p2p` alone: **2162 passing, 44 pending, 0 failing**
(2138 before this review pass; the +24 are the coverage added below). No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written.

The implement stage ran only the four proof-related specs and deferred the full suite to the last
ticket in the chain; this pass ran the whole monorepo instead, which also confirms the additive
optional `certified` fields really are inert for the two existing `RevClaim` producers
(`coordinator-repo.ts`, `reconcile-block.ts`) — both build their claims from an explicit field
list, so no wire-supplied value can reach `certified` today.

## Review findings

**Checked:** the full implement diff read before the handoff summary; both selectors line by line
against every precedence edge; the certification module against `commit-proof.ts`'s two stated
caller obligations; failure-reason classification against `ClusterMember.verifySignature`'s
outcome discipline; resource cleanup and error paths (nothing here allocates or holds anything);
type safety of the exported result shapes; every existing consumer of the changed types
(`coordinator-repo.ts`, `reconcile-block.ts`, `docs/`, `src/index.ts`); and the two downstream
chain tickets, to be sure a finding was not already owned there.

### Fixed in this pass (minor)

- **An unrecognized failure reason defaulted to "penalize the peer."** `isAttributableProofFailure`
  was `!nonAttributableSet.has(f) && f !== 'no-digest-declared'`, so a new `ProofFailure` variant
  added in `commit-proof.ts` would have silently landed on the penalize side — the irreversible
  direction — with nothing to catch it. Replaced with an exhaustive
  `Record<CertifyFailure, boolean>`: adding a variant is now a BUILD error until it is classified,
  the exported set is derived from that record so the two cannot drift, and the runtime default for
  an unrecognized string is "do not penalize". This also retires the `no-digest-declared` special
  case the implementer had to document as an oddity — it is simply classified `false` like every
  other no-penalty reason, and now sits in the exported set, whose documented meaning ("never a
  reputation penalty") always covered it.
- **`certifyClaim` / `certifyContent` could throw, against their stated "never throws" contract.**
  `exceedsSignerCap` reads `proof.peerIds` outside any guard, before the verifier's own try/catch.
  A throwing property accessor escaped. Guarded; the hostile shape now falls through to the
  verifier and reports `malformed-proof`. Reachable only from an in-process caller today (wire
  proofs are JSON-parsed, which cannot carry accessors), but the contract is stated absolutely and
  two repair paths are about to rely on it.
- **The anchoring layer could un-certify a cryptographically valid proof via an off-contract
  capability return.** It defended against a throwing `recomputeBlockCohort` and a throwing
  `onUnanchored`, but a verdict of `null` or one with a non-iterable `cohortPeerIds` threw out of
  `new Set(...)` and propagated. Both now degrade — `null` reads as `recompute-infeasible`, a bad
  `cohortPeerIds` costs the overlap log line only. The layer is observational; it must never
  decide.
- **`ClaimCertification` / `ContentCertification` permitted impossible states.** Both were
  `{ flags; failure? }`, so `{ certified: true, failure: 'x' }` typechecked and every consumer
  needed a `!` assertion to read the reason. Converted to discriminated unions matching
  `ProofVerdict`'s existing precedent in `commit-proof.ts` — the failure reason is now REQUIRED
  when uncertified and unrepresentable when certified, and `ContentCertification`'s three
  reachable outcomes are three arms. Done now, before either wiring ticket writes a consumer.
- **`certifiedEquivocation`'s doc claimed more than the code does.** It said it names "the
  condition that makes `selectQuorumRev` decline outright" — but a corroborated pair strictly above
  the top certified rev still wins, so the reporter can return a conflict while selection SUCCEEDED.
  A caller trusting the doc would log "declined for equivocation" over a successful repair.
  Corrected, pinned by a test, and both wiring tickets told to ask it only on a decline.
- **The content-side decline was unloggable.** `selectQuorumRev` got a distinct reporter for
  certified equivocation; `selectQuorumBlock` got the same decline with no way to name it, so
  "the cohort's keys signed two different digests into one revision" (a provable key compromise)
  would have logged identically to "not enough carriers agreed" (routine). Added
  `certifiedContentEquivocation(candidates)`, symmetric with the rev-side reporter, and pointed
  `certified-claims-reconcile-and-persist` at it.

### Test coverage added (+24 tests)

The implementer's specs covered the precedence edges well. Gaps closed: the whole failure
classification as a table (plus the unrecognized-reason default, which pins the safe direction);
`certifiedContentEquivocation` across equivocation, single-certified, plain-shortfall and empty;
`certifiedEquivocation` reporting a conflict on a SUCCESSFUL selection; the totality guards above;
and the implementer's own flagged judgment call — that anchoring runs on `digest-mismatch` and
`no-digest-declared`, not only full success — which had been argued in the handoff but never
tested, along with the converse (a claim-half failure anchors nothing).

### Filed as tickets

None. Every finding resolved at its site in this pass.

### Recorded as tripwires (not tickets)

- **The signer cap bounds signature count, not proof size.** `MAX_PROOF_SIGNERS` caps Ed25519
  verifies at 256 per round, but the three cluster-hash computations canonically serialize
  `message`, `promises` and `commits`, whose entry counts a peer chooses freely inside the
  transport byte cap. Linear cost, bounded today by the 1 MiB control-message cap. Parked as a
  `NOTE:` at the constant, naming the condition to act on (repair verification showing up in a
  profile, or a deployment raising the transport caps) and the fix (a serialized-size bound
  alongside the signer count). Magnitude deliberately not quantified — not measured.

### Considered and declined

- **`duplicate-signer` classified as attributable** while `malformed-proof` is not, though both
  are structural garbage. Kept: `buildBlockCommitProof` derives `peerIds` from
  `Object.keys(record.peers)`, so honest construction cannot produce a duplicate — serving one
  implies authorship. The rationale was missing from the code; it is now recorded at the
  classification site.
- **`QuorumRev.supporters` narrows on the certified path** to the certified claimants only,
  dropping peers that uncertified-corroborate the same pair. No consumer reads `supporters` —
  `reconcile-block.ts` re-filters candidates by `(rev, actionId)` and `coordinator-repo.ts` uses
  only `rev`/`actionId` — and the field's JSDoc already states the narrowing. Left alone.

### Handoff inaccuracies worth correcting for the record

- The implement handoff says `docs/cluster.md` was left stale. **No such file exists.** The
  actually-stale doc sites are `docs/internals.md` ("Nothing DECIDES with a proof yet"),
  `docs/correctness.md` (Theorem 14), and `docs/transactions.md` (the operator-facing "a claim
  needs a second, independent peer" rule). All three are accurate at HEAD, since nothing in
  production calls the certified path yet. The first two were already owned by
  `certified-claims-reconcile-and-persist`; **`docs/transactions.md` was not** — it has been added
  to that ticket's `files:` and its Docs section.

## Known gaps carried forward (unchanged from the implement handoff)

- Zero production callers until the two wiring tickets land; this module is exercised only by its
  specs.
- Cohort/signer overlap is logged as counts, with no metric or threshold advice for operators.
  Deliberate — overlap semantics stay undecided until a real recompute capability exists
  (`feat-cluster-membership-threshold-cert-anchoring`).
- `certified-claims.ts` is not barrel-exported from `src/index.ts`; its consumers are in-package
  and `certified-claims-reconcile-and-persist` owns that decision alongside the docs.
- The residual security posture is unchanged and honest: layer 1 proves the listed signers signed,
  never that they are the block's legitimate cohort. An attacker minting a whole cohort's keys
  still forges a passing proof. Closing that is the anchoring ticket's job.
