import { expect } from 'chai';
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, BlockId, BlockHeader, CommitRequest, IBlock } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { BlockTransferService, type BlockTransferRequest, type IBlockReplicaStore } from '../src/cluster/block-transfer-service.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';

/**
 * What `BlockTransferService.handlePush` accepts, and what it durably keeps.
 *
 * Two tickets meet here.
 *
 * `churn re-replication validates but never persists`: spread-on-churn pushes blocks to new owners
 * via `BlockTransferClient.pushBlocks`, and the receiver must PERSIST an accepted block so the new
 * owner actually holds a durable replica.
 *
 * `require-proof-on-block-push`: the receiver must not persist a block just because a peer handed
 * it over. `saveReplicatedBlock` advances `latest` monotonically, so an accepted push becomes this
 * node's authoritative revision — after which this node corroborates the pusher in a later
 * read-repair vote. That is how a peer manufactures its own corroborators. So by default a pushed
 * block must carry the cohort's commit proof for the revision it declares, verified against BOTH
 * the declared `(rev, actionId)` and the pushed bytes.
 *
 * The handler is exercised directly here (it is private, driven via the protocol handler in
 * production); the stream path is covered by `block-transfer-roundtrip.spec.ts`.
 *
 * Proofs are REAL: fully-signed Ed25519 cohort records from `support/commit-proof-fixtures.ts`,
 * the same recipe coordinators and members use, so an "accepted" here is an acceptance production
 * would also make.
 */

/** Mirrors `support/commit-proof-fixtures.ts`'s `PROOF_THRESHOLDS.superMajorityThreshold`. */
const SUPER_MAJORITY = 0.75;

const makeBlock = (id: string, marker = 'x'): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader,
	marker
} as unknown as IBlock);

type Meta = { rev: number; actionId: string };

/**
 * The cohort commit proof a genuine holder would have retained for `(blockId, rev, actionId)` over
 * exactly these bytes — i.e. what an honest pusher attaches.
 */
const certify = async (blockId: string, block: IBlock, meta: Meta): Promise<BlockCommitProof> => {
	const commit: CommitRequest = {
		actionId: meta.actionId as ActionId,
		blockIds: [blockId as BlockId],
		tailId: blockId as BlockId,
		rev: meta.rev,
		blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
	};
	const { proof } = await makeSignedProof(4, commit);
	return proof;
};

/** One block's push payload. `proof`/`meta` are attached only when supplied — the wire is optional. */
const pushReq = (
	blockId: string,
	block: IBlock,
	meta?: Meta,
	proof?: BlockCommitProof
): BlockTransferRequest => ({
	type: 'push',
	blockIds: [blockId],
	reason: 'replication',
	blockData: { [blockId]: Buffer.from(JSON.stringify(block)).toString('base64') },
	...(meta ? { blockMeta: { [blockId]: meta } } : {}),
	...(proof ? { blockProofs: { [blockId]: proof } } : {})
});

/** A push an honest, upgraded sender produces: meta and proof built for the same revision. */
const certifiedReq = async (blockId: string, block: IBlock, meta: Meta): Promise<BlockTransferRequest> =>
	pushReq(blockId, block, meta, await certify(blockId, block, meta));

describe('BlockTransferService.handlePush certification + persistence', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;
	/** Default posture: an uncertified push is refused. */
	let service: BlockTransferService;
	/** Migration posture: `requirePushCertificate: false`. */
	let legacyService: BlockTransferService;

	const registrar = { handle: async () => {}, unhandle: async () => {} };

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		service = new BlockTransferService({ registrar, repo, superMajorityThreshold: SUPER_MAJORITY });
		legacyService = new BlockTransferService(
			{ registrar, repo, superMajorityThreshold: SUPER_MAJORITY },
			{ requirePushCertificate: false });
	});

	const push = (svc: BlockTransferService, request: BlockTransferRequest) =>
		(svc as any).handlePush(request) as Promise<{ blocks: Record<string, string>; missing: string[] }>;

	/** Nothing landed: `get` reports no block for this id (and does not throw on poisoned metadata). */
	const expectNothingPersisted = async (blockId: string) => {
		const result = await repo.get({ blockIds: [blockId as BlockId] });
		expect(result[blockId]?.block ?? undefined, `${blockId} must not have been persisted`).to.be.undefined;
	};

	describe('the strict default (requirePushCertificate: true)', () => {
		it('rejects an uncertified push and persists nothing', async () => {
			// The measured hole: before this ticket, this exact request was accepted and its content
			// became the receiver's authoritative revision.
			const blockId = 'block-uncertified';
			const response = await push(service, pushReq(blockId, makeBlock(blockId), { rev: 7, actionId: 'a7' }));

			expect(response.blocks).to.not.have.property(blockId);
			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('rejects an uncertified push that carries no metadata either (an un-upgraded sender)', async () => {
			const blockId = 'block-bare';
			const response = await push(service, pushReq(blockId, makeBlock(blockId)));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('accepts a certified push, persists the replica at the source revision, and keeps the proof', async () => {
			const blockId = 'block-certified';
			const block = makeBlock(blockId);
			const meta = { rev: 7, actionId: 'a7' };
			const proof = await certify(blockId, block, meta);

			const response = await push(service, pushReq(blockId, block, meta, proof));

			expect(response.blocks, 'a verifying push is accepted').to.have.property(blockId);
			expect(response.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id, 'the replica is durably servable').to.equal(blockId);
			// latest mirrors the source rather than being fabricated as rev 1.
			expect(result[blockId]?.state?.latest).to.deep.equal(meta);
			// ...and the receiver can re-prove what it verified, instead of becoming a
			// corroboration-only holder.
			expect(await repo.getBlockProof(blockId as BlockId, meta.rev),
				'the verified proof is retained alongside the replica').to.deep.equal(proof);
		});

		it('rejects a valid proof paired with metadata claiming a different revision', async () => {
			// A genuine proof for rev 5, replayed against a rev-9 claim. The claim match inside content
			// verification is what catches it.
			const blockId = 'block-meta-mismatch';
			const block = makeBlock(blockId);
			const proofForRev5 = await certify(blockId, block, { rev: 5, actionId: 'a5' });

			const response = await push(service, pushReq(blockId, block, { rev: 9, actionId: 'a9' }, proofForRev5));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('rejects a valid proof paired with tampered bytes', async () => {
			const blockId = 'block-tampered';
			const meta = { rev: 3, actionId: 'a3' };
			const proof = await certify(blockId, makeBlock(blockId, 'honest'), meta);

			// Same block id, same claim — different content than the cohort declared a digest for.
			const response = await push(service, pushReq(blockId, makeBlock(blockId, 'forged'), meta, proof));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('rejects a proof pushed without metadata (there is no claim to verify it against)', async () => {
			// Without the declared (rev, actionId) there is nothing to check the proof for, and
			// saveReplica would fabricate a rev-1 replica the proof does not cover.
			const blockId = 'block-proof-no-meta';
			const block = makeBlock(blockId);
			const proof = await certify(blockId, block, { rev: 2, actionId: 'a2' });

			const response = await push(service, pushReq(blockId, block, undefined, proof));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('decides per block: a multi-block push accepts what verifies and rejects what does not', async () => {
			const good = 'block-multi-good';
			const bad = 'block-multi-bad';
			const goodBlock = makeBlock(good);
			const badBlock = makeBlock(bad);
			const goodMeta = { rev: 4, actionId: 'a4' };
			const badMeta = { rev: 4, actionId: 'b4' };

			const request: BlockTransferRequest = {
				type: 'push',
				blockIds: [good, bad],
				reason: 'replication',
				blockData: {
					[good]: Buffer.from(JSON.stringify(goodBlock)).toString('base64'),
					[bad]: Buffer.from(JSON.stringify(badBlock)).toString('base64')
				},
				blockMeta: { [good]: goodMeta, [bad]: badMeta },
				// Only the first block is certified; the second is an uncertified rider.
				blockProofs: { [good]: await certify(good, goodBlock, goodMeta) }
			};

			const response = await push(service, request);

			expect(response.blocks, 'the verifying block is accepted').to.have.property(good);
			expect(response.missing, 'the uncertified block is refused, alone').to.deep.equal([bad]);

			const result = await repo.get({ blockIds: [good as BlockId, bad as BlockId] });
			expect(result[good]?.block?.header.id).to.equal(good);
			expect(result[bad]?.block ?? undefined).to.be.undefined;
		});

		it('is idempotent for a certified re-push of the same revision', async () => {
			const blockId = 'block-certified-idem';
			const block = makeBlock(blockId);
			const meta = { rev: 3, actionId: 'a3' };
			const request = await certifiedReq(blockId, block, meta);

			const r1 = await push(service, request);
			const r2 = await push(service, request);

			expect(r1.blocks).to.have.property(blockId);
			expect(r2.blocks, 'the re-push is still accepted').to.have.property(blockId);
			expect(r2.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.state?.latest, 'no duplicate/regressed state').to.deep.equal(meta);
		});

		it('does not downgrade latest when an older certified revision arrives (monotonic guard)', async () => {
			const blockId = 'block-certified-mono';
			const block = makeBlock(blockId);

			await push(service, await certifiedReq(blockId, block, { rev: 5, actionId: 'a5' }));
			const stale = await push(service, await certifiedReq(blockId, block, { rev: 1, actionId: 'a1' }));

			// The stale push is still "accepted" (the block is durably present), but latest holds at 5.
			expect(stale.blocks).to.have.property(blockId);
			expect(stale.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.state?.latest).to.deep.equal({ rev: 5, actionId: 'a5' });
		});

		it('reports a block as missing (not accepted) when persistence fails', async () => {
			const blockId = 'block-persist-fail';
			const block = makeBlock(blockId);
			const meta = { rev: 2, actionId: 'a2' };

			// A repo whose saveReplicatedBlock always throws (e.g. disk failure).
			const throwingRepo = {
				get: async () => ({}),
				pend: async () => ({ success: false }),
				commit: async () => ({ success: true }),
				cancel: async () => {},
				saveReplicatedBlock: async () => { throw new Error('disk full'); }
			} as unknown as IBlockReplicaStore;

			const failService = new BlockTransferService(
				{ registrar, repo: throwingRepo, superMajorityThreshold: SUPER_MAJORITY });

			const response = await push(failService, await certifiedReq(blockId, block, meta));

			// A block that fails to persist must NOT be reported accepted, so the sender
			// does not falsely treat it as replicated.
			expect(response.blocks).to.not.have.property(blockId);
			expect(response.missing).to.deep.equal([blockId]);
		});

		it('reports a block as missing when the wire payload is not parseable', async () => {
			const blockId = 'block-baddata';
			const request: BlockTransferRequest = {
				type: 'push',
				blockIds: [blockId],
				reason: 'replication',
				// Valid base64, but the decoded bytes are not JSON.
				blockData: { [blockId]: Buffer.from('not json', 'utf8').toString('base64') }
			};

			const response = await push(service, request);
			expect(response.blocks).to.not.have.property(blockId);
			expect(response.missing).to.deep.equal([blockId]);
		});

		it('reports missing (and does not poison storage) when the payload is valid JSON but not a block', async () => {
			const blockId = 'block-null';
			const request: BlockTransferRequest = {
				type: 'push',
				blockIds: [blockId],
				reason: 'replication',
				// `null` is valid JSON, so the parse guard alone would let it through; persisting
				// it would seed metadata with no materialization and make every later get throw.
				blockData: { [blockId]: Buffer.from('null', 'utf8').toString('base64') }
			};

			const response = await push(service, request);
			expect(response.blocks).to.not.have.property(blockId);
			expect(response.missing).to.deep.equal([blockId]);

			// Storage was not poisoned: get returns empty rather than throwing.
			await expectNothingPersisted(blockId);
		});
	});

	describe('the migration flag (requirePushCertificate: false)', () => {
		it('accepts an uncertified push and persists it at the source revision (pre-proof behaviour)', async () => {
			const blockId = 'block-legacy';
			const block = makeBlock(blockId);
			const meta = { rev: 7, actionId: 'a7' };

			const response = await push(legacyService, pushReq(blockId, block, meta));

			expect(response.blocks).to.have.property(blockId);
			expect(response.missing).to.deep.equal([]);

			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.state?.latest, 'the legacy path still honours the source revision')
				.to.deep.equal(meta);
			expect(await repo.getBlockProof(blockId as BlockId, meta.rev),
				'an uncertified acceptance retains no proof').to.equal(undefined);
		});

		it('falls back to a deterministic rev-1 replica when an uncertified push carries no metadata', async () => {
			const blockId = 'block-legacy-nometa';
			const response = await push(legacyService, pushReq(blockId, makeBlock(blockId)));

			expect(response.blocks).to.have.property(blockId);
			const result = await repo.get({ blockIds: [blockId as BlockId] });
			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.state?.latest?.rev).to.equal(1);
		});

		it('still rejects a push whose proof FAILS verification — that is a bad block, not a legacy one', async () => {
			const blockId = 'block-legacy-badproof';
			const block = makeBlock(blockId, 'honest');
			const meta = { rev: 3, actionId: 'a3' };
			const proof = await certify(blockId, block, meta);

			// Tampered bytes under a genuine proof: rejected even with the flag off.
			const response = await push(legacyService, pushReq(blockId, makeBlock(blockId, 'forged'), meta, proof));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('still rejects a proof pushed without metadata', async () => {
			const blockId = 'block-legacy-proof-no-meta';
			const block = makeBlock(blockId);
			const proof = await certify(blockId, block, { rev: 2, actionId: 'a2' });

			const response = await push(legacyService, pushReq(blockId, block, undefined, proof));

			expect(response.missing).to.deep.equal([blockId]);
			await expectNothingPersisted(blockId);
		});

		it('accepts a certified push and keeps its proof, exactly as the strict default does', async () => {
			const blockId = 'block-legacy-certified';
			const block = makeBlock(blockId);
			const meta = { rev: 6, actionId: 'a6' };
			const proof = await certify(blockId, block, meta);

			const response = await push(legacyService, pushReq(blockId, block, meta, proof));

			expect(response.blocks).to.have.property(blockId);
			expect(await repo.getBlockProof(blockId as BlockId, meta.rev)).to.deep.equal(proof);
		});
	});
});
