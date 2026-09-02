description: A machine that saves data no other machine holds now signs its own receipt for it, so that data can later be copied elsewhere instead of being stranded on one machine. Code, tests, and docs are done and the whole test suite passes.
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts, packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, docs/internals.md, docs/correctness.md
difficulty: medium
----

# Review: solo-cohort commit proof (one-peer self-signed proof)

## What the change is, in plain terms

A block's data is stored by a small group of machines (its "cohort") that vote to agree on each
write. Those vote signatures become a durable receipt — a `BlockCommitProof` — that anyone can check
offline. Other machines refuse to accept a copy of a block that arrives without one
(`requirePushCertificate`, on by default).

When the cohort turns out to be **one machine**, `CoordinatorRepo.commit` skips the voting entirely
(there is nobody to vote with). Before this change that path produced **no receipt at all**, so a
block first written on a one-machine cohort could never afterwards be copied to a second machine —
it was permanently stuck at one holder. Now the lone machine signs a one-peer receipt itself.

## Where the code is

- `packages/db-p2p/src/cluster/commit-proof.ts` — `mintSoloCommitProof(peerId, privateKey, message)`.
  Deliberately in the same file as the verifier so the hash recipe the two must agree on lives once.
  Signs the promise round **first** — the commit hash's preimage includes the promises map, so the
  order is load-bearing, not stylistic.
- `packages/db-p2p/src/cluster/cluster-repo.ts` — `ClusterMember.mintSoloCommitProof(message)`
  delegate (the class already holds `peerId` + `privateKey`).
- `packages/db-p2p/src/repo/cluster-coordinator.ts` — `getClusterPeerIds(blockId)`: `getClusterSize`
  without discarding the ids. Returns empty on `findCluster` failure.
- `packages/db-p2p/src/repo/coordinator-repo.ts` — the solo short-circuit in `commit`: logs
  `commit:solo-cohort` with `{ blockId, cohortSize, soleIsSelf }`, builds the message with
  `coordinatingBlockIds: [blockIds[0]]` so a solo proof's message is shape-identical to every other
  proof's, mints, and passes the proof through the `ICommitProofPersister` cast. An `undefined`
  proof (no local cluster wired) keeps the old proof-less behavior rather than failing.
- Docs: `docs/internals.md` (new *One-peer proofs (solo cohorts)* subsection under *Durable commit
  proof*, plus a corrected certified-push backlog sentence), `docs/correctness.md` (Theorem 14's
  *cost of not declaring* paragraph), and the `blockTransfer` option comment in
  `packages/db-p2p/src/libp2p-node-base.ts`.

## What this stage actually did — the prior ticket's work was NOT green

The prior implement run landed the code and tests but never ran them. **The suite was red: 23
failures, every one caused by that change.** Both root causes are fixed here.

**Cause 1 — 21 failures, `TypeError: this.coordinator.getClusterPeerIds is not a function`.** Three
spec files replace `CoordinatorRepo`'s private `coordinator` field with a hand-written double, and
they did so through `(repo as unknown as { coordinator: unknown })` — completely untyped, so the
compiler could never notice a double missing a method the class had started calling. Rather than
just adding the one missing stub, the seam is now typed: `ICoordinatorClusterSeam` (new, exported
from `coordinator-repo.ts`) names the four coordinator methods `CoordinatorRepo` consumes, the
private field is declared as that interface, and the doubles are assigned through it. A
newly-called coordinator method now fails to compile at the call site until it is added to the
interface, which in turn fails to compile every incomplete double — at the point of widening, which
is where the cost belongs. **This is the part of the diff most worth a reviewer's attention: it is
the only change at this stage that touches production types.**

**Cause 2 — 2 failures in the new solo spec, `Pending action ... not found`.** The spec built its
`StorageRepo` as `new StorageRepo(id => new BlockStorage(id, new MemoryRawStorage()))`. That factory
is invoked per block *and per operation*, so pend and commit were writing to and reading from
different in-memory stores. Fixed by hoisting one shared `MemoryRawStorage`, matching every other
spec in the package. The spec's pend also now omits `rev` for the block's first revision, matching
`block-archive-proof.spec.ts`'s `landRevision` helper — that was not the failure cause, it was
changed for consistency after the real cause was found.

## Verification actually run

- `yarn workspace @optimystic/db-p2p test` — **2497 passing, 49 pending, 0 failing.** Log at
  `tickets/.logs/mint-solo-cohort-commit-proof-finish.test.log`.
- `yarn build` then `yarn typecheck` from the repo root — both clean. `db-p2p`'s tsconfig includes
  `test`, so the specs are type-checked too. The prior ticket flagged possibly-unused imports
  (`ProofThresholds`, `KeyPair` in `test/commit-proof.spec.ts`) from stale editor diagnostics; the
  real typecheck reports nothing there, so nothing was changed.
- **The new solo spec was confirmed to be a genuine regression guard**, not a test that would pass
  either way: with `mintSoloCommitProof` temporarily stubbed out of the commit path, its first test
  fails with `expected undefined to not equal undefined`. The source was restored immediately after
  and `git diff` re-checked.
- **Proof size measured, not estimated.** A one-peer proof for a single-block commit with
  36-character block and action ids serializes to **968 bytes** — measured by importing
  `mintSoloCommitProof` from `packages/db-p2p/dist/src/` and taking `JSON.stringify(proof).length`.
  The prior ticket's "~830 bytes" was an unmeasured guess; the docs carry the measured number. The
  pre-existing 10-peer/2-block test prints 4578 bytes and asserts it fits inside
  `MAX_CONTROL_MESSAGE_BYTES`; that test is untouched.
- **Not run:** the optional `../sereus/packages/integration-tests` scenario
  (`strand-membership-closed-strand-e2e.integration.ts`). The checkout exists and symlinks
  `@optimystic/db-p2p` at this working tree, but its global setup aborts with `Stale build detected`
  for two of *its own* packages (`@serfab/cadre-core`, `@serfab/quereus-plugin-sereus`). Rebuilding
  another repo's packages was out of scope here. This was optional corroborating evidence, never a
  gate — a reviewer wanting end-to-end confirmation would build those two sereus packages first and
  re-run it.

No pre-existing failures were encountered, so no `tickets/.pre-existing-error.md` was written.

## Things the reviewer must know, stated plainly

- **Nothing is migrated.** Revisions written before this landed still carry no signatures and can
  never gain them — the signatures do not exist to recover. Operators still need the
  `requirePushCertificate: false` window on receivers to clear that backlog. What changes is that
  the backlog **stops growing**.
- **A stale one-peer proof is a genuine new risk, knowingly not solved here.** A node that is
  briefly alone (real isolation, or degraded routing) can mint a proof for a revision the rest of
  its cohort never saw, and at equal revision a certified claim currently out-ranks a corroborated
  one. That is a separate confirmed defect, filed as `single-signer-proof-outweighs-corroboration`
  (currently in `tickets/implement/`) and expected to land alongside. Do not re-file it.
- **The mint is deliberately NOT gated on "the sole cohort peer is me."** A proof's `peerIds` list
  is already not evidence of cohort membership by design — that is caller obligation #1 documented
  on `verifyBlockCommitProofClaim` — so the gate would buy no safety, while opening a silent
  no-proof hole exactly when routing is degraded (a failed `findCluster` returns an empty peer list
  and lands in the same branch, and this node genuinely did commit those bytes either way). The
  `commit:solo-cohort` log line is the operator's discriminator: `cohortSize 1 / soleIsSelf true` is
  a real cohort of one; `cohortSize 0`, or a sole peer that is not this node, is degraded routing.
  A reviewer who disagrees with this call is arguing about whether that log line is sufficient, not
  about a missing safety check.

## Test surface to attack

- `test/coordinator-repo-solo-commit-proof.spec.ts` — a real `ClusterMember` (not a double) wired
  into a real `CoordinatorRepo` over a one-peer `findCluster`; asserts the retained proof binds
  exactly one peer and content-verifies via `verifyBlockCommitProofContent` under
  `PROOF_THRESHOLDS`. The second test pins that an `undefined` local cluster still commits and
  retains nothing.
- `test/commit-proof.spec.ts` → `describe('mintSoloCommitProof')` — content round-trip on the exact
  `(blockId, rev, actionId)`; `claim-not-in-message` for a neighbouring rev; a growth case (one-peer
  proof at rev 1, three-peer proof at rev 2, both verify).

**Known gaps in that surface — this is where a reviewer should push:**

- No test covers the **degraded-routing** entry into the solo branch (`getClusterPeerIds` returning
  `[]` because `findCluster` threw). Both solo specs exercise a genuine one-peer cohort, so the
  `cohortSize: 0` / `soleIsSelf: false` branch is unexercised.
- No test asserts the `commit:solo-cohort` log line's contents at all.
- No end-to-end test shows a solo-minted proof surviving the certified-push gate on a *receiving*
  node (`handlePush` → `certifyContent`). The unit-level verification is strong and the proof is
  shape-identical to a consensus proof, but the full push round-trip for a solo proof is argued,
  not demonstrated.
- The seam-interface change is covered only incidentally, by the 21 specs that now compile and pass.
  Nothing tests that a future incomplete double fails — that guarantee belongs to the type system,
  so a reviewer should hand-check that `ICoordinatorClusterSeam` actually matches
  `ClusterCoordinator`'s real signatures, notably `executeClusterTransaction`'s optional
  `localPendResult` / `localCommitResult`.

## Tripwire parked at the code site

`ICoordinatorClusterSeam`'s doc comment in `coordinator-repo.ts` carries a `NOTE:` recording that
the specs still reference the private field by string (`{ coordinator: ... }`), so renaming
`CoordinatorRepo.coordinator` would make every double's cast silently stop applying and leave the
real coordinator in place. Conditional on a rename that has not happened; not filed as a ticket.
