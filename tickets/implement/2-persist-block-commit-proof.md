----
description: Keep the group's signed approval of a write on disk next to the record it approved, and add a checker that can confirm, offline, that a copy of the record really is the one the group agreed on.
prereq: commit-cert-digest-member-check
files: packages/db-core/src/cluster/membership.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/peer-key-binding.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/storage-repo.ts
difficulty: hard
----

# Persist a durable, self-verifying commit proof per revision

<!-- resume-note -->
## Status after third implement run (2026-08-27 — ALL production code done + built, budget-stopped
before tests/docs)

**Every source change is DONE and both `yarn workspace @optimystic/db-core build` and
`yarn workspace @optimystic/db-p2p build` pass.** Do not re-derive or re-edit production code —
resume at "Remaining work" below (tests, size measurement, docs, full validation only).

Done (in working tree; runs 1–2 already committed membership.ts + commit-proof.ts):

1. `db-core/src/cluster/membership.ts` — `membershipDigestFromIds` (committed, prior run).
2. `db-p2p/src/cluster/commit-proof.ts` — full verify/build module (committed, prior run), PLUS
   this run added exported `proofDeclaredDigest(proof, claim)` — resolves the claimed commit op's
   declared digest via the SAME op-resolution the verifier uses, consumed by StorageRepo's
   retention rule so the two can never drift.
3. `db-p2p/src/storage/raw-store-codec.ts` — `blockProofActionKey(rev)` = `` `~proof:${rev}` ``,
   documented reserved action-id namespace (proofs ride the transactions store; zero driver fanout).
4. `db-p2p/src/storage/i-raw-storage.ts` — `getBlockProof`/`saveBlockProof` + contract note that no
   revision-delete site exists today (the "whatever deletes a revision" clause resolved to a comment).
5. `db-p2p/src/storage/kv-raw-storage.ts` — implements both via `driver.get/putTransaction` with
   the proof key + `encodeJson/decodeJson`. `MemoryRawStorage`/`CachedRawStorage` inherit free.
6. `db-p2p/src/storage/i-block-storage.ts` + `block-storage.ts` — rev-only pair, forwards.
7. `db-p2p/src/storage/cached-raw-storage.ts` — comment on `putTransaction` noting the harmless
   Transform-cast JSON passthrough for proof bytes.
8. `db-p2p/src/storage/storage-repo.ts` — `ICommitProofPersister` (beside `ICommitDigestPreviewer`;
   StorageRepo implements it); `commit(request, _options?, proof?)` threads to
   `internalCommit(..., proof?)`; persist site AFTER `setLatest`; idempotent-retry **back-fill** at
   the alreadyDone `continue` (guards `getBlockProof === undefined`, `getBlock` in try/catch);
   shared helper `persistProofIfContentMatches` — digest-match retention rule, logs
   `commit:proof-undeclared` / `commit:proof-digest-mismatch` / `commit:proof-persist-failed`,
   never throws (a proof fault must not fail a landed commit).
9. `db-p2p/src/cluster/cluster-repo.ts` — `buildBlockCommitProof(record)` in the commit branch of
   `applyConsensusOperation` (beside `captureCommitCert`), `cluster-member:commit-proof-skipped`
   log for v1 records, commit called via `(storageRepo as IRepo & ICommitProofPersister)`.
10. `db-p2p/src/index.ts` — exports `./cluster/commit-proof.js`.
11. `db-p2p/test/mid-ddl-crash.spec.ts` — `CrashingRawStorage` got the two passthroughs.
12. `db-p2p/test/storage-monitor.spec.ts` — stub got `getBlockProof/saveBlockProof: reject` entries.
13. `db-p2p/src/libp2p-node-base.ts` — **necessary side-fix, flag to reviewer**: `repoProxy.commit`
    now annotates `const target: IRepo = coordinatedRepo ?? storageRepo`. The un-annotated union
    `IRepo | StorageRepo` stopped compiling once StorageRepo.commit gained the 3rd optional param
    (TS synthesizes a different composite call signature on arity mismatch and rejected
    `RepoCommitRequest`'s optional `tailId`). The proxy is the plain-IRepo seam; no proof flows there.

## Remaining work (in order)

- **Tests** — new `packages/db-p2p/test/commit-proof.spec.ts`. Copy the harness from
  `test/cluster-commit-digest.spec.ts` (`makeKeyPair`, `makeClusterPeers`, seeded StorageRepo via
  `pend`, `clusterMember({storageRepo, peerNetwork, peerId, privateKey})`) and the v2 signing
  recipe in "### Test harness" below. `Signature` = `{type:'approve'|'reject'|'conflict';
  signature: string; ...}` (db-core `cluster/structs.ts:11`); sign
  `clusterVoteSigningPayload(hash,'approve')` with `privateKey.sign`, base64url encode.
  Matrix (from the TODO list, all still open):
  - Pure verify: happy claim+content; every `ProofFailure` reachable — `legacy-record` (v/mv),
    `membership-mismatch` (tampered peerIds), `message-hash-mismatch` (tampered message),
    `unknown-signer` (extra signer outside peerIds causing threshold shortfall — build the record's
    digest WITH only the real ids), `duplicate-signer` (hand-built duplicated id in `peerIds`),
    `non-ed25519-signer` (garbage id included in peerIds+digest from the start, with a votes entry),
    `malformed-signature` (bad base64url / wrong bytes), `promise-threshold` (2-of-3 approves at
    0.75 ⇒ ceil(2.25)=3), `commit-threshold` (full promises, 1-of-3 commits at 0.5),
    `claim-not-in-message` replay ×3 (wrong rev / wrong blockId / wrong actionId),
    `no-digest-declared`, `digest-mismatch` (tampered bytes), `malformed-proof` (null/garbage).
    Non-approve votes ignored silently. Multi-block: one proof, two ids, one verifies + one tampered.
  - `buildBlockCommitProof`: v2 ⇒ proof with sorted peerIds; v1/unversioned ⇒ undefined.
  - Storage round trip: proof saved+read deep-equal through `MemoryRawStorage` AND
    `new CachedRawStorage(new MemoryRawStorage())`; verify claim still passes after the round trip.
  - Retention rule, direct `StorageRepo.commit(commit, undefined, proof)` calls (no consensus
    needed — `persistProofIfContentMatches` only reads `proofDeclaredDigest`, no sig verify):
    persisted on digest match; withheld on mismatch; withheld when no `blockDigests`
    (undeclared); withheld on tombstone (pend a `{delete}`); back-fill on idempotent re-commit
    (commit without proof, re-commit same `(actionId, rev)` with proof ⇒ stored).
  - End-to-end via `member.update` with a FULLY-SIGNED v2 record (recipe in "### Test harness"
    below, 2 peers ⇒ both must sign both rounds): proof lands in raw storage on match.
  - Size: 10-peer cohort, two-block fully-signed commit — assert
    `JSON.stringify(proof).length < MAX_CONTROL_MESSAGE_BYTES` (`src/protocol-limits.ts:19`), print
    the number, then **bake the measured number into the `TODO(2-persist-block-commit-proof)` size
    comment in commit-proof.ts** (and remove the TODO marker).
- **Docs** — `docs/internals.md`: the artifact, the reserved `~proof:` key, the digest-match
  retention rule + its two log lines, and that `saveReplicatedBlock` writes no proof (revisited by
  `require-proof-on-block-push`).
- **Validate** — root `yarn build && yarn typecheck && yarn test` (foreground, optionally
  `2>&1 | tee tickets/.logs/2-persist-block-commit-proof.test.log`).
- Then write the review/ handoff (spec deviations to flag: the extra `malformed-proof` enum value;
  content-verify mapping an undigestable block to `digest-mismatch`; the libp2p-node-base
  annotation fix) and delete this ticket.

## Findings from prior implement run (2026-08-27 — investigation complete)

Everything below was verified against the current code — implement directly; do not re-derive
these decisions.

### Storage decision (the big one): do NOT extend `RawStoreDriver`

`KvRawStorage` delegates every operation to a `RawStoreDriver` (`raw-store-driver.ts`), and that
interface has **five production implementations across four other packages** (`db-p2p-storage-fs`,
`-web`, `-ns`, `-rn`, plus `MemoryStoreDriver`) and several test drivers. Adding a proofs store to
the driver would fan out far beyond this ticket's `files:` list. Instead, ride the **existing
transactions store** with a synthetic action-id key:

- Add `blockProofActionKey(rev: number): ActionId` (returns `` `~proof:${rev}` ``) to
  `raw-store-codec.ts`, documented as a reserved key namespace.
- `KvRawStorage.getBlockProof/saveBlockProof` call `driver.getTransaction/putTransaction` with that
  key and `encodeJson/decodeJson`.
- Why this is safe: nothing enumerates the transactions store (no `listTransactions` exists;
  `recover()` and `materializeBlock` only probe action-ids read from the *revisions* store, so the
  synthetic key can never leak into real flows). The FS driver already percent-encodes `:` in
  action-id filenames (real ids look like `tx:<hash>`, `stamp:<hash>`, `inv:<...>` — see
  `file-storage.ts:12-20`), so `~proof:2` round-trips on every backend.
- **Free forwarding**: `MemoryRawStorage` and `CachedRawStorage` both `extends KvRawStorage`, and
  the proof rides `CachedStoreDriver.getTransaction/putTransaction`
  (`cached-store-driver.ts:701-721`) → `RawStorageDriverAdapter.getTransaction/putTransaction` →
  inner `IRawStorage.getTransaction/saveTransaction` with **zero new wrapper code**. (The adapter
  decodes the proof as a `Transform` cast — harmless JSON passthrough; note it in a comment.)
- `canonicalJson` sorts object keys, so a codec that reorders keys does NOT actually break hash
  recomputation — the ticket's worry is softer than stated. Still pin the round-trip test.

`mid-ddl-crash.spec.ts` has a `CrashingRawStorage implements IRawStorage` — adding the two methods
to the interface requires adding passthroughs there too.

### Threading the proof into the commit

- `ClusterMember.storageRepo` is typed `IRepo` (`cluster-repo.ts:262`); the commit call is at
  `cluster-repo.ts:1526` inside `applyConsensusOperation` (commit branch starts ~1505, beside the
  existing `captureCommitCert` at :1520-1523). `IRepo.commit` takes 2 args, so a 3-arg call needs a
  named contract: add `ICommitProofPersister { commit(request, options?, proof?) }` to
  `storage-repo.ts` (same pattern as `ICommitDigestPreviewer` at `storage-repo.ts:105`), have
  `StorageRepo` implement it, and in the member cast
  `this.storageRepo as IRepo & ICommitProofPersister` — the extra arg is harmless at runtime for
  plain `IRepo` mocks, so no structural probe is needed.
- `buildBlockCommitProof(record)` is a **cheap projection, no hashing**: copy
  `messageHash/message/promises/commits/membershipDigest`, set
  `peerIds = Object.keys(record.peers).sort()`; return `undefined` unless
  `membershipVersion === 2 && typeof membershipDigest === 'string'` (member logs the skip).
- `internalCommit` is at `storage-repo.ts:943` (ticket said :901; `pruneSupersededMaterialization`
  actually lives in `block-storage.ts:135` and is *called* at `storage-repo.ts:1002`). Persist the
  proof **after `setLatest`**, and wrap `saveBlockProof` in try/catch+log — a proof-persist fault
  must NOT fail a commit that already durably landed (`commit()` would report `success:false` for a
  landed commit).
- **Back-fill site** for idempotent re-commit: the `alreadyDone` `continue` at
  `storage-repo.ts:615-617`. Guard on `getBlockProof(request.rev) === undefined`, read
  `storage.getBlock(request.rev)` in try/catch (can throw on unmaterializable), apply the same
  digest-match rule. Runs inside the latched critical section — fine.
- Factor one shared helper (blockId, rev, actionId, storage, proof, block|undefined) used by both
  sites: tombstone/undeclared → log `commit:proof-undeclared`; hash mismatch → log
  `commit:proof-digest-mismatch`; match → `saveBlockProof`.
- **No site deletes revision records today** — `RawStoreDriver` has no revision delete at all, and
  invalidations write compensating *forward* revisions. The "whatever deletes a revision must
  delete its proof" clause resolves to a code comment on `saveBlockProof`.

### Verification semantics (decisions already weighed — implement as stated)

- Promise threshold: `approves >= Math.ceil(superMajorityThreshold * peerIds.length)` (mirrors
  `getTransactionPhase`, `cluster-repo.ts:809`).
- Commit threshold: `approves > peerIds.length * simpleMajorityThreshold`, and document that
  callers pass **0.5** to mirror `ClusterMember.hasMajority` (`cluster-repo.ts:876` hardcodes
  `> total/2`; the config's 0.51 default is NOT what members actually enforce).
- Per-entry counting rules: non-`approve` vote → ignore silently; signer not in `peerIds` → skip
  and note (if a threshold then fails, return `unknown-signer` rather than the bare threshold
  reason — that is the "record" in the spec); signer in `peerIds` but not Ed25519 → immediate
  `non-ed25519-signer`; signature that fails base64url decode OR cryptographic verify → immediate
  `malformed-signature`; duplicate ids **in the `peerIds` array itself** (Set size ≠ length) →
  `duplicate-signer` (JSON-parsed vote maps cannot carry duplicate keys, so the array is the
  reachable site — pin with a hand-built object).
- Add one extra failure value **`malformed-proof`** to `ProofFailure` for structurally-invalid
  input (wrong types, missing fields, throwing shapes): the spec's enum has no honest fit and
  "pure and total on hostile input" needs a catch-all. Deviation from spec, deliberate — mention in
  the review handoff.
- Membership digest recompute: `membershipDigestFromIds(proof.peerIds)` — the db-core helper this
  ticket extracts; `membership.ts:26` `membershipDigest` delegates to it (`Object.keys(peers ?? {})`,
  helper sorts a copy). The cluster barrel (`db-core/src/cluster/index.ts`) already `export *`s
  membership.ts, so no barrel edit needed there. Export `commit-proof.js` from
  `db-p2p/src/index.ts` beside the existing `./cluster/commit-cert.js` line (:5).

### Test harness (proven pattern to copy)

`packages/db-p2p/test/cluster-commit-digest.spec.ts` has everything: `makeKeyPair` (Ed25519 via
`generateKeyPair`/`peerIdFromPrivateKey`), `makeClusterPeers`, a real
`StorageRepo(new BlockStorage(id, new MemoryRawStorage()))` seeded via `pend`, and driving
`clusterMember(...).update(record)`. To build a fully-signed **v2** record for proof tests:

1. `digest = await membershipDigest(peers)`; message with one `{ commit }` op carrying
   `blockDigests`; `messageHash = computeClusterMessageHash(message, digest)`; set
   `membershipVersion: 2, membershipDigest: digest` on the record.
2. `promiseHash = computeClusterPromiseHash(messageHash, message, digest)`; each peer signs
   `clusterVoteSigningPayload(promiseHash, 'approve')` with `privateKey.sign`, base64url via
   `uint8ArrayToString`.
3. `commitHash = computeClusterCommitHash(messageHash, message, promises, digest)`; sign commits
   the same way. (`canonicalJson` sorts keys, so promise-map insertion order is irrelevant.)
4. A record fully signed this way passes `validateRecord` and drives `member.update` straight to
   Consensus → `applyConsensusOperation` → `StorageRepo.commit` — use this for the end-to-end
   "proof persisted on match / withheld on mismatch" test against a pend-seeded repo.

Framework is mocha+chai (`expect(...).to.equal`); run `yarn workspace @optimystic/db-p2p test`
(and `yarn workspace @optimystic/db-core test` for the membership helper), then root
`yarn build && yarn typecheck && yarn test`. Long runs: stream to foreground, optionally
`2>&1 | tee tickets/.logs/2-persist-block-commit-proof.test.log`.

### Remaining work = the ticket's TODO list, unchanged

Nothing from the TODO list is done. Measure the real proof size (10-peer cohort, two-block commit,
`JSON.stringify(proof).length`) in a test, then bake the measured number into the commit-proof.ts
comment — do not estimate.
<!-- /resume-note -->

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
