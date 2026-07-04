/**
 * REPRODUCTION (ticket: p2p-read-repair-unverified-peer-claims)
 *
 * `queryClusterForLatest` takes the MAX ActionRev any single peer reports, with
 * no signature / commit-cert / quorum check. This spec demonstrates that a lone
 * lying peer that over-reports its revision steers restoration: the node accepts
 * the liar's (rev, actionId) even though every honest peer disagrees.
 *
 * This spec is expected to PASS today (it pins the vulnerable behavior). Once the
 * fix lands it should be updated/inverted to assert the liar is rejected.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const makePresentStorageRepo = (blockId: BlockId, rev: number, actionId = 'local-action') => {
	const calls: BlockGets[] = [];
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId ? { state: { latest: { actionId, rev } } } : { state: {} };
			}
			return result;
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			return { success: true, pending: [], blockIds: [] };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			return { success: true };
		}
	};
	return { repo, calls };
};

describe('CoordinatorRepo read-repair TRUST vulnerability (repro)', () => {
	const blockId: BlockId = 'block-trust-repro';

	it('a single lying peer over-reporting rev steers restoration despite honest majority', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const liar = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, liar]);

		// Honest majority agrees the true latest is rev 1. The liar inflates to rev 99
		// with a fabricated actionId — no proof of any kind.
		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const liarLatest: ActionRev = { actionId: 'bogus-action', rev: 99 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(liar)) return liarLatest;
			return honestLatest;
		};

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 4, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		// VULNERABILITY: restoration fired against the liar's inflated rev 99, even
		// though 3 of 4 peers (including local) agree the true latest is rev 1.
		const liarRestore = calls.find(c => c.context?.rev === liarLatest.rev);
		expect(liarRestore, 'liar steered restoration (this is the bug)').to.not.equal(undefined);
		expect(liarRestore!.context!.committed).to.deep.equal([liarLatest]);
	});
});
