/**
 * Ticket: p2p-read-repair-verify-peer-claims (fix of p2p-read-repair-unverified-peer-claims)
 *
 * `queryClusterForLatest` used to take the MAX ActionRev any single peer reported,
 * with no quorum check — so a lone lying peer over-reporting its revision steered
 * restoration. It now accepts only the highest `(rev, actionId)` corroborated by a
 * quorum of distinct peers. These specs pin the fixed behavior:
 *   - a single lying peer is outvoted (no restore against the lie),
 *   - independent minority liars are outvoted,
 *   - an honest quorum-backed higher rev still drives restoration,
 *   - a lone honest (lagging) responder still restores via the small-cluster fallback.
 *
 * NOTE: the quorum is corroboration-of-a-claim, NOT Sybil-resistant cohort
 * membership — colluding peers minting fresh keypairs onto the SAME fabricated
 * pair can still reach quorum. That is out of scope here (see backlog
 * `debt-read-repair-commit-cert-verification`).
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
import type { IPeerReputation, PenaltyReason } from '../src/reputation/types.js';
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

/** Minimal reputation stub recording reportPeer calls. */
const makeReputationStub = () => {
	const reports: { peerId: string; reason: PenaltyReason }[] = [];
	const rep: IPeerReputation = {
		reportPeer(peerId, reason) { reports.push({ peerId, reason }); },
		recordSuccess() { },
		getScore() { return 0; },
		isBanned() { return false; },
		isDeprioritized() { return false; },
		getReputation() { return {} as any; },
		getAllReputations() { return new Map(); },
		resetPeer() { }
	};
	return { rep, reports };
};

describe('CoordinatorRepo read-repair TRUST (quorum-corroborated)', () => {
	const blockId: BlockId = 'block-trust';

	it('a single lying peer over-reporting rev is OUTVOTED — no restore against the lie', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const liar = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, liar]);

		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const liarLatest: ActionRev = { actionId: 'bogus-action', rev: 99 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(liar) ? liarLatest : honestLatest;

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');
		const { rep, reports } = makeReputationStub();

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 4, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback,
			rep
		);

		await repo.get({ blockIds: [blockId] });

		// The liar's inflated rev 99 must NOT have driven any restoration.
		const liarRestore = calls.find(c => c.context?.rev === 99);
		expect(liarRestore, 'liar must not steer restoration').to.equal(undefined);

		// Any restoration that did fire uses the honest quorum rev 1.
		const anyRestore = calls.find(c => c.context?.committed);
		if (anyRestore) {
			expect(anyRestore.context!.rev).to.equal(1);
			expect(anyRestore.context!.committed).to.deep.equal([honestLatest]);
		}

		// The liar is penalized best-effort for the contradicted claim.
		expect(reports.map(r => r.peerId)).to.include(liar.toString());
		expect(reports.every(r => r.peerId !== honestA.toString() && r.peerId !== honestB.toString()),
			'honest peers must not be penalized').to.equal(true);
	});

	it('independent minority liars (distinct fabricated pairs) are outvoted', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const liarX = await makePeerId();
		const liarY = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, liarX, liarY]);

		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(liarX)) return { actionId: 'bogus-x', rev: 99 };
			if (peerId.equals(liarY)) return { actionId: 'bogus-y', rev: 98 };
			return honestLatest;
		};

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 5, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		expect(calls.find(c => c.context?.rev === 99), 'liarX must not steer restoration').to.equal(undefined);
		expect(calls.find(c => c.context?.rev === 98), 'liarY must not steer restoration').to.equal(undefined);
	});

	it('an honest quorum-backed HIGHER rev still drives restoration', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const lagging = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, lagging]);

		const newer: ActionRev = { actionId: 'action-5', rev: 5 };
		const stale: ActionRev = { actionId: 'local-action', rev: 1 };
		// honestA + honestB agree on rev 5; local + lagging are still on rev 1.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			(peerId.equals(honestA) || peerId.equals(honestB)) ? newer : stale;

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

		const restore = calls.find(c => c.context?.rev === 5);
		expect(restore, 'quorum-backed rev 5 must drive restoration').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([newer]);
	});

	it('a lone honest (lagging) responder still restores via the small-cluster fallback', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
		// Only the other peer answers (local is missing/undefined here) — one honest responder.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(otherPeer) ? remoteLatest : undefined;

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 2, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 2);
		expect(restore, 'single honest responder must still restore').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([remoteLatest]);
	});
});
