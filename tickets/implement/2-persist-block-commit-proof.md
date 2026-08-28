----
description: Keep the group's signed approval of a write on disk next to the record it approved, and add a checker that can confirm, offline, that a copy of the record really is the one the group agreed on.
prereq: commit-cert-digest-member-check
files: packages/db-core/src/cluster/membership.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/peer-key-binding.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/storage-repo.ts
difficulty: hard
----

# Persist a durable, self-verifying commit proof per revision

## The gap this closes

`buildCommitCert` (`packages/db-p2p/src/cluster/commit-cert.ts`) already assembles the cohort's
signatures into a `CommitCert`, but two things make it unusable as repair evidence:

1. It is handed to an **in-memory, 60-second TTL store** (`DEFAULT_COMMIT_CERT_TTL_MS = 60_000`) —
   long gone by the time a block needs repairing.
2. Its `signedPayload` is `utf8(commitHash + ":approve")` — an **opaque hash**. A receiver holding
   only a `CommitCert` cannot tell what claim it certifies, so it can never be checked against
   "block B at revision R holds these bytes".

This ticket introduces a durable, self-contained artifact that *can* be checked against a claim, and
a pure function that checks it. Nothing consumes it yet — serving is
`serve-block-commit-proof`, repair is `accept-certified-claims-in-repair`.

## The artifact

New `packages/db-p2p/src/cluster/commit-proof.ts` (db-p2p, not db-core: every consumer is db-p2p and
it needs `peerIdBindsPublicKey` from `peer-key-binding.ts`).

```ts
export type BlockCommitProof = {
	v: 1;
	messageHash: string;
	/** The commit RepoMessage exactly as hashed - carries the commit op incl. blockDigests. */
	message: RepoMessage;
	/** Promise-round votes, verbatim: the commitHash preimage includes canonicalJson(promises),
	 *  and the approve promises are the votes that actually carry "I checked this". */
	promises: Record<string, Signature>;
	/** Commit-round votes. */
	commits: Record<string, Signature>;
	/** Always 2. A v1 / unversioned record binds no peer set and is never certifiable. */
	membershipVersion: 2;
	membershipDigest: string;
	/** The record's full sorted peer-id list - the threshold denominator, bound by membershipDigest. */
	peerIds: string[];
};
```

**No public keys.** Every signer's Ed25519 key is recovered from its peer id — the mechanism
`peerIdBindsPublicKey` already relies on (`peerIdFromString(id).publicKey.raw`). Carrying keys would
add bytes and a second thing to disagree with the id.

**Measure the size** during implementation (a cohort of 10, a two-block commit) and record the real
number in a code comment — do not quote an estimate. It rides inside sync responses bounded by
`MAX_CONTROL_MESSAGE_BYTES = 1 MiB` (`protocol-limits.ts`), which already carry whole blocks.

## Verification, in two halves

The two repair stages hold different information, so verification splits:

```ts
export type ProofClaim = { blockId: BlockId; rev: number; actionId: ActionId };

export type ProofThresholds = {
	superMajorityThreshold: number;   // gates the promise-round approvals
	simpleMajorityThreshold: number;  // gates the commit-round approvals
};

export type ProofFailure =
	| 'legacy-record' | 'membership-mismatch' | 'message-hash-mismatch'
	| 'unknown-signer' | 'duplicate-signer' | 'non-ed25519-signer' | 'malformed-signature'
	| 'promise-threshold' | 'commit-threshold'
	| 'claim-not-in-message' | 'no-digest-declared' | 'digest-mismatch';

export type ProofVerdict =
	| { ok: true; declaredDigest?: string }
	| { ok: false; reason: ProofFailure };

/** Proves the CLAIM (blockId at rev under actionId) without needing the block bytes. */
export async function verifyBlockCommitProofClaim(
	proof: BlockCommitProof, claim: ProofClaim, thresholds: ProofThresholds
): Promise<ProofVerdict>;

/** Claim verification PLUS: the declared digest for this block equals the received bytes. */
export async function verifyBlockCommitProofContent(
	proof: BlockCommitProof, claim: ProofClaim, block: IBlock, thresholds: ProofThresholds
): Promise<ProofVerdict>;
```

`verifyBlockCommitProofClaim` steps, in order:

1. `proof.v === 1` and `proof.membershipVersion === 2`, else `legacy-record`. A v1 / unversioned
   record binds no peer set, so its signer list is unbound and it can never be certified.
2. Recompute `membershipDigestFromIds(proof.peerIds)` and compare to `proof.membershipDigest`.
3. Recompute `computeClusterMessageHash(proof.message, proof.membershipDigest)`; compare to
   `proof.messageHash`.
4. Recompute `promiseHash = computeClusterPromiseHash(messageHash, message, membershipDigest)` and
   `commitHash = computeClusterCommitHash(messageHash, message, proof.promises, membershipDigest)`.
5. Count **approve promises**: for each entry, the signer id must be in `peerIds` (else skip and
   record `unknown-signer`), must be a valid Ed25519 peer id whose key verifies
   `clusterVoteVerificationPayload(promiseHash, sig)`, and must be counted once. Require
   `approves >= ceil(superMajorityThreshold * peerIds.length)`, else `promise-threshold`.
6. Count **approve commits** the same way over `commitHash`. Require a simple majority of
   `peerIds.length` (mirror `ClusterMember.hasMajority`, `cluster-repo.ts:868`), else
   `commit-threshold`.
7. Find a `{ commit }` operation in `proof.message.operations` whose `blockIds` contains
   `claim.blockId` and whose `actionId` / `rev` equal the claim's. Absent → `claim-not-in-message`.
   **This step is what stops replay** — a genuine proof for rev 5 presented for rev 9, or presented
   for a different block id, dies here.
8. Return `{ ok: true, declaredDigest: op.blockDigests?.[claim.blockId]?.digest }`.

**Why both thresholds.** The commit-round vote is cast blind — a member signs the commit whenever
`approvedPromises >= superMajority`, regardless of its own promise vote (`cluster-repo.ts:835-858`).
The promise-round approvals are the votes that carry "I validated this message, including its content
digest". Requiring only the commit approvals would count signatures that attest to nothing;
requiring only the promises would accept a record the cohort never actually committed. Require both.

`verifyBlockCommitProofContent` = claim verification, then `declaredDigest` must be present
(`no-digest-declared`) and equal `await canonicalBlockHash(block)` (`digest-mismatch`).

Both functions are **pure and total on hostile input** — no throws. Mirror the outcome discipline of
`ClusterMember.verifySignature` (`cluster-repo.ts:748-795`): a malformed/unbound signer is a failure
that must **never** be turned into a reputation penalty, because the identity was not proven. Keep the
`ProofFailure` values distinguishable so `accept-certified-claims-in-repair` can decide which
failures are attributable.

## Shared helper in db-core

`membershipDigest(peers: ClusterPeers)` (`db-core/src/cluster/membership.ts:33`) already derives the
digest from `Object.keys(peers).sort()`. Extract:

```ts
/** Canonical membership digest for an explicit peer-id list. */
export async function membershipDigestFromIds(ids: readonly string[]): Promise<string>;
```

and have `membershipDigest` delegate to it. One implementation, so a verifier reading `peerIds` and a
coordinator reading `peers` can never disagree.

## Storage

`IRawStorage`:

```ts
/** The commit proof stored for a revision, if one was retained. */
getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined>;
saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void>;
```

(The plan stage sketched these as `getBlockCert` / `saveBlockCert`; renamed to match the artifact.)

`IBlockStorage` gains the same pair without the `blockId` argument, `BlockStorage` forwards.
`KvRawStorage` is the only implementation (`kv-raw-storage.ts:21`); `CachedRawStorage` /
`RawStorageDriverAdapter` (`cached-raw-storage.ts`) wrap it and must forward the new methods —
check `raw-store-codec.ts` for the key/codec convention and follow it rather than inventing one.

**Retention.** The proof is keyed by revision and lives and dies with the *revision record*, not with
the materialization. `pruneMaterialization` (`storage-repo.ts:901-912`) deletes superseded
materialized copies while retaining the revision and its transform; a proof keyed by rev survives
that prune. That is exactly what makes it outlive the 60-second reactivity TTL. Whatever deletes a
revision must delete its proof — find that site (revision-range trimming, if any) and handle it, or
state explicitly in a code comment that no such site exists today.

## Writing the proof on the commit path

`ClusterMember.applyConsensusOperation` (`cluster-repo.ts:1349-1400`) already builds the
commit-vote payload and calls `captureCommitCert(record, commit.actionId, commitSignedPayload)` at
`:1389`, immediately before `await this.storageRepo.commit(commit)` at `:1393`. Build the
`BlockCommitProof` from the same `record` at that point and pass it into the commit:

```ts
commit(request: CommitRequest, options?: MessageOptions, proof?: BlockCommitProof): Promise<CommitResult>
```

`StorageRepo.commit` forwards it to `internalCommit`, which — after `applyTransform` produces
`newBlock` and `saveMaterializedBlock` stores it — applies the single retention rule:

> **A member persists the proof only when its own materialization matches the declared digest.**

That is: `proof` present, the commit op declares a digest for this block id, and
`await canonicalBlockHash(newBlock) === declaredDigest` → `storage.saveBlockProof(rev, proof)`.
Otherwise store no proof and log `commit:proof-digest-mismatch` (or `commit:proof-undeclared`).

This one rule handles every awkward case without a second flag:

- A member that **diverged** (committed onto a lagging base, `storage-repo.ts:589`) computes a
  different hash, stores no proof, and simply falls back to corroboration exactly as today — instead
  of silently serving divergent content as certified. The mismatch log is also the first signal this
  system has ever had that a member diverged.
- A member that **abstained** at vote time (base-rev mismatch) still checks here, because by commit
  time it has actually materialized. If it happens to agree, it legitimately keeps the proof.
- A **tombstone** (no `newBlock`) declares no digest and stores no proof.
- A commit with **no `blockDigests`** (pre-upgrade client) stores no proof.

Build the proof only for `membershipVersion === 2` records; skip and log otherwise.

## Edge cases & interactions

- **v1 / unversioned record** — never certifiable. Must fall back cleanly (no proof written, no
  half-verified proof produced), never half-verify.
- **Duplicate signer ids in `promises` / `commits`.** Object keys cannot duplicate in a parsed JSON
  object, but the *counting* must still dedupe across the id set and must not count a signer absent
  from `peerIds`. Pin both with hand-built proof objects.
- **A signer id that is not Ed25519**, and a `signature` string that is not valid base64url: reject
  the proof; never penalize.
- **Replay** — a genuine proof for rev 5 presented for rev 9; the same proof presented for a
  different block id in the same commit; a proof whose `actionId` does not match. Test all three
  explicitly against step 7.
- **Multi-block commit.** One proof certifies several block ids; each id resolves its own digest from
  the same commit op. Test a two-block commit where one id verifies and the other's bytes are
  tampered.
- **Tampering with `proof.message` after the fact** must fail at step 3 (message-hash mismatch), and
  tampering with `proof.peerIds` at step 2.
- **`saveReplicatedBlock`'s monotonic no-op** (`storage-repo.ts:822`) does not run `internalCommit`,
  so it writes no proof — correct for this ticket; `require-proof-on-block-push` revisits it.
- **Idempotent re-commit.** `StorageRepo.commit` skips a block whose `(rev, actionId)` already landed
  (`storage-repo.ts:590`). A retry carrying a proof for an already-committed revision must not
  regress or duplicate stored state; decide whether it back-fills a missing proof (preferred, it is
  strictly additive) and pin the choice.
- **Storage-backend round trip.** A proof written and read back through `KvRawStorage` and through
  the cached wrapper must be byte-identical — a codec that reorders object keys would break
  `canonicalJson` recomputation. Pin a round-trip test.

## TODO

- Add `membershipDigestFromIds` to `db-core/src/cluster/membership.ts`; make `membershipDigest`
  delegate; export from the barrel.
- Add `packages/db-p2p/src/cluster/commit-proof.ts`: `BlockCommitProof`, `ProofClaim`,
  `ProofThresholds`, `ProofFailure`, `ProofVerdict`, `verifyBlockCommitProofClaim`,
  `verifyBlockCommitProofContent`, and a `buildBlockCommitProof(record)` builder.
- Add `getBlockProof` / `saveBlockProof` to `IRawStorage`, `IBlockStorage`, `BlockStorage`,
  `KvRawStorage`, and the `cached-raw-storage.ts` wrappers; follow `raw-store-codec.ts` conventions.
- Add the optional `proof` parameter to `StorageRepo.commit` → `internalCommit`; implement the
  digest-match retention rule with its two log lines.
- Build and pass the proof from `ClusterMember.applyConsensusOperation`, beside the existing
  `captureCommitCert` call.
- Tests: happy-path verify (claim and content); each `ProofFailure` reason reachable and returned;
  replay in its three shapes; tampered message / peerIds; duplicate and unknown signers; multi-block;
  storage round trip through both backends; proof written on match, withheld on mismatch, withheld on
  tombstone, withheld on a commit with no digests.
- Add a code comment recording the **measured** proof size for a 10-peer cohort.
- Document the artifact and the retention rule in `docs/internals.md`.
- Run `yarn build && yarn typecheck && yarn test` from the root.
