----
description: A lone machine now signs its own receipt when it saves data no other machine holds; the code and tests for that are written, but the docs still describe the old gap and the test suite has not been run to confirm everything passes.
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, docs/internals.md, docs/correctness.md
difficulty: medium
----

# Finish the solo-cohort commit proof: docs, verification, review handoff

Continuation of `mint-solo-cohort-commit-proof` (implement stage), split on a budget warning.
**All code and test changes are already in the working tree — do not re-implement them.** What
remains is the docs pass, running the verification, and writing the review handoff. Read the
"Already landed" list first so you don't redo or undo it.

## Already landed (uncommitted, in the working tree)

- `packages/db-p2p/src/cluster/commit-proof.ts` — new exported `mintSoloCommitProof(peerId,
  privateKey, message)`: derives `membershipDigestFromIds([peerId])`, hashes message → promise →
  commit rounds with the same helpers the verifier uses, signs both rounds via
  `clusterVoteSigningPayload` (promise round first — the commit hash's preimage includes the
  promises map), returns a v1/membership-v2 one-peer proof.
- `packages/db-p2p/src/cluster/cluster-repo.ts` — public `ClusterMember.mintSoloCommitProof(message)`
  delegate (the class holds `peerId` + `privateKey`), placed after `getExecutedCommitResult`.
- `packages/db-p2p/src/repo/cluster-coordinator.ts` — new public `getClusterPeerIds(blockId)`
  accessor (`getClusterSize` without discarding the ids; empty on `findCluster` failure).
- `packages/db-p2p/src/repo/coordinator-repo.ts` —
  - `LocalClusterWithExecutionTracking` gained optional `mintSoloCommitProof`;
  - the `localCluster` constructor param is now a retained `private readonly` field;
  - `commit`'s solo short-circuit now calls `getClusterPeerIds` (instead of `getClusterSize`),
    logs `commit:solo-cohort` with `{ blockId, cohortSize, soleIsSelf }`, builds the message with
    `coordinatingBlockIds: [blockIds[0]]`, mints via `this.localCluster?.mintSoloCommitProof?.(...)`
    and passes the proof through the `ICommitProofPersister` cast; `undefined` proof (no local
    cluster wired) keeps today's proof-less behavior;
  - the post-consensus local fallback threads `buildBlockCommitProof(record)` (the REAL consensus
    proof — deliberately NOT self-signed there; a site comment states why).
- `packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts` — recreated reproducing spec:
  a real `clusterMember` wired into `CoordinatorRepo` retains + content-verifies a one-peer proof;
  a second test pins that `undefined` localCluster still commits and retains nothing.
- `packages/db-p2p/test/commit-proof.spec.ts` — new `describe('mintSoloCommitProof')`: content
  round-trip on the exact `(blockId, rev, actionId)`; `claim-not-in-message` for a neighbouring
  rev; growth case (one-peer proof at rev 1, 3-peer proof at rev 2, both verify).

## TODO — docs (sites located, text not yet edited)

- `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)" (~line 239): add a short
  paragraph describing the one-peer proof — `CoordinatorRepo.commit`'s solo short-circuit skips
  consensus, so the lone member self-signs via `mintSoloCommitProof`; honest artifact ("one peer,
  which was the whole cohort at the time, committed these bytes"); verifies under production
  thresholds (`ceil(0.75×1)=1` promise approve, `1 > 0.5` commit); ~830 bytes serialized.
- `docs/internals.md` certified-push bullet (~line 1403): the sentence "Any block written again
  under current code gets a proof, so only cold, never-updated blocks stay uncertified" was FALSE
  for solo cohorts until this change and is now true — correct it, noting blocks last written
  before the solo mint landed also stay uncertified.
- `docs/correctness.md` "*The cost of not declaring.*" paragraph (~line 401): the enumeration of
  why a revision retains no proof should name the solo-cohort commit as a formerly-second cause,
  now closed — leaving the missing content digest as the only in-code path that produces a
  proof-less revision.
- `packages/db-p2p/src/libp2p-node-base.ts` `blockTransfer` option doc comment (~lines 265–278):
  narrow the strict-default framing to pre-fix history — every current commit path, solo cohorts
  included, now attaches a proof, so the uncertified backlog no longer grows; the
  `requirePushCertificate: false` window remains only for blocks last written before this landed.

## TODO — verification (none run yet)

- `yarn workspace @optimystic/db-p2p test` — whole package. Foreground, no output redirection.
- `yarn build` then `yarn typecheck` from root (typecheck after build).
- Watch for possibly-stale editor diagnostics that flagged pre-existing test imports
  (`ProofThresholds`, `KeyPair` in `test/commit-proof.spec.ts`) as unused — verify against the
  real typecheck, and fix only what it actually reports.
- Optional evidence, not a gate: if `../sereus/packages/integration-tests` exists, run
  `yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts` there (two
  tests failed on the catch-up gap before this fix). Skip silently if the checkout is absent.

## TODO — review handoff

When tests/build/typecheck pass, write the review/ ticket (deleting this one). It must state
plainly:

- Pre-existing uncertifiable blocks are NOT migrated by this change — revisions written before
  the mint landed still have no signatures; operators still need the
  `requirePushCertificate: false` window to clear that backlog. What changes is that the backlog
  stops growing.
- A stale one-peer proof is a genuine new risk (a node briefly alone mints a proof for a revision
  the rest of the cohort never saw, and a certified claim currently out-ranks a corroborated one
  at equal revision). That is a separate confirmed defect filed as
  `single-signer-proof-outweighs-corroboration`, expected to land alongside; it was deliberately
  not solved here.
- The mint is NOT gated on "the sole cohort peer is self": a proof's peer list is already not
  evidence of cohort membership by design (caller obligation #1 on
  `verifyBlockCommitProofClaim`), so the gate buys no safety while opening a silent no-proof hole
  exactly when routing is degraded. The `commit:solo-cohort` log line is the operator's
  discriminator (cohortSize 0 / soleIsSelf false = degraded routing).
- Test surface for the reviewer: the solo spec (both wired and unwired cluster), the three new
  `mintSoloCommitProof` cases in `commit-proof.spec.ts`, and the untouched multi-peer size test
  ("a 10-peer, two-block, fully-signed proof fits far inside MAX_CONTROL_MESSAGE_BYTES").
