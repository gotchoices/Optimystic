import { expect } from 'chai';
import {
	buildBlockCommitProof, mintSoloCommitProof, proofDeclaredDigest, verifyBlockCommitProofClaim,
	verifyBlockCommitProofContent,
	type BlockCommitProof, type ProofClaim, type ProofFailure, type ProofThresholds
} from '../src/cluster/commit-proof.js';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { withBlockWriteLatch } from '../src/storage/block-latch.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { MAX_CONTROL_MESSAGE_BYTES } from '../src/protocol-limits.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import {
	PROOF_THRESHOLDS, makeKeyPair, makeKeyPairs, makeMessage, makeSignedProof, makeSignedRecord,
	signVote, type KeyPair
} from './support/commit-proof-fixtures.js';
import {
	canonicalBlockHash, computeClusterCommitHash, computeClusterMessageHash,
	computeClusterPromiseHash, membershipDigestFromIds
} from '@optimystic/db-core';
import type {
	ActionId, BlockContentDigests, BlockId, ClusterRecord, CommitRequest, IBlock,
	IPeerNetwork, Signature
} from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';

// --- Harness. The shared builders (real Ed25519 key pairs, fully-signed v2 records built with the
// SAME hash/signing recipe the coordinator and members use) live in
// `support/commit-proof-fixtures.ts`, so this spec and the archive-serving spec cannot verify
// against differently-built proofs. What stays here is failure injection, which is this spec's own
// subject. ---

const BLOCK = 'block-1' as BlockId;
const BLOCK2 = 'block-2' as BlockId;
const ACTION = 'action-1' as ActionId;

const THRESHOLDS = PROOF_THRESHOLDS;

const makeCommit = (blockDigests?: BlockContentDigests, over: Partial<CommitRequest> = {}): CommitRequest => ({
	actionId: ACTION,
	blockIds: [BLOCK],
	tailId: BLOCK,
	rev: 1,
	...(blockDigests ? { blockDigests } : {}),
	...over
});

/** How one signer votes in a hand-built proof: sign properly with `key`, or carry `verbatim` as-is. */
type VoteSpec = { key: PrivateKey; type?: 'approve' | 'reject'; reason?: string } | { verbatim: Signature };

/**
 * Hand-build a proof over an EXPLICIT peer-id list (which need not match the signer set) so tests
 * can reach the counting failures: signers outside the list, garbage ids inside it, short rounds.
 * Hashes are internally consistent (digest from `peerIds`, commitHash over the exact promise map),
 * so only the deliberately-injected defect trips the verifier.
 */
const handProof = async (
	peerIds: string[], commit: CommitRequest,
	promiseSpec: Record<string, VoteSpec>, commitSpec: Record<string, VoteSpec>
): Promise<BlockCommitProof> => {
	const message = makeMessage(commit);
	const digest = await membershipDigestFromIds(peerIds);
	const messageHash = await computeClusterMessageHash(message, digest);
	const promiseHash = await computeClusterPromiseHash(messageHash, message, digest);
	const promises: Record<string, Signature> = {};
	for (const [id, spec] of Object.entries(promiseSpec)) {
		promises[id] = 'verbatim' in spec ? spec.verbatim : await signVote(spec.key, promiseHash, spec.type, spec.reason);
	}
	const commitHash = await computeClusterCommitHash(messageHash, message, promises, digest);
	const commitVotes: Record<string, Signature> = {};
	for (const [id, spec] of Object.entries(commitSpec)) {
		commitVotes[id] = 'verbatim' in spec ? spec.verbatim : await signVote(spec.key, commitHash, spec.type, spec.reason);
	}
	return {
		v: 1, messageHash, message, promises, commits: commitVotes,
		membershipVersion: 2, membershipDigest: digest, peerIds: [...peerIds].sort()
	};
};

const claimFor = (commit: CommitRequest, blockId: BlockId = BLOCK): ProofClaim =>
	({ blockId, rev: commit.rev, actionId: commit.actionId });

const expectFailure = async (verdictPromise: Promise<unknown>, reason: ProofFailure): Promise<void> => {
	const verdict = await verdictPromise as { ok: boolean; reason?: string };
	expect(verdict.ok).to.equal(false);
	expect(verdict.reason).to.equal(reason);
};

const insertBlock = (id: BlockId = BLOCK): IBlock => ({
	header: { id, type: 'test', collectionId: 'collection-1' as BlockId },
	items: ['x']
} as unknown as IBlock);

describe('BlockCommitProof', () => {
	describe('buildBlockCommitProof', () => {
		it('projects a v2 record into a proof with the sorted peer-id list', async () => {
			const keyPairs = await makeKeyPairs(3);
			const record = await makeSignedRecord(keyPairs, makeCommit());
			const proof = buildBlockCommitProof(record)!;
			expect(proof.v).to.equal(1);
			expect(proof.messageHash).to.equal(record.messageHash);
			expect(proof.message).to.equal(record.message);
			expect(proof.membershipDigest).to.equal(record.membershipDigest);
			expect(proof.peerIds).to.deep.equal(Object.keys(record.peers).sort());
		});

		it('returns undefined for a v1 record and for an unversioned record', async () => {
			const keyPairs = await makeKeyPairs(2);
			const record = await makeSignedRecord(keyPairs, makeCommit());
			expect(buildBlockCommitProof({ ...record, membershipVersion: 1 })).to.equal(undefined);
			const { membershipVersion: _v, membershipDigest: _d, ...unversioned } = record;
			expect(buildBlockCommitProof(unversioned as ClusterRecord)).to.equal(undefined);
		});
	});

	describe('mintSoloCommitProof', () => {
		it('mints a one-peer proof that content-verifies for the exact (blockId, rev, actionId) it committed', async () => {
			const { peerId, privateKey } = await makeKeyPair();
			const block = insertBlock();
			const commit = makeCommit({ [BLOCK]: { digest: await canonicalBlockHash(block) } });
			const proof = await mintSoloCommitProof(peerId.toString(), privateKey, makeMessage(commit));
			expect(proof.peerIds).to.deep.equal([peerId.toString()]);
			const verdict = await verifyBlockCommitProofContent(proof, claimFor(commit), block, THRESHOLDS);
			expect(verdict.ok, `solo proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);
		});

		it('stops replay: a minted proof presented for a neighbouring revision fails claim-not-in-message', async () => {
			const { peerId, privateKey } = await makeKeyPair();
			const commit = makeCommit({ [BLOCK]: { digest: 'declared' } });
			const proof = await mintSoloCommitProof(peerId.toString(), privateKey, makeMessage(commit));
			await expectFailure(verifyBlockCommitProofClaim(
				proof, { ...claimFor(commit), rev: commit.rev + 1 }, THRESHOLDS), 'claim-not-in-message');
		});

		it('growth from one to many: a one-peer proof at rev N and a multi-peer proof at rev N+1 both verify', async () => {
			// Nothing keys proof retention or verification to cohort size — pinned rather than assumed.
			const { peerId, privateKey } = await makeKeyPair();
			const soloCommit = makeCommit({ [BLOCK]: { digest: 'digest-rev-1' } });
			const soloProof = await mintSoloCommitProof(peerId.toString(), privateKey, makeMessage(soloCommit));
			const grownCommit = makeCommit({ [BLOCK]: { digest: 'digest-rev-2' } }, { rev: 2 });
			const { proof: grownProof } = await makeSignedProof(3, grownCommit);

			expect((await verifyBlockCommitProofClaim(soloProof, claimFor(soloCommit), THRESHOLDS)).ok).to.equal(true);
			expect((await verifyBlockCommitProofClaim(grownProof, claimFor(grownCommit), THRESHOLDS)).ok).to.equal(true);
		});
	});

	describe('verifyBlockCommitProofClaim', () => {
		const DIGEST = 'declared-digest';
		const commitWithDigest = () => makeCommit({ [BLOCK]: { digest: DIGEST } });

		it('verifies a genuine fully-signed proof and surfaces the declared digest', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			const verdict = await verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS);
			expect(verdict).to.deep.equal({ ok: true, declaredDigest: DIGEST });
		});

		it('verifies a claim on a commit op that declares no digests (declaredDigest undefined)', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			const verdict = await verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS);
			expect(verdict).to.deep.equal({ ok: true, declaredDigest: undefined });
		});

		it('ignores properly-signed reject votes in both rounds without failing (they simply do not count)', async () => {
			// 4 peers, superMajority = ceil(3) = 3: three approves + one signed reject per round passes,
			// proving a non-approve vote is skipped silently rather than treated as malformed.
			const commit = commitWithDigest();
			const [a, b, c, d] = await makeKeyPairs(4);
			const ids = [a!, b!, c!, d!].map(kp => kp.peerId.toString());
			const proof = await handProof(ids, commit,
				{
					[ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey },
					[ids[2]!]: { key: c!.privateKey }, [ids[3]!]: { key: d!.privateKey, type: 'reject', reason: 'no' }
				},
				{
					[ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey },
					[ids[2]!]: { key: c!.privateKey }, [ids[3]!]: { key: d!.privateKey, type: 'reject', reason: 'no' }
				});
			const verdict = await verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS);
			expect(verdict.ok).to.equal(true);
		});

		it('rejects a wrong proof version and a wrong membership version as legacy-record', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			await expectFailure(verifyBlockCommitProofClaim(
				{ ...proof, v: 2 as never }, claimFor(commit), THRESHOLDS), 'legacy-record');
			await expectFailure(verifyBlockCommitProofClaim(
				{ ...proof, membershipVersion: 1 as never }, claimFor(commit), THRESHOLDS), 'legacy-record');
		});

		it('rejects tampered peerIds as membership-mismatch', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			const intruder = (await makeKeyPair()).peerId.toString();
			await expectFailure(verifyBlockCommitProofClaim(
				{ ...proof, peerIds: [...proof.peerIds, intruder] }, claimFor(commit), THRESHOLDS), 'membership-mismatch');
			await expectFailure(verifyBlockCommitProofClaim(
				{ ...proof, peerIds: proof.peerIds.slice(1) }, claimFor(commit), THRESHOLDS), 'membership-mismatch');
		});

		it('rejects a tampered message as message-hash-mismatch', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			const tampered = { ...proof, message: { ...proof.message, expiration: (proof.message.expiration ?? 0) + 1 } };
			await expectFailure(verifyBlockCommitProofClaim(tampered, claimFor(commit), THRESHOLDS), 'message-hash-mismatch');
		});

		it('reports unknown-signer when a threshold fails and an out-of-cohort signature was skipped', async () => {
			// Denominator lists three real peers, but only two of them promised; the third promise
			// comes from an outsider. approves = 2 < ceil(2.25) = 3, and the skipped outsider is the
			// record of why -- so the verdict names it instead of the bare threshold.
			const commit = commitWithDigest();
			const [a, b, c] = await makeKeyPairs(3);
			const outsider = await makeKeyPair();
			const ids = [a!, b!, c!].map(kp => kp.peerId.toString());
			const proof = await handProof(ids, commit,
				{
					[ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey },
					[outsider.peerId.toString()]: { key: outsider.privateKey }
				},
				{ [ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey }, [ids[2]!]: { key: c!.privateKey } });
			await expectFailure(verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS), 'unknown-signer');
		});

		it('rejects a duplicated id in the peerIds denominator as duplicate-signer', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			const duplicated = { ...proof, peerIds: [...proof.peerIds, proof.peerIds[0]!] };
			await expectFailure(verifyBlockCommitProofClaim(duplicated, claimFor(commit), THRESHOLDS), 'duplicate-signer');
		});

		it('rejects a cohort id that names no Ed25519 key as non-ed25519-signer', async () => {
			// The garbage id participates from the START (inside peerIds and the digest), so nothing
			// else mismatches -- the verifier fails precisely on the unrecoverable key.
			const commit = commitWithDigest();
			const [a, b] = await makeKeyPairs(2);
			const garbage = 'not-a-peer-id';
			const ids = [a!.peerId.toString(), b!.peerId.toString(), garbage];
			const proof = await handProof(ids, commit,
				{
					[ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey },
					[garbage]: { verbatim: { type: 'approve', signature: 'AA' } }
				},
				{ [ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey } });
			await expectFailure(verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS), 'non-ed25519-signer');
		});

		it('rejects a signature that is not base64url as malformed-signature', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			const [firstId] = Object.keys(proof.promises);
			const promises = { ...proof.promises, [firstId!]: { type: 'approve', signature: '!!!not-base64url!!!' } as Signature };
			await expectFailure(verifyBlockCommitProofClaim({ ...proof, promises }, claimFor(commit), THRESHOLDS), 'malformed-signature');
		});

		it('rejects a signature over the wrong bytes as malformed-signature', async () => {
			const commit = commitWithDigest();
			const { keyPairs, proof } = await makeSignedProof(3, commit);
			// A REAL signature by a cohort key -- but over the message hash, not the promise hash.
			const wrongPayload = await signVote(keyPairs[0]!.privateKey, proof.messageHash);
			const promises = { ...proof.promises, [keyPairs[0]!.peerId.toString()]: wrongPayload };
			await expectFailure(verifyBlockCommitProofClaim({ ...proof, promises }, claimFor(commit), THRESHOLDS), 'malformed-signature');
		});

		it('rejects a short promise round as promise-threshold (2 of 3 at 0.75 needs ceil(2.25) = 3)', async () => {
			const commit = commitWithDigest();
			const [a, b, c] = await makeKeyPairs(3);
			const ids = [a!, b!, c!].map(kp => kp.peerId.toString());
			const proof = await handProof(ids, commit,
				{ [ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey } },
				{ [ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey }, [ids[2]!]: { key: c!.privateKey } });
			await expectFailure(verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS), 'promise-threshold');
		});

		it('rejects a short commit round as commit-threshold (1 of 3 is not > 1.5)', async () => {
			const commit = commitWithDigest();
			const [a, b, c] = await makeKeyPairs(3);
			const ids = [a!, b!, c!].map(kp => kp.peerId.toString());
			const proof = await handProof(ids, commit,
				{ [ids[0]!]: { key: a!.privateKey }, [ids[1]!]: { key: b!.privateKey }, [ids[2]!]: { key: c!.privateKey } },
				{ [ids[0]!]: { key: a!.privateKey } });
			await expectFailure(verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS), 'commit-threshold');
		});

		it('stops replay: a genuine proof presented for the wrong rev, block id, or action id', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(3, commit);
			await expectFailure(verifyBlockCommitProofClaim(
				proof, { ...claimFor(commit), rev: commit.rev + 8 }, THRESHOLDS), 'claim-not-in-message');
			await expectFailure(verifyBlockCommitProofClaim(
				proof, { ...claimFor(commit), blockId: 'block-other' as BlockId }, THRESHOLDS), 'claim-not-in-message');
			await expectFailure(verifyBlockCommitProofClaim(
				proof, { ...claimFor(commit), actionId: 'action-other' as ActionId }, THRESHOLDS), 'claim-not-in-message');
		});

		it('never certifies an empty cohort (both thresholds are vacuous at zero denominators)', async () => {
			// `superMajority = ceil(0.75 * 0) = 0`, so the promise gate `approves >= 0` passes on an
			// empty cohort. Only the strict commit gate (`0 > 0` is false) stops it — pin that, so a
			// later relaxation of either comparison cannot make a signer-less proof verifiable.
			const commit = commitWithDigest();
			const proof = await handProof([], commit, {}, {});
			await expectFailure(verifyBlockCommitProofClaim(proof, claimFor(commit), THRESHOLDS), 'commit-threshold');
		});

		it('rejects structurally-invalid input as malformed-proof, never throwing', async () => {
			const commit = commitWithDigest();
			const { proof } = await makeSignedProof(2, commit);
			const claim = claimFor(commit);
			for (const hostile of [
				null,
				'garbage',
				{ ...proof, promises: null },
				{ ...proof, commits: ['not', 'a', 'map'] },
				{ ...proof, peerIds: 'nope' },
				{ ...proof, peerIds: [42] },
				{ ...proof, message: null },
				{ ...proof, message: { operations: 'x' } },
				{ ...proof, messageHash: 42 }
			]) {
				await expectFailure(verifyBlockCommitProofClaim(hostile as never, claim, THRESHOLDS), 'malformed-proof');
			}
		});
	});

	describe('verifyBlockCommitProofContent', () => {
		it('accepts the block whose canonical hash equals the declared digest', async () => {
			const block = insertBlock();
			const digest = await canonicalBlockHash(block);
			const commit = makeCommit({ [BLOCK]: { digest } });
			const { proof } = await makeSignedProof(3, commit);
			const verdict = await verifyBlockCommitProofContent(proof, claimFor(commit), block, THRESHOLDS);
			expect(verdict).to.deep.equal({ ok: true, declaredDigest: digest });
		});

		it('rejects when the commit op declared no digest for the block (no-digest-declared)', async () => {
			const commit = makeCommit();
			const { proof } = await makeSignedProof(3, commit);
			await expectFailure(verifyBlockCommitProofContent(
				proof, claimFor(commit), insertBlock(), THRESHOLDS), 'no-digest-declared');
		});

		it('rejects tampered bytes as digest-mismatch', async () => {
			const block = insertBlock();
			const commit = makeCommit({ [BLOCK]: { digest: await canonicalBlockHash(block) } });
			const { proof } = await makeSignedProof(3, commit);
			const tampered = { ...block, items: ['tampered'] } as unknown as IBlock;
			await expectFailure(verifyBlockCommitProofContent(
				proof, claimFor(commit), tampered, THRESHOLDS), 'digest-mismatch');
		});

		it('reads an undigestable block shape as digest-mismatch rather than throwing', async () => {
			const commit = makeCommit({ [BLOCK]: { digest: 'declared' } });
			const { proof } = await makeSignedProof(2, commit);
			const circular: Record<string, unknown> = {};
			circular['self'] = circular;
			await expectFailure(verifyBlockCommitProofContent(
				proof, claimFor(commit), circular as unknown as IBlock, THRESHOLDS), 'digest-mismatch');
		});

		it('one multi-block proof certifies each id independently: intact block passes, tampered fails', async () => {
			const blockA = insertBlock(BLOCK);
			const blockB = insertBlock(BLOCK2);
			const commit = makeCommit({
				[BLOCK]: { digest: await canonicalBlockHash(blockA) },
				[BLOCK2]: { digest: await canonicalBlockHash(blockB) }
			}, { blockIds: [BLOCK, BLOCK2] });
			const { proof } = await makeSignedProof(3, commit);

			const intact = await verifyBlockCommitProofContent(proof, claimFor(commit, BLOCK), blockA, THRESHOLDS);
			expect(intact.ok).to.equal(true);

			const tamperedB = { ...blockB, items: ['tampered'] } as unknown as IBlock;
			await expectFailure(verifyBlockCommitProofContent(
				proof, claimFor(commit, BLOCK2), tamperedB, THRESHOLDS), 'digest-mismatch');
		});
	});

	describe('storage round trip', () => {
		const roundTrip = async (storage: IRawStorage): Promise<void> => {
			const commit = makeCommit({ [BLOCK]: { digest: 'stored-digest' } });
			const { proof } = await makeSignedProof(3, commit);
			expect(await storage.getBlockProof(BLOCK, commit.rev), 'no proof before save').to.equal(undefined);
			await storage.saveBlockProof(BLOCK, commit.rev, proof);
			const restored = await storage.getBlockProof(BLOCK, commit.rev);
			expect(restored).to.deep.equal(proof);
			// The restored copy must still verify -- the codec must not have reordered or dropped
			// anything the hash recomputation depends on.
			const verdict = await verifyBlockCommitProofClaim(restored!, claimFor(commit), THRESHOLDS);
			expect(verdict.ok).to.equal(true);
		};

		it('MemoryRawStorage round-trips a proof byte-faithfully', async () => {
			await roundTrip(new MemoryRawStorage());
		});

		it('CachedRawStorage round-trips a proof byte-faithfully', async () => {
			await roundTrip(new CachedRawStorage(new MemoryRawStorage()));
		});
	});

	describe('retention rule (StorageRepo.commit with a proof)', () => {
		// The retention rule reads only proofDeclaredDigest -- no signature verification -- so a stub
		// with the right commit op focuses these tests on the rule itself. Signed-proof persistence is
		// covered end-to-end below.
		const stubProof = (commit: CommitRequest): BlockCommitProof => ({
			v: 1,
			messageHash: 'unused',
			message: makeMessage(commit),
			promises: {},
			commits: {},
			membershipVersion: 2,
			membershipDigest: 'unused',
			peerIds: []
		});

		const seededRepo = async (block: IBlock = insertBlock()) => {
			const raw = new MemoryRawStorage();
			const repo = new StorageRepo((blockId) => new BlockStorage(blockId, raw));
			const pended = await repo.pend({
				actionId: ACTION,
				transforms: { inserts: { [BLOCK]: block }, updates: {}, deletes: [] },
				policy: 'c'
			});
			expect(pended.success, 'seed pend must land').to.equal(true);
			return { raw, repo };
		};

		it('persists the proof when the local materialization matches the declared digest', async () => {
			const { raw, repo } = await seededRepo();
			const digest = await canonicalBlockHash(insertBlock());
			const commit = makeCommit({ [BLOCK]: { digest } });
			const proof = stubProof(commit);
			expect(proofDeclaredDigest(proof, claimFor(commit)), 'stub declares via the shared resolver').to.equal(digest);
			expect((await repo.commit(commit, undefined, proof)).success).to.equal(true);
			expect(await raw.getBlockProof(BLOCK, commit.rev)).to.deep.equal(proof);
		});

		it('withholds the proof on a digest mismatch (the commit itself still lands)', async () => {
			const { raw, repo } = await seededRepo();
			const commit = makeCommit({ [BLOCK]: { digest: 'tampered-declaration' } });
			expect((await repo.commit(commit, undefined, stubProof(commit))).success).to.equal(true);
			expect(await raw.getBlockProof(BLOCK, commit.rev)).to.equal(undefined);
		});

		it('withholds the proof when the commit op declares no digest', async () => {
			const { raw, repo } = await seededRepo();
			const commit = makeCommit();
			expect((await repo.commit(commit, undefined, stubProof(commit))).success).to.equal(true);
			expect(await raw.getBlockProof(BLOCK, commit.rev)).to.equal(undefined);
		});

		it('withholds the proof on a tombstone (a delete materializes nothing to match)', async () => {
			const { raw, repo } = await seededRepo();
			expect((await repo.commit(makeCommit())).success, 'base insert must land').to.equal(true);
			const pended = await repo.pend({
				actionId: 'delete-action' as ActionId,
				transforms: { inserts: {}, updates: {}, deletes: [BLOCK] },
				rev: 2,
				policy: 'c'
			});
			expect(pended.success, 'delete pend must land').to.equal(true);
			const commit = makeCommit({ [BLOCK]: { digest: 'any-declared-digest' } },
				{ actionId: 'delete-action' as ActionId, rev: 2 });
			expect((await repo.commit(commit, undefined, stubProof(commit))).success).to.equal(true);
			expect(await raw.getBlockProof(BLOCK, 2)).to.equal(undefined);
		});

		it('back-fills a missing proof on an idempotent re-commit of the same (actionId, rev)', async () => {
			const { raw, repo } = await seededRepo();
			const digest = await canonicalBlockHash(insertBlock());
			const commit = makeCommit({ [BLOCK]: { digest } });
			expect((await repo.commit(commit)).success, 'first commit (no proof) must land').to.equal(true);
			expect(await raw.getBlockProof(BLOCK, commit.rev), 'nothing to back-fill yet').to.equal(undefined);

			const proof = stubProof(commit);
			expect((await repo.commit(commit, undefined, proof)).success, 'retry is an idempotent no-op').to.equal(true);
			expect(await raw.getBlockProof(BLOCK, commit.rev), 'retry back-fills the proof').to.deep.equal(proof);
		});

		it('back-fills a Crash-D3 block that recover() lands without running internalCommit', async () => {
			// Crash-D3: the action was durably promoted and its revision saved, but the crash lost
			// setLatest. commit() self-heals via recover() and then EXCLUDES the block from the
			// internalCommit loop (its pending is gone) — the one landing path that would otherwise
			// retain no proof despite this very call carrying one.
			const block = insertBlock();
			const { raw, repo } = await seededRepo(block);
			const storage = new BlockStorage(BLOCK, raw);
			await withBlockWriteLatch(BLOCK, async l => {
				await storage.saveMaterializedBlock(ACTION, block, l);
				await storage.saveRevision(1, ACTION, l);
				await storage.promotePendingTransaction(ACTION, l);
			});
			expect(await storage.getLatest(), 'the lost setLatest is the D3 signature').to.equal(undefined);

			const commit = makeCommit({ [BLOCK]: { digest: await canonicalBlockHash(block) } });
			const proof = stubProof(commit);
			expect((await repo.commit(commit, undefined, proof)).success, 'recover() rolls the block forward').to.equal(true);
			expect((await storage.getLatest())?.rev, 'latest reconciled to the durable rev').to.equal(1);
			expect(await raw.getBlockProof(BLOCK, commit.rev), 'recovered block retains the proof').to.deep.equal(proof);
		});
	});

	describe('end-to-end: consensus commit persists a verifiable proof', () => {
		class MockPeerNetwork implements IPeerNetwork {
			async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
		}

		/**
		 * Drive a FULLY-SIGNED v2 record through a real member backed by a pend-seeded StorageRepo.
		 * With every promise and commit already signed (2 peers -- both must sign both rounds), update()
		 * goes straight to Consensus and applyConsensusOperation hands the proof down the commit path.
		 */
		const consensusCommit = async (declaredDigest: string) => {
			const raw = new MemoryRawStorage();
			const repo = new StorageRepo((blockId) => new BlockStorage(blockId, raw));
			const pended = await repo.pend({
				actionId: ACTION,
				transforms: { inserts: { [BLOCK]: insertBlock() }, updates: {}, deletes: [] },
				policy: 'c'
			});
			expect(pended.success, 'seed pend must land').to.equal(true);

			const self = await makeKeyPair();
			const other = await makeKeyPair();
			const commit = makeCommit({ [BLOCK]: { digest: declaredDigest } });
			const record = await makeSignedRecord([self, other], commit);
			const member = clusterMember({
				storageRepo: repo,
				peerNetwork: new MockPeerNetwork(),
				peerId: self.peerId,
				privateKey: self.privateKey
			});
			try {
				await member.update(record);
			} finally {
				member.dispose();
			}
			return { raw, record, commit };
		};

		it('persists the projected proof in raw storage when the materialization matches', async () => {
			const digest = await canonicalBlockHash(insertBlock());
			const { raw, record, commit } = await consensusCommit(digest);
			const stored = await raw.getBlockProof(BLOCK, commit.rev);
			expect(stored).to.deep.equal(buildBlockCommitProof(record));
			// The stored artifact stands alone: an offline verifier accepts the claim and the content.
			const verdict = await verifyBlockCommitProofContent(
				stored!, claimFor(commit), insertBlock(), THRESHOLDS);
			expect(verdict).to.deep.equal({ ok: true, declaredDigest: digest });
		});

		it('withholds the proof when the cohort-declared digest does not match this member', async () => {
			const { raw, commit } = await consensusCommit('digest-this-member-never-computed');
			expect(await raw.getBlockProof(BLOCK, commit.rev)).to.equal(undefined);
		});
	});

	describe('size', () => {
		it('a 10-peer, two-block, fully-signed proof fits far inside MAX_CONTROL_MESSAGE_BYTES', async () => {
			// Realistic digest lengths: canonicalBlockHash yields 43-char base64url sha256 strings.
			const commit = makeCommit({
				[BLOCK]: { digest: await canonicalBlockHash(insertBlock(BLOCK)) },
				[BLOCK2]: { digest: await canonicalBlockHash(insertBlock(BLOCK2)) }
			}, { blockIds: [BLOCK, BLOCK2] });
			const { proof } = await makeSignedProof(10, commit);
			const size = JSON.stringify(proof).length;
			// eslint-disable-next-line no-console
			console.log(`      BlockCommitProof serialized size (10 peers, 2 blocks): ${size} bytes`);
			expect(size).to.be.lessThan(MAX_CONTROL_MESSAGE_BYTES);
		});
	});
});
