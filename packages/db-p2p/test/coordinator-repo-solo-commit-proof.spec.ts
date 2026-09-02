import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	ActionId, BlockHeader, BlockId, ClusterPeers, IBlock, IKeyNetwork, IPeerNetwork, Transforms, FindCoordinatorOptions
} from '@optimystic/db-core';
import { canonicalBlockHash } from '@optimystic/db-core';
import { toString as u8ToString } from 'uint8arrays';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { clusterMember, type ClusterMember } from '../src/cluster/cluster-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { verifyBlockCommitProofContent } from '../src/cluster/commit-proof.js';
import { PROOF_THRESHOLDS } from './support/commit-proof-fixtures.js';

// The commit path under test is CoordinatorRepo.commit's solo-cohort short-circuit: findCluster
// resolves a cohort of exactly this node, consensus never runs, and the commit goes straight to
// local storage. Before the solo mint landed, that path retained NO proof — so a block born on a
// cohort of one could never pass the certified-push gate and never gain a second holder. This spec
// is the recreation of the reproducing test from the fix ticket (it failed on `main` on its first
// proof assertion); it now pins that the lone member self-signs a one-peer proof that verifies
// under the production thresholds, and that the no-cluster wiring still commits proof-lessly.

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
		};
	}
	return peers;
};

const makeKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

const makeBlock = (blockId: BlockId, collectionId: BlockId, payload: string): IBlock => ({
	header: { id: blockId, type: 'test', collectionId } as BlockHeader,
	payload
} as unknown as IBlock);

interface Harness {
	coordinated: CoordinatorRepo;
	storageRepo: StorageRepo;
	member?: ClusterMember;
}

const makeHarness = async (withLocalCluster: boolean): Promise<Harness> => {
	const privateKey = await generateKeyPair('Ed25519');
	const selfPeerId = peerIdFromPrivateKey(privateKey);
	const storageRepo = new StorageRepo(id => new BlockStorage(id, new MemoryRawStorage()));
	// A REAL ClusterMember, not a double: the solo path's proof must come out of the same delegate
	// the production wiring exposes. The peer network is a dead stub — the solo short-circuit never
	// dials anyone, which is rather the point.
	const member = withLocalCluster
		? clusterMember({
			storageRepo,
			peerNetwork: {} as unknown as IPeerNetwork,
			peerId: selfPeerId,
			privateKey
		})
		: undefined;
	const coordinated = new CoordinatorRepo(
		makeKeyNetwork(makeClusterPeers([selfPeerId])),
		((_p: PeerId) => ({} as unknown as ClusterClient)) as never,
		storageRepo,
		{ allowUnvalidatedSmallCluster: true },
		member,
		selfPeerId
	);
	return { coordinated, storageRepo, member };
};

const pendAndCommit = async (
	harness: Harness, blockId: BlockId, actionId: ActionId, block: IBlock
): Promise<void> => {
	const transforms: Transforms = { inserts: { [blockId]: block }, updates: {}, deletes: [] };
	const pended = await harness.coordinated.pend({ actionId, rev: 1, transforms, policy: 'c' });
	expect(pended.success, 'pend must land').to.equal(true);

	const digest = await canonicalBlockHash(block);
	const committed = await harness.coordinated.commit({
		actionId, blockIds: [blockId], tailId: blockId, rev: 1,
		blockDigests: { [blockId]: { digest } }
	});
	expect(committed.success, 'commit must land').to.equal(true);
};

describe('solo-cohort commit proof', function () {
	this.timeout(5_000);

	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.member?.dispose();
		}
	});

	it('retains a verifying proof for a commit on a cohort of one', async () => {
		const BLOCK_ID = 'block-solo-proof' as BlockId;
		const COLLECTION_ID = 'solo-proof-collection' as BlockId;
		const ACTION = 'action-solo-1' as ActionId;
		const harness = await makeHarness(true);
		harnesses.push(harness);

		const block = makeBlock(BLOCK_ID, COLLECTION_ID, 'hello');
		await pendAndCommit(harness, BLOCK_ID, ACTION, block);

		const proof = await harness.storageRepo.getBlockProof(BLOCK_ID, 1);
		expect(proof, 'a solo commit must retain a proof').to.not.equal(undefined);
		expect(proof!.peerIds, 'the proof binds exactly the one-peer cohort').to.have.length(1);

		const verdict = await verifyBlockCommitProofContent(
			proof!, { blockId: BLOCK_ID, rev: 1, actionId: ACTION }, block, PROOF_THRESHOLDS);
		expect(verdict.ok, `proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);
	});

	it('still commits successfully — retaining no proof — when no local cluster is wired', async () => {
		const BLOCK_ID = 'block-solo-no-cluster' as BlockId;
		const COLLECTION_ID = 'solo-no-cluster-collection' as BlockId;
		const ACTION = 'action-solo-2' as ActionId;
		// `undefined` localCluster is the direct-constructor / unit-test-double wiring: no signing
		// key exists, so the solo path must keep committing (proof-lessly) rather than fail.
		const harness = await makeHarness(false);
		harnesses.push(harness);

		await pendAndCommit(harness, BLOCK_ID, ACTION, makeBlock(BLOCK_ID, COLLECTION_ID, 'hello'));

		expect(await harness.storageRepo.getBlockProof(BLOCK_ID, 1),
			'no local cluster means no key to mint with').to.equal(undefined);
	});
});
