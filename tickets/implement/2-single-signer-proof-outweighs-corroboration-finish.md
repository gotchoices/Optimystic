----
description: Finish the change that stops a machine's self-signed receipt from outranking several machines agreeing with each other — the selector code and core tests are done; remaining work is doc updates, a few more test cases, and running the build/test validation.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/certified-claims.spec.ts, docs/internals.md, docs/transactions.md
difficulty: medium
----

# Finish: single-signer proof must not outweigh corroboration

Continuation of `single-signer-proof-outweighs-corroboration` (original ticket text is in git
history at `tickets/implement/2-single-signer-proof-outweighs-corroboration.md`; read it for the
full failure scenario and scope boundaries). The prior run implemented the whole code change and
the core test updates, then hit its token budget before docs and validation.

## What is already done (verify, don't redo)

**Code — complete:**

- `cluster/certified-claims.ts`: certification verdicts now carry the proof's signer count —
  `ClaimCertification` success arm is `{ certified: true; signerCount: number }`, and both
  `revCertified: true` arms of `ContentCertification` carry `signerCount` too
  (`proof.peerIds.length`, same number `UnanchoredProofAcceptance` reports).
- `cluster/quorum-restore.ts`: `RevClaim` and `BlockHashCandidate` gained
  `certifiedSignerCount?: number` (absent or <2 weighs as single-signer — deliberate conservative
  default, documented on the fields). Selection rules:
  - `selectQuorumRev`: a single-signer-only certified group at the top certified rev loses the
    equal-rev tie to corroboration by ≥ `CORROBORATION_FLOOR` (2) distinct peers — unless the
    corroborated pair AGREES with the sole certified action (convergence keeps the certified
    verdict, which preserves the `pools distinct certified claimants` behavior). Strictly-higher
    corroborated rev still wins; multi-signer certified still wins the equal-rev tie; an
    uncontested single-signer certified claim still wins.
  - Contender rule (helper `certifiedContenders`, shared with `certifiedEquivocation` so they
    cannot drift): when any action at the top certified rev is multi-signer-backed, only
    multi-signer actions contend — a solo receipt can neither outrank nor equivocate against a
    cohort proof. So multi-signer-vs-single-signer at one rev now RESOLVES (cohort side wins)
    instead of declining as equivocation. This goes slightly beyond the original ticket's letter
    but follows its recommended rule ("must never beat multi-peer corroboration"); the original
    named this decline as a new deadlock the prereq introduced.
  - `selectQuorumBlock`: mirrored. Exactly one multi-signer certified hash wins outright; two+
    decline. Single-signer certified hashes no longer short-circuit: a quorum-meeting hash group
    with ≥2 distinct carriers displaces them (two such groups → decline as before); with no
    multi-peer group, a sole single-signer certified hash wins, two+ decline. A quorum-meeting
    group of ONE carrier (capacity-1 cohort) does NOT displace a certified hash.
  - `certifiedContentEquivocation` mirrors the contender rule.
- `repo/coordinator-repo.ts`: plumbs `verdict.signerCount` → `claim.certifiedSignerCount`;
  `penalizeContradictingRevClaims` now skips `certified === true` claims (a displaced solo is a
  partition casualty, not a liar — rationale in the code comment).
- `cluster/reconcile-block.ts`: `ReconcileCandidate.certifiedSignerCount` injected by
  `certifyCandidates` (both the content and claim-only arms), plumbed into `revClaims` and
  `hashCarriers`; `penalizeContradictingContent` skips certified candidates; stale "detection is
  sound" comment above `certifiedCarrier` rewritten (the hash-quorum rule can now win at a hash
  that also has a certified carrier — persisting that proof is still sound, it verified against
  exactly those bytes); module docs updated.

**Tests — updated so far:**

- `test/certified-claims.spec.ts`: the four deep-equal verdict assertions now include
  `signerCount: 3` (fixtures use `makeSignedProof(3)` — verify that helper's count is indeed the
  peer count if anything fails).
- `test/quorum-restore-certified.spec.ts`: `claim`/`hashed` helpers take an optional signer
  count; the two behavior-changed tests now pin the multi-signer rule explicitly; new cases added:
  single-signer loses equal-rev tie to 2-peer corroboration (rev + content sides), single-signer
  wins uncontested (rev + content sides), two single-signer actions yield to corroboration instead
  of deadlocking, multi-signer beats single-signer at one rev with no equivocation decline.

## TODO

- **Run validation, fix fallout**: `yarn workspace @optimystic/db-p2p test`, then `yarn build`
  and `yarn typecheck` from root. Nothing has been run yet — diagnostics looked clean after the
  edits but no build or test has executed. Likely fallout sites: any spec or mock constructing a
  `ClaimCertification` / `ContentCertification` literal (the success arms now require
  `signerCount`), and integration specs that exercise solo/single-signer certified selection —
  `coordinator-repo-solo-commit-proof.spec.ts`, `coordinator-repo-read-repair-trust.spec.ts`,
  `cohort-growth-heals-single-holder.spec.ts`, `reconcile-block.spec.ts`, `block-transfer*.spec.ts`.
  A solo-proof integration test asserting the OLD outcome (single-signer certified beating
  corroboration at equal rev) now legitimately asserts the fix's inverse — update such tests to the
  new rule, do not weaken the rule to fit them.
- **Small test gaps worth adding** (cheap, in `quorum-restore-certified.spec.ts`):
  `certifiedEquivocation` with mixed multi/single signers returns `undefined`;
  `certifiedContentEquivocation` mixed case likewise; two single-signer certified hashes plus a
  ≥2-carrier quorum group → the quorum group wins (no decline).
- **docs/transactions.md** (§ "What a repair pass will and will not accept", the long bullet):
  the sentence "needs no second peer at **any** cohort size" is now wrong as stated — a certified
  claim needs no second peer *where nothing multi-peer contests it*, and a SINGLE-SIGNER proof
  (routine since solo cohorts self-sign commits) never outranks two-plus distinct peers agreeing at
  the same revision. The content-gate sentence at the end of the following bullet ("wins the
  content quorum without a second carrier") needs the same qualifier.
- **docs/internals.md**: three places.
  1. § "One-peer proofs (solo cohorts)": the closing "What this does not address … tracked
     separately as `single-signer-proof-outweighs-corroboration`" paragraph — replace with a
     statement that the selectors now weigh signer count, so a briefly-alone machine's fork loses
     to the surviving cohort (corroborated or multi-signer-certified) at the same revision.
  2. § "The certified exception — when one holder is enough at any size": add the single-signer
     weighing as a fourth limit (or fold into the three): single-signer certification wins only
     uncontested; multi-peer corroboration at the same rev outranks it, on both gates.
  3. § "Certified-claim log lines": the two equivocation-incident entries — note that only
     proofs of comparable weight equivocate (a solo receipt disagreeing with a cohort proof, or
     with multi-peer corroboration at the same rev, resolves instead of declining), so the
     incident lines now fire on multi-signer conflicts and on solo-vs-solo with nothing else to
     defer to.
- **Hand off**: write the review/ ticket summarizing the whole change (both runs), delete this
  ticket. Flag for the reviewer: the penalize exemptions for certified claims/candidates and the
  multi-signer-beats-single-signer contender rule are judgment calls made during implementation —
  each is documented at its site, but they deserve adversarial review.
