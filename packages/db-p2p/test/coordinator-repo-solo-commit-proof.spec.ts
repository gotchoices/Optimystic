import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	ActionId, BlockHeader, BlockId, ClusterPeers, IBlock, IKeyNetwork, IPeerNetwork, Transforms, FindCoordinatorOptions
} from '@optimystic/db-core';
import { canonicalBlockHash } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { clusterMember, type ClusterMember } from '../src/cluster/cluster-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { verifyBlockCommitProofContent } from '../src/cluster/commit-proof.js';
import { certifyContent, proofThresholds } from '../src/cluster/certified-claims.js';
import { PROOF_THRESHOLDS, makeClusterPeers } from './support/commit-proof-fixtures.js';

// The commit path under test is CoordinatorRepo.commit's solo-cohort short-circuit: the derived
// cohort has at most one peer, consensus never runs, and the commit goes straight to local storage.
// Before the solo mint landed that path retained NO proof, so a block born on a cohort of one could
// never pass the certified-push gate and never gain a second holder. This spec is the recreation of
// the reproducing test from the fix ticket (it failed on `main` on its first proof assertion).
//
// Both ways INTO that branch are exercised, because they are different production situations:
//  - a genuine cohort of one — `findCluster` answers with exactly this node;
//  - DEGRADED ROUTING — `findCluster` throws, so `isResponsibleForBlock` falls open ("assume
//    responsible") while `getClusterPeerIds` reports an empty cohort. Every commit on the node then
//    takes the solo branch for as long as routing is down, whatever the block's real cohort size is.

const makeKeyNetwork = (cluster: ClusterPeers | 'unroutable'): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		if (cluster === 'unroutable') throw new Error('findCluster unavailable');
		return { ...cluster };
	}
});

const makeBlock = (blockId: BlockId, collectionId: BlockId, payload: string): IBlock => ({
	header: { id: blockId, type: 'test', collectionId } as BlockHeader,
	payload
} as unknown as IBlock);

/** One captured `CoordinatorRepo` log call: the event name and its structured payload. */
type LogLine = { event: string; detail: Record<string, unknown> };

interface Harness {
	coordinated: CoordinatorRepo;
	storageRepo: StorageRepo;
	member?: ClusterMember;
	selfPeerId: PeerId;
	/** Every structured line the repo logged during the test, in order. */
	logs: LogLine[];
}

interface HarnessOptions {
	/** Wire a real local `ClusterMember` (the key holder). Without one there is nothing to mint with. */
	withLocalCluster?: boolean;
	/** `findCluster` throws instead of answering — the degraded-routing entry into the solo branch. */
	unroutable?: boolean;
}

const makeHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
	const { withLocalCluster = true, unroutable = false } = options;
	const privateKey = await generateKeyPair('Ed25519');
	const selfPeerId = peerIdFromPrivateKey(privateKey);
	// ONE raw store shared by every BlockStorage this repo makes. The factory is called per block
	// AND per operation, so constructing the store inside it gives pend and commit different
	// storage and the commit dies on `Pending action ... not found`.
	const raw = new MemoryRawStorage();
	const storageRepo = new StorageRepo(id => new BlockStorage(id, raw));
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
		makeKeyNetwork(unroutable ? 'unroutable' : makeClusterPeers([{ peerId: selfPeerId, privateKey }])),
		((_p: PeerId) => ({} as unknown as ClusterClient)) as never,
		storageRepo,
		{ allowUnvalidatedSmallCluster: true },
		member,
		selfPeerId
	);
	// `commit:solo-cohort` is the only signal that tells an operator a real cohort of one apart from
	// a routing failure, so it is asserted rather than assumed. Replacing the private `debug` handle
	// is the cheapest capture; nothing in the class reads it back.
	const logs: LogLine[] = [];
	(coordinated as unknown as { log: (event: string, detail?: Record<string, unknown>) => void }).log =
		(event, detail) => { logs.push({ event, detail: detail ?? {} }); };
	return { coordinated, storageRepo, member, selfPeerId, logs };
};

/** The one `commit:solo-cohort` line the commit under test emitted; fails the test if absent. */
const soloCohortLine = (harness: Harness): Record<string, unknown> => {
	const lines = harness.logs.filter(l => l.event === 'commit:solo-cohort');
	expect(lines, 'exactly one commit:solo-cohort line per solo commit').to.have.length(1);
	return lines[0]!.detail;
};

const pendAndCommit = async (
	harness: Harness, blockId: BlockId, actionId: ActionId, block: IBlock
): Promise<void> => {
	const transforms: Transforms = { inserts: { [blockId]: block }, updates: {}, deletes: [] };
	// No `rev` on the pend: rev 1 is the block's first revision, so there is no base to name — the
	// same shape `block-archive-proof.spec.ts`'s landRevision uses (`rev > 1 ? { rev } : {}`).
	const pended = await harness.coordinated.pend({ actionId, transforms, policy: 'c' });
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
	const track = async (options?: HarnessOptions): Promise<Harness> => {
		const harness = await makeHarness(options);
		harnesses.push(harness);
		return harness;
	};
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.member?.dispose();
		}
	});

	it('retains a verifying proof for a commit on a cohort of one', async () => {
		const BLOCK_ID = 'block-solo-proof' as BlockId;
		const COLLECTION_ID = 'solo-proof-collection' as BlockId;
		const ACTION = 'action-solo-1' as ActionId;
		const harness = await track();

		const block = makeBlock(BLOCK_ID, COLLECTION_ID, 'hello');
		await pendAndCommit(harness, BLOCK_ID, ACTION, block);

		const proof = await harness.storageRepo.getBlockProof(BLOCK_ID, 1);
		expect(proof, 'a solo commit must retain a proof').to.not.equal(undefined);
		expect(proof!.peerIds, 'the proof binds exactly the one-peer cohort')
			.to.deep.equal([harness.selfPeerId.toString()]);

		const verdict = await verifyBlockCommitProofContent(
			proof!, { blockId: BLOCK_ID, rev: 1, actionId: ACTION }, block, PROOF_THRESHOLDS);
		expect(verdict.ok, `proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);

		// The operator's discriminator for a REAL cohort of one.
		expect(soloCohortLine(harness)).to.include({ blockId: BLOCK_ID, cohortSize: 1, soleIsSelf: true });
	});

	it('the retained solo proof passes the receiver-side certified-push gate', async () => {
		// The point of minting at all is that another node will ACCEPT the block. `handlePush` gates
		// on exactly this call (`certifyContent` with `proofThresholds(superMajorityThreshold)`), so
		// running it here demonstrates the round-trip instead of arguing it from the unit thresholds.
		// The bytes are the ones the commit declared a digest for; retention already proved this
		// node's own materialization matches that digest, so they are what a push would carry.
		const BLOCK_ID = 'block-solo-pushable' as BlockId;
		const COLLECTION_ID = 'solo-push-collection' as BlockId;
		const ACTION = 'action-solo-push' as ActionId;
		const harness = await track();

		const block = makeBlock(BLOCK_ID, COLLECTION_ID, 'pushable');
		await pendAndCommit(harness, BLOCK_ID, ACTION, block);

		const proof = await harness.storageRepo.getBlockProof(BLOCK_ID, 1);
		const verdict = await certifyContent(
			proof!, { blockId: BLOCK_ID, rev: 1, actionId: ACTION }, block,
			proofThresholds(PROOF_THRESHOLDS.superMajorityThreshold));

		expect(verdict.revCertified, `push gate must certify the revision: ${JSON.stringify(verdict)}`).to.equal(true);
		if (!verdict.contentCertified) {
			expect.fail(`push gate must certify the bytes: ${JSON.stringify(verdict)}`);
		}
		expect(verdict.signerCount, 'one signer, well under MAX_PROOF_SIGNERS').to.equal(1);
	});

	it('mints a proof when routing is degraded, and logs the cohort as zero rather than one', async () => {
		// `findCluster` failing is NOT a cohort of one — it is "no idea who the cohort is". The commit
		// still lands locally (that predates the mint) and must still carry evidence, or an outage
		// silently produces blocks that can never gain a holder. The log line is what separates this
		// from the case above; the stale-proof risk it creates is tracked by
		// `single-signer-proof-outweighs-corroboration`.
		const BLOCK_ID = 'block-solo-unroutable' as BlockId;
		const COLLECTION_ID = 'solo-unroutable-collection' as BlockId;
		const ACTION = 'action-solo-unroutable' as ActionId;
		const harness = await track({ unroutable: true });

		const block = makeBlock(BLOCK_ID, COLLECTION_ID, 'degraded');
		await pendAndCommit(harness, BLOCK_ID, ACTION, block);

		const proof = await harness.storageRepo.getBlockProof(BLOCK_ID, 1);
		expect(proof, 'a routing failure must not silently drop the proof').to.not.equal(undefined);
		const verdict = await verifyBlockCommitProofContent(
			proof!, { blockId: BLOCK_ID, rev: 1, actionId: ACTION }, block, PROOF_THRESHOLDS);
		expect(verdict.ok, `proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);

		expect(soloCohortLine(harness)).to.include({ blockId: BLOCK_ID, cohortSize: 0, soleIsSelf: false });
	});

	it('still commits successfully — retaining no proof — when no local cluster is wired', async () => {
		const BLOCK_ID = 'block-solo-no-cluster' as BlockId;
		const COLLECTION_ID = 'solo-no-cluster-collection' as BlockId;
		const ACTION = 'action-solo-2' as ActionId;
		// `undefined` localCluster is the direct-constructor / unit-test-double wiring: no signing
		// key exists, so the solo path must keep committing (proof-lessly) rather than fail.
		const harness = await track({ withLocalCluster: false });

		await pendAndCommit(harness, BLOCK_ID, ACTION, makeBlock(BLOCK_ID, COLLECTION_ID, 'hello'));

		expect(await harness.storageRepo.getBlockProof(BLOCK_ID, 1),
			'no local cluster means no key to mint with').to.equal(undefined);
	});
});
