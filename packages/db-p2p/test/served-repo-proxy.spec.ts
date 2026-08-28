import { expect } from 'chai';
import { createServedRepoProxy } from '../src/repo/served-repo-proxy.js';
import { serveBlockArchive } from '../src/storage/block-archive.js';
import type { ProofRetainingRepo } from '../src/storage/block-archive.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { PROOF_THRESHOLDS, makeSignedProof } from './support/commit-proof-fixtures.js';
import { verifyBlockCommitProofClaim } from '../src/cluster/commit-proof.js';
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, BlockId, IRepo, IBlock } from '@optimystic/db-core';

/**
 * The proxy `createLibp2pNodeBase` hands its inbound protocol services. It used to be an object
 * literal inside the composition root, reachable only by booting a libp2p node — so nothing noticed
 * that it forwarded the four `IRepo` members and not `getBlockProof`, which made the sync service
 * serve every repair archive proof-less in production while every test that read a real
 * `StorageRepo` directly still saw proofs.
 */

const BLOCK = 'block-1' as BlockId;
const ACTION = 'action-1' as ActionId;

const makeBlock = (): IBlock => ({
	header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId },
	items: ['x']
} as unknown as IBlock);

/** A real `StorageRepo` holding one certified revision of `BLOCK`. */
const makeLocalStore = async () => {
	const raw = new MemoryRawStorage();
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, raw));
	const block = makeBlock();
	expect((await repo.pend({
		actionId: ACTION, transforms: { inserts: { [BLOCK]: block }, updates: {}, deletes: [] }, policy: 'c'
	})).success).to.equal(true);
	const commit = {
		actionId: ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 1,
		blockDigests: { [BLOCK]: { digest: await canonicalBlockHash(block) } }
	};
	const { proof } = await makeSignedProof(3, commit);
	expect((await repo.commit(commit, undefined, proof)).success).to.equal(true);
	return { repo, proof };
};

/** Records which member was called on it, and answers nothing useful — the coordinated-repo stand-in. */
const makeSpyRepo = () => {
	const calls: string[] = [];
	const repo = {
		async get() { calls.push('get'); return {}; },
		async pend() { calls.push('pend'); return { success: true, blockIds: [] }; },
		async cancel() { calls.push('cancel'); },
		async commit() { calls.push('commit'); return { success: true }; }
	} as unknown as IRepo;
	return { calls, repo };
};

describe('createServedRepoProxy', () => {

	it('serves a repair archive WITH its commit proof — the accessor reaches local storage', async () => {
		const { repo, proof } = await makeLocalStore();
		const proxy = createServedRepoProxy(repo, () => undefined);

		// Exactly what SyncService.buildArchive does with the object it is handed.
		const archive = (await serveBlockArchive(proxy, BLOCK))!;
		const entry = archive.revisions[1]!;
		expect(entry.proof, 'the proxy must forward getBlockProof, or every served archive is proof-less')
			.to.deep.equal(proof);

		const verdict = await verifyBlockCommitProofClaim(
			entry.proof!, { blockId: BLOCK, rev: 1, actionId: ACTION }, PROOF_THRESHOLDS);
		expect(verdict.ok, `served proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);
	});

	it('reads the proof from LOCAL storage even once a coordinated repo exists', async () => {
		// A peer answering a repair fetch reports the proof it retained. The coordinated repo has no
		// proof accessor at all, so routing there would also erase every proof the moment a node
		// finished assembling — the state a real node spends its whole life in.
		const { repo, proof } = await makeLocalStore();
		const spy = makeSpyRepo();
		const proxy = createServedRepoProxy(repo, () => spy.repo);

		expect(await proxy.getBlockProof!(BLOCK, 1)).to.deep.equal(proof);
		expect(spy.calls, 'the proof lookup must not touch the coordinated repo').to.deep.equal([]);
	});

	it('routes the four IRepo members to the coordinated repo once it exists', async () => {
		const { repo } = await makeLocalStore();
		const spy = makeSpyRepo();
		let coordinated: IRepo | undefined;
		const proxy = createServedRepoProxy(repo, () => coordinated);

		// Before assembly: local storage answers, so a request arriving early is not dropped.
		expect((await proxy.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest?.rev).to.equal(1);
		expect(spy.calls).to.deep.equal([]);

		// After assembly: every client-facing member must get cluster-coordinated semantics. Read per
		// call, not captured — the coordinated repo is constructed after the proxy.
		coordinated = spy.repo;
		await proxy.get({ blockIds: [BLOCK] });
		await proxy.pend({ actionId: ACTION, transforms: { inserts: {}, updates: {}, deletes: [] }, policy: 'c' });
		await proxy.cancel({ blockIds: [BLOCK], actionId: ACTION });
		await proxy.commit({ actionId: ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 2 });
		expect(spy.calls).to.deep.equal(['get', 'pend', 'cancel', 'commit']);
	});

	it('demands a store that CAN serve proofs', () => {
		// Compile-time, not runtime: `ProofRetainingRepo` requires the accessor, so a composition root
		// cannot hand over a store whose archives would all be proof-less. This asserts the type is
		// the strict one; the guarantee itself is `tsc`'s.
		const plain = { get: async () => ({}) } as unknown as IRepo;
		// @ts-expect-error a plain IRepo has no getBlockProof, so it is not a ProofRetainingRepo
		const rejected: ProofRetainingRepo = plain;
		void rejected;
	});
});
