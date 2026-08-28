----
description: Teach the shared repair-selection helpers to accept a claim proven by a cohort-signed commit proof from a single peer, instead of requiring two peers to agree, and build the shared proof-checking helper both repair paths will use.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/certified-claims.ts (new), packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/dispute/invalidation.ts (precedent only), packages/db-p2p/test/support/commit-proof-fixtures.ts
difficulty: hard
----

# Certified short-circuit in the selection helpers + shared certification module

First of three tickets decomposed from `accept-certified-claims-in-repair` (split on a budget
stop after full investigation; the design below is settled — implement it, don't re-derive it).
The other two: `certified-claims-read-repair` (CoordinatorRepo integration) and
`certified-claims-reconcile-and-persist` (reconcile path, proof persistence, wiring, docs).

## The defect this chain fixes

Repair believes an answer only when two distinct peers corroborate it, so a block held by one
reachable peer is permanently unreadable — and the rule is bypassable anyway (an attacker dialing
two cohort members manufactures corroborators). A cohort-signed proof
(`verifyBlockCommitProofClaim` / `verifyBlockCommitProofContent` in `cluster/commit-proof.ts`,
landed by `serve-block-commit-proof`) makes the signature set the corroboration: a lone honest
holder becomes sufficient.

## Part 1 — `quorum-restore.ts` selection changes

Both functions stay pure/synchronous; verification verdicts arrive as injected booleans.

- `RevClaim` gains optional `certified?: boolean` (its `proof?` field already exists and stays
  unread by selection). `BlockHashCandidate` gains `certified?: boolean`.
- `QuorumRev` gains optional `certified?: true` so callers can log which path won.
- `selectQuorumRev` — settled rule (pins the ticket's edge cases exactly):
  1. Compute the existing corroboration result unchanged (call it `corroborated`).
  2. Among claims with `certified === true`, find the highest rev (`topCertifiedRev`).
  3. If no certified claims → return `corroborated` (today's behavior, unchanged).
  4. If `corroborated` exists and `corroborated.rev > topCertifiedRev` → return `corroborated`
     (certified 5 vs corroborated 9: higher rev wins — corroboration stays a legitimate weaker
     path; a legacy uncertified tail must stay readable).
  5. Otherwise certified wins (this covers certified 5 vs *uncorroborated* 9 — the lone rev-9
     claim failed quorum, so `corroborated` is undefined and certified 5 is selected — and the
     equal-rev tie, where the proof outweighs votes). But first: if ≥2 distinct `actionId`s are
     certified at `topCertifiedRev`, that is equivocation — return `undefined` (decline the whole
     selection; callers log). Supporters = the certified claimants at that (rev, actionId).
- Export `certifiedEquivocation(claims): { rev: number; actionIds: string[] } | undefined` — the
  conflicting set at the top certified rev, so callers can log the decline distinctly from a
  plain no-quorum (selection itself stays pure, no logging).
- `selectQuorumBlock`: among candidates with `certified === true`, collect distinct hashes.
  Exactly one → return that `{ block, hash }` outright. More than one → return `undefined`
  (certified content equivocation — decline, mirroring the existing unique-hash-tie decline).
  None → existing unique-hash-group quorum, unchanged.
- **Do not touch `corroboratorCapacity`** (`quorum-restore.ts:97`) — deliberately the MAX of
  observed and configured size so a shrunken view can't talk the floor down. The certified path
  goes around it, never relaxes it.
- Update the file-top NOTE (`quorum-restore.ts:13-16`) and `RevClaim.proof` doc — selection now
  does weigh injected certified verdicts.

## Part 2 — new `cluster/certified-claims.ts` (shared by both repair paths)

Mirrors `verifyInvalidationCertificate`'s layered posture exactly (`dispute/invalidation.ts` —
see `UnanchoredAcceptanceInfo` at :122, `VerifyCertificateOptions` at :130, `acceptUnanchored`
at :335; `libp2p-node-base.ts:808` documents why layer 2 is deliberately unwired there).

Types:
- `CohortRecomputeVerdict = { feasible: false } | { feasible: true; cohortPeerIds: string[] }`
- `RecomputeBlockCohort = (blockId: BlockId) => Promise<CohortRecomputeVerdict>` — the optional
  layer-2 capability; a real implementation would re-derive from `keyNetwork.findCluster` (same
  source `deriveExpectedCluster` uses, `libp2p-node-base.ts:780`). NOT wired in production yet.
- `UnanchoredProofAcceptance = { blockId; rev; actionId; signerCount; reason:
  'no-recompute-capability' | 'recompute-infeasible' }`
- `ProofAnchoring = { recomputeBlockCohort?: RecomputeBlockCohort; onUnanchored?: (info) => void }`

Functions (each takes `ProofThresholds` and `ProofAnchoring`):
- `certifyClaim(proof, claim, thresholds, anchoring)` → `{ certified: boolean; failure?: ... }`
  — caps then calls `verifyBlockCommitProofClaim`, then runs anchoring on success.
- `certifyContent(proof, claim, block, thresholds, anchoring)` → additionally distinguishes:
  `ok` → rev+content certified; `digest-mismatch`/`no-digest-declared` → the claim half PASSED
  (verifyBlockCommitProofContent only reaches those after claim success), so report rev-certified
  true, content-certified false, with the reason (caller drops/penalizes on digest-mismatch);
  any other failure → neither certified.
- Anchoring on an accepted proof: capability absent → log + `onUnanchored('no-recompute-capability')`;
  `{feasible:false}` → same with `'recompute-infeasible'`; feasible → compute overlap of
  `proof.peerIds` with the recomputed cohort and LOG it — **overlap is never a hard gate**
  (historic cohort rotation makes zero overlap legitimate for old data; gating would re-create
  the read-dead defect). Zero overlap accepts and logs. Never throws out of `onUnanchored`
  (mirror `acceptUnanchored`'s try/catch).
- `NON_ATTRIBUTABLE_PROOF_FAILURES: ReadonlySet` = `unknown-signer`, `non-ed25519-signer`,
  `malformed-signature`, `legacy-record`, `malformed-proof` (the commit-proof.ts doc at :99-103
  names these — identity/artifact unparseable, never a penalty), plus the new cap reason below.
  Everything else — `membership-mismatch`, `message-hash-mismatch`, `duplicate-signer`,
  `promise-threshold`, `commit-threshold`, `claim-not-in-message` (the replay case),
  `digest-mismatch` — IS attributable to the serving peer. `no-digest-declared` is verdict-level
  "content uncertified", not misbehavior — no penalty.
- **Explicit cohort cap** (investigated: NO existing peer-count bound applies to a proof off the
  repair wire — only byte caps, 1 MiB control / 8 MiB sync response, which admits ~80k signature
  checks — so cap here as `commit-proof.ts`'s caller-obligation #2 demands): reject
  `proof.peerIds.length > MAX_PROOF_SIGNERS` (suggest 256; far above any plausible cohort,
  cheap to verify) BEFORE any hashing/signature work, with a helper-local failure reason (e.g.
  `'oversized-cohort'`) that is NON-attributable (a genuine mega-cohort is conceivable).

Thresholds callers will pass: `{ superMajorityThreshold: <resolved config value>,
simpleMajorityThreshold: 0.5 }` — 0.5 hardcoded per the `ProofThresholds` doc
(`commit-proof.ts:49-54`): members enforce `count > total/2`, not the 0.51 config default.

## Tests (new spec, e.g. `test/quorum-restore-certified.spec.ts` + helper-level spec)

Real proofs come from `test/support/commit-proof-fixtures.ts` (builds signed records →
`buildBlockCommitProof`). Selection tests need only hand-built claims with `certified` flags.

- Certified single claim wins outright (no second supporter, large capacity).
- Certified 5 vs uncorroborated 9 → certified 5. Certified 5 vs corroborated 9 → 9.
  Equal-rev tie → certified. No certified claims → byte-identical behavior to today
  (re-run existing expectations).
- Two certified claims, same rev, different actionIds → `undefined`; `certifiedEquivocation`
  reports the pair. Conflict at a LOWER certified rev than the winner is ignored.
- `selectQuorumBlock`: one certified candidate accepted outright; two certified candidates with
  different hashes → decline; none certified → existing fallback intact.
- Helper: valid proof certifies; oversized `peerIds` declines non-attributably without signature
  work; replayed proof (genuine proof, different claim) fails `claim-not-in-message` and is
  classified attributable; malformed proof classified non-attributable; anchoring: no capability
  → `onUnanchored('no-recompute-capability')` and still certified; infeasible → same with
  `'recompute-infeasible'`; feasible with ZERO overlap → still certified, overlap logged (pin:
  never a gate).

Run `yarn workspace @optimystic/db-p2p build` + the new/changed specs; the full-suite run
belongs to the last ticket in the chain.
