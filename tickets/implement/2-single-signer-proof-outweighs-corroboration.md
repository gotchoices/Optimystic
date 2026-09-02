----
description: A machine that was briefly alone can sign its own receipt for a change the rest of the group never saw — and today one self-signed receipt beats several machines agreeing with each other, so the odd one out would win.
prereq: mint-solo-cohort-commit-proof
files: packages/db-p2p/src/cluster/quorum-restore.ts (selectQuorumRev, selectQuorumBlock), packages/db-p2p/src/cluster/certified-claims.ts (ClaimCertification, ContentCertification), packages/db-p2p/src/repo/coordinator-repo.ts (queryClusterForLatest), packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/quorum-restore.spec.ts, docs/internals.md, docs/transactions.md
difficulty: hard
repro: static
----

# One signature must not outrank several machines agreeing

## Why this exists now

`mint-solo-cohort-commit-proof` makes a machine that is the only holder of a block sign its own
commit receipt (a `BlockCommitProof` with exactly one signer). That is the right fix for
replication — the receiver's push gate needs *some* verifiable artifact, and one honest peer's
signature over its own commit is an honest artifact.

But the repair selectors treat "certified" as an absolute, with no notion of how many signers stood
behind it. That is safe while every proof in existence carries a cohort super-majority. It stops
being safe the moment single-signer proofs become routine, which is precisely what the prerequisite
ticket does. The concern is therefore **not** hypothetical after that lands; it is a dormant path
being switched on.

## What goes wrong

Both selectors in `packages/db-p2p/src/cluster/quorum-restore.ts` let a certified claim
short-circuit the distinct-peer corroboration rule:

- `selectQuorumRev` — a corroborated `(rev, actionId)` pair wins only when its revision is
  **strictly higher** than the top certified revision. At an equal revision the certified claim
  wins outright, "where the proof outweighs votes" (its own doc comment).
- `selectQuorumBlock` — exactly one distinct certified content hash wins outright, "however many
  peers served it", ahead of the hash quorum entirely.

Neither `RevClaim.certified` nor `BlockHashCandidate.certified` carries a signer count, and the
certification layer does not supply one: `certifyClaim` returns `{ certified: true }` and
`certifyContent` returns `{ revCertified: true, contentCertified: true }` with no size information,
while the callers (`CoordinatorRepo.queryClusterForLatest` and `cluster/reconcile-block.ts`) set the
flag unconditionally on a passing verdict.

### The failure scenario

Node A is briefly alone — its peers are unreachable, not absent — so its cohort view shrinks to one
and its commit takes the solo path. It mints a one-signer proof for revision N under action X. The
rest of the cohort, meanwhile, commits revision N under action Y and several of them hold it.

On healing, a reader consults the cohort. A's claim carries a proof that verifies, so it is
certified. The cohort's claim at the same revision N is corroborated by several distinct peers but —
if those members retained no proof, which happens whenever their commit declared no content digest
or their materialization diverged — is uncertified. `selectQuorumRev` then picks **A's fork**,
because corroboration only wins strictly above the certified revision.

Before the prerequisite ticket, A's solo-committed revision was uncertified, so corroboration won and
the cohort's version was selected. The prerequisite ticket inverts that outcome. Where the cohort's
side *does* carry a proof, the outcome is instead a certified-equivocation decline — better than
picking the fork, but still a new deadlock that did not exist before.

`repro: static` — established by reading `selectQuorumRev`, `certifiedGroups`, `certifyClaim` and
the two call sites, not by running it. What would confirm it: a `quorum-restore.spec.ts` case with
one certified single-signer claim at rev N and two uncertified claimants agreeing at rev N, asserting
which side `selectQuorumRev` returns.

## Direction

Keep single-signer proofs fully valid for **verification** — push acceptance
(`BlockTransferService.handlePush` via `certifyContent`) must be unchanged, or the prerequisite
ticket's entire benefit is lost. Change only what a certified verdict is allowed to *outrank* in the
two repair selectors.

Recommended rule: **a certified claim backed by a single signer may still win when nothing contests
it, but must never beat multi-peer corroboration at the same revision (or a content hash quorum).**
Concretely:

- Carry the signer count from the proof into the certification verdict —
  `{ certified: true; signerCount: number }` and the matching `ContentCertification` arm — rather
  than having each call site read `proof.peerIds.length` itself, so the two repair paths cannot
  drift on how they measure it. (`UnanchoredProofAcceptance` already carries a `signerCount`, so the
  concept exists in that module.)
- Plumb it onto `RevClaim` and `BlockHashCandidate` beside the existing `certified` flag.
- In `selectQuorumRev`, let a corroborated pair win at an **equal** revision when every claim in the
  top certified group is single-signer; keep today's strictly-higher rule otherwise.
- In `selectQuorumBlock`, apply the same shape: a single-signer certified hash does not displace a
  hash group that meets the ordinary quorum.

The blunter alternative — refuse to certify any single-signer proof for repair selection at all —
was considered and is worse: a founder's solo-written block held only by the founder would stay in
the `sole-holder` repair deadlock the certified path exists to break. It would still be reachable by
push (which this ticket leaves alone), but the read-repair benefit would be lost for no additional
safety over the narrower rule above.

## Scope boundaries

- **Do not touch** `verifyBlockCommitProofClaim` / `verifyBlockCommitProofContent`. A one-signer
  proof is a valid proof; this is an acceptance-weighting question, not a verification one.
- **Do not touch** `handlePush` or `MAX_PROOF_SIGNERS`.
- Whatever rule lands must be stated at the site, in `docs/internals.md` (the certified-claim
  sections and the repair-deadlock reasons) and in `docs/transactions.md` (the bullet asserting a
  certified claim "needs no second peer at **any** cohort size" — that sentence becomes wrong).

## Verification

- `yarn workspace @optimystic/db-p2p test`.
- `yarn build` then `yarn typecheck` from root.
- New `quorum-restore.spec.ts` cases, at minimum: single-signer certified versus corroborated at
  equal revision; single-signer certified versus nothing (must still win); multi-signer certified
  versus corroborated at equal revision (must still win, unchanged); and the content-side siblings
  for `selectQuorumBlock`.
