----
description: Review the new durable, self-verifying commit proof: the group's signed approval of a write is now stored on disk next to the revision it approved, with an offline checker that confirms a copy of a block really is what the group agreed on.
prereq: commit-cert-digest-member-check
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-core/src/cluster/membership.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/commit-proof.spec.ts, docs/internals.md
----

# Review: persist a durable block commit proof per revision

## What was built

The existing `CommitCert` is in-memory with a 60-second TTL and signs an opaque hash — useless
as repair evidence. This ticket added `BlockCommitProof`: a durable, self-contained artifact
(the commit `RepoMessage` verbatim, promise-round + commit-round vote signatures, membership-v2
digest + sorted peer-id list, no public keys — Ed25519 keys recover from peer ids), plus pure
verification and a digest-gated persistence rule. Nothing consumes the stored artifact yet
(`serve-block-commit-proof` and `accept-certified-claims-in-repair` are the consumers).

Pieces, each documented with rationale comments at its site:

- **`packages/db-p2p/src/cluster/commit-proof.ts`** (new) — `BlockCommitProof`, `ProofClaim`,
  `ProofThresholds`, `ProofFailure`, `ProofVerdict`; `buildBlockCommitProof(record)` (returns
  `undefined` for non-membership-v2 records); `verifyBlockCommitProofClaim` (structure →
  membership digest → message hash → promise/commit hash recompute → per-signer Ed25519 verify
  with dedup and unknown-signer skip → both thresholds → claim-in-message anti-replay);
  `verifyBlockCommitProofContent` (adds declared-digest-equals-`canonicalBlockHash` check);
  `proofDeclaredDigest` (shared op-resolution helper also used by the retention rule). Both
  verifiers are pure and total on hostile input — no throws.
- **`membershipDigestFromIds`** in `db-core/src/cluster/membership.ts`; `membershipDigest`
  delegates, so verifier and coordinator share one implementation.
- **Storage** — `getBlockProof`/`saveBlockProof` on `IRawStorage` + `KvRawStorage`; rev-only
  pair on `IBlockStorage`/`BlockStorage`; `CachedRawStorage` passthrough. Proofs ride the
  transactions store under reserved key `` `~proof:${rev}` `` (`blockProofActionKey` in
  `raw-store-codec.ts`) — zero driver fan-out, keyed by revision so `pruneMaterialization`
  never touches them. Contract note records that no revision-delete site exists today.
- **Retention rule** — `StorageRepo.commit(request, options?, proof?)` → `internalCommit`
  persists the proof after `setLatest`, **only when the member's own materialization matches
  the digest the commit op declared**. Otherwise withheld with log
  `commit:proof-digest-mismatch` / `commit:proof-undeclared`; persist errors never fail the
  commit (`commit:proof-persist-failed`). Tombstones and digest-less commits store nothing.
  Idempotent re-commit back-fills a missing proof (strictly additive).
- **Commit path** — `ClusterMember.applyConsensusOperation` builds the proof beside the
  existing `captureCommitCert` call and passes it into `storageRepo.commit`; skips + logs
  `cluster-member:commit-proof-skipped` for legacy records.
- **Docs** — `docs/internals.md` "Durable commit proof (`BlockCommitProof`)" subsection under
  the Commit Path section, covering artifact vs. `CommitCert`, verification split, retention
  rule + log lines, `~proof:` key, and the `saveReplicatedBlock` gap.

## Validation performed

- `yarn workspace @optimystic/db-p2p test`: 2081 passing / 44 pending, green including the new
  spec (`tickets/.logs/2-persist-block-commit-proof.test.log`).
- Root `yarn build && yarn typecheck && yarn test`: all packages green, zero failures
  (`tickets/.logs/2-persist-block-commit-proof.root-test.log`).
- Measured proof size (10-peer cohort, two-block commit): **4578 bytes** — asserted
  `< MAX_CONTROL_MESSAGE_BYTES` in the spec and recorded in the `commit-proof.ts` header.

`test/commit-proof.spec.ts` covers: happy-path claim + content verification (with and without
declared digests); every `ProofFailure` value reached, including replay in its three shapes
(wrong rev / wrong blockId / wrong actionId), tampered message and peerIds, duplicate and
unknown signers, non-Ed25519 signer, malformed signatures (non-base64url and
real-key-wrong-payload), both threshold failures, and 9 structurally hostile proof shapes;
properly-signed reject votes ignored; multi-block commit where one id verifies and the sibling
is tampered; storage round trip through `KvRawStorage`-over-memory and `CachedRawStorage`
(deep-equal restore, claim still verifies); the retention rule's four withhold cases plus
back-fill; and a fully-signed end-to-end run through `ClusterMember.update` against a
pend-seeded `StorageRepo` where the persisted artifact then passes content verification
offline.

## Deviations from the ticket spec — reviewer should weigh these

- **Extra `ProofFailure` value `malformed-proof`** — deliberate catch-all for structurally
  hostile input (null, a string, missing fields); the spec's enum had no honest fit.
- **Undigestable block → `digest-mismatch`** — `verifyBlockCommitProofContent` maps a block
  whose bytes cannot be canonically hashed (e.g. circular) to `digest-mismatch` rather than
  throwing: the bytes provably are not the declared content.
- **Threshold doc vs. config** — callers are documented to pass
  `simpleMajorityThreshold = 0.5` to mirror `ClusterMember.hasMajority` (`> total/2`), NOT the
  config's 0.51 default. Verify the comment reads clearly enough that a future caller does not
  pass 0.51 and silently tighten the commit gate.
- **Side-fix in `libp2p-node-base.ts`** — `const target: IRepo = coordinatedRepo ?? storageRepo`
  gained an explicit annotation; the un-annotated union stopped compiling when
  `StorageRepo.commit` grew the third optional parameter. Behavior-neutral, but outside the
  ticket's named files.

## Suggested review focus

- The retention rule sits inside `internalCommit` after `setLatest` — check the failure-path
  interleaving: a proof persisted for a commit whose later steps fail must not be observable as
  certifying an un-landed revision.
- The anti-replay step (claim-in-message) is the security lynchpin; adversarial re-read of that
  matching logic against `RepoMessage.operations`' 1-element tuple shape is worthwhile.
- `buildBlockCommitProof` copies the record's maps verbatim — confirm no aliasing lets a
  post-build mutation of the live consensus record alter a stored proof.
- Known gap, by design: `saveReplicatedBlock` writes no proof — deferred to
  `require-proof-on-block-push`; confirm the code comment there says so.
