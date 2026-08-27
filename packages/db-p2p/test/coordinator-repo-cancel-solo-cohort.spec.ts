/**
 * `CoordinatorRepo.cancel` decides the solo-cohort short-circuit PER BLOCK ID, not once for
 * `blockIds[0]` the way `pend` and `commit` do.
 *
 * `coordinator-repo-integration.spec.ts` already covers the single-block half of that fix (a
 * one-peer cohort must cancel through local storage instead of failing `minAbsoluteClusterSize`).
 * What it cannot cover is the reason the decision is per-block at all: the mesh harness gives every
 * key the same `responsibilityK`, so one coordinator can never see two blocks with differently
 * sized cohorts. This spec stubs the key network so it can, and pins all three shapes:
 *
 *   - every block solo          → no cluster peer is ever dialled, local storage cancels;
 *   - mixed solo + multi-peer   → the multi-peer block still enters the cluster path;
 *   - every block multi-peer    → unchanged from before the short-circuit existed.
 *
 * The cluster path is stubbed to fail loudly rather than to succeed: what is under test is WHICH
 * branch each block takes, and a recorded dial is a sharper witness of that than a consensus
 * outcome several layers further down.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ICluster, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, FindCoordinatorOptions
} from '@optimystic/db-core';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { toString as u8ToString } from 'uint8arrays';

const SOLO_BLOCK = 'block-solo-cohort' as BlockId;
const SOLO_BLOCK_2 = 'block-solo-cohort-2' as BlockId;
const PAIR_BLOCK = 'block-pair-cohort' as BlockId;

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

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

/** A key network whose cohort depends on the block key, which the mesh harness cannot express. */
const makeKeyNetwork = (cohorts: Record<string, ClusterPeers>): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const blockId = new TextDecoder().decode(key);
		const cohort = cohorts[blockId];
		if (!cohort) throw new Error(`no cohort configured for ${blockId}`);
		return { ...cohort };
	}
});

/** Records the cancels that reached local storage. */
const makeStorageRepo = (cancelled: ActionBlocks[]): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		const results: GetBlockResults = {};
		for (const blockId of blockGets.blockIds) results[blockId] = { state: {} };
		return results;
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [] };
	},
	async cancel(actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {
		cancelled.push(actionRef);
	},
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true };
	}
});

interface Harness {
	repo: CoordinatorRepo;
	/** Peers the coordinator dialled — non-empty exactly when some block took the cluster path. */
	dialled: string[];
	cancelled: ActionBlocks[];
}

const makeHarness = async (): Promise<Harness> => {
	const localPeer = await makePeerId();
	const otherPeer = await makePeerId();
	const solo = makeClusterPeers([localPeer]);
	const dialled: string[] = [];
	const cancelled: ActionBlocks[] = [];
	const repo = new CoordinatorRepo(
		makeKeyNetwork({
			[SOLO_BLOCK]: solo,
			[SOLO_BLOCK_2]: solo,
			[PAIR_BLOCK]: makeClusterPeers([localPeer, otherPeer])
		}),
		(peerId: PeerId): ICluster => {
			dialled.push(peerId.toString());
			return { async update() { throw new Error('cluster-path-entered'); } };
		},
		makeStorageRepo(cancelled),
		// `minAbsoluteClusterSize: 2` so the two-peer cohort reaches the dial rather than being
		// turned away by the size floor first — the branch, not the floor, is what is under test.
		{ clusterSize: 2, minAbsoluteClusterSize: 2 },
		undefined,
		localPeer
	);
	return { repo, dialled, cancelled };
};

describe('CoordinatorRepo.cancel — solo-cohort short-circuit is per block', () => {

	it('cancels every-block-solo through local storage without dialling anyone', async () => {
		const { repo, dialled, cancelled } = await makeHarness();

		await repo.cancel({ actionId: 'a-all-solo', blockIds: [SOLO_BLOCK, SOLO_BLOCK_2] });

		expect(dialled, 'a solo cohort has no one to dial').to.deep.equal([]);
		// One local cancel for the whole action ref, not one per block: `cancel` is keyed on the
		// action, and the fallback fires once when no block executed via a cluster.
		expect(cancelled).to.have.length(1);
		expect(cancelled[0]!.blockIds).to.deep.equal([SOLO_BLOCK, SOLO_BLOCK_2]);
	});

	it('still enters the cluster path for a multi-peer block sharing the cancel with a solo one', async () => {
		// The regression this ordering guards: deciding once for `blockIds[0]` would read the SOLO
		// block first and short-circuit the multi-peer block along with it, silently cancelling a
		// replicated block locally and telling no one.
		const { repo, dialled, cancelled } = await makeHarness();

		let error: Error | undefined;
		try {
			await repo.cancel({ actionId: 'a-mixed', blockIds: [SOLO_BLOCK, PAIR_BLOCK] });
		} catch (err) {
			error = err as Error;
		}

		expect(error, 'the multi-peer block must reach the (here failing) cluster path').to.be.instanceOf(Error);
		expect(dialled, 'the multi-peer cohort was dialled').to.not.be.empty;
		expect(cancelled, 'a failed cluster cancel must not fall through to local storage').to.deep.equal([]);
	});

	it('does not short-circuit when no block is solo', async () => {
		const { repo, dialled } = await makeHarness();

		let error: Error | undefined;
		try {
			await repo.cancel({ actionId: 'a-all-pair', blockIds: [PAIR_BLOCK] });
		} catch (err) {
			error = err as Error;
		}

		expect(error).to.be.instanceOf(Error);
		expect(dialled).to.not.be.empty;
	});
});
