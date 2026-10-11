/**
 * Ticket: a-read-does-not-wait-on-a-connected-but-silent-member (GitHub #25, #34).
 *
 * A read of a block this node HOLDS, whose consult only the lazy read-repair window asked for, is
 * answered from the local copy at once; the consult runs behind it (`startHeldBlockConsult`). These
 * specs pin what that makes true of a read: it does not wait on a cohort peer that never answers,
 * what the consult learns reaches the NEXT read, and a pass that ends late cannot weaken a doubt
 * memo a pass that started after it recorded.
 */

import { expect } from 'chai';
import { localDurability } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev, FindCoordinatorOptions
} from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type CoordinatorRepoConfig } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog, hasTag } from './support/capture-log.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => Object.fromEntries(peerIds.map(peerId => [
	peerId.toString(),
	{ multiaddrs: ['/ip4/127.0.0.1/tcp/8000'], publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url') }
]));

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

/**
 * Storage holding `blockId` at `rev`. With `adopts`, a read whose context names a newer committed
 * revision advances the held copy to it — the shape of a promotion landing, which is how the
 * coordinator's repair converges without an acquisition callback. Without it the copy is fixed, so
 * a corroborated newer revision is one this node cannot reach.
 */
const makeStorageRepo = (blockId: BlockId, rev: number, adopts: boolean): IRepo => {
	let held: ActionRev = { actionId: 'local-action', rev };
	return {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const restoring = blockGets.context?.committed?.find(c => c.rev > held.rev);
			if (adopts && restoring && blockGets.blockIds.includes(blockId)) held = restoring;
			return Object.fromEntries(blockGets.blockIds.map(id => [id, id === blockId ? { state: { latest: held } } : { state: {} }]));
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			return { success: true, pending: [], blockIds: [], durability: localDurability() };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			return { success: true, durability: localDurability() };
		}
	};
};

/** The production callback's self short-circuit: this node answers from its own storage. */
const selfFrom = (storageRepo: IRepo, blockId: BlockId) => async (): Promise<ActionRev | undefined> =>
	(await storageRepo.get({ blockIds: [blockId] }))[blockId]?.state?.latest;

const buildRepo = (
	localPeer: PeerId, cluster: ClusterPeers, storageRepo: IRepo, callback: ClusterLatestCallback, cfg: CoordinatorRepoConfig
): CoordinatorRepo => new CoordinatorRepo(
	makeKeyNetwork(cluster), makeClusterClient, storageRepo,
	{ readRepairMode: 'lazy', ...cfg },
	undefined, localPeer, undefined, callback
);

describe('CoordinatorRepo held-block background consult', () => {
	const blockId: BlockId = 'block-held-background';

	it('serves a held block at once while a cohort peer never answers, and starts one consult for it', async () => {
		// #25's shape: the peer is connected (the dial does not fail) and does not answer. The
		// consult's per-peer budget is what a blocking read would have waited out.
		const localPeer = await makePeerId();
		const silentPeer = await makePeerId();
		const storageRepo = makeStorageRepo(blockId, 1, false);
		const asked: string[] = [];
		const callback: ClusterLatestCallback = async (peerId) => {
			asked.push(peerId.toString());
			if (peerId.equals(localPeer)) return selfFrom(storageRepo, blockId)();
			return new Promise(() => { /* never answers */ });
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, silentPeer]), storageRepo, callback, { clusterSize: 2, cohortQueryTimeoutMs: 500 });

		const started = Date.now();
		const first = await repo.get({ blockIds: [blockId] });
		const second = await repo.get({ blockIds: [blockId] });
		const elapsedMs = Date.now() - started;

		expect(elapsedMs, 'neither read waited on the silent peer\'s budget').to.be.below(400);
		for (const result of [first, second]) {
			expect(result[blockId]?.state?.latest?.rev).to.equal(1);
			expect(result[blockId]?.unavailable).to.equal(undefined);
			expect(result[blockId]?.unconfirmedAheadRev).to.equal(undefined);
		}

		await repo.settleHeldBlockConsults();
		expect(asked.filter(id => id === silentPeer.toString()), 'one consult per block, not one per read').to.have.length(1);
	});

	it('a repair the consult lands is served by the next read, and arms the window', async () => {
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const storageRepo = makeStorageRepo(blockId, 1, true);
		const ahead: ActionRev = { actionId: 'remote-action', rev: 2 };
		let remoteConsults = 0;
		const callback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(localPeer)) return selfFrom(storageRepo, blockId)();
			remoteConsults++;
			return ahead;
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peerA, peerB]), storageRepo, callback, { clusterSize: 3 });

		const first = await repo.get({ blockIds: [blockId] });
		expect(first[blockId]?.state?.latest?.rev, 'served from the copy held when the read arrived').to.equal(1);
		expect(first[blockId]?.unconfirmedAheadRev).to.equal(undefined);

		await repo.settleHeldBlockConsults();
		const consultsAfterSettle = remoteConsults;
		const second = await repo.get({ blockIds: [blockId] });

		expect(second[blockId]?.state?.latest).to.deep.equal(ahead);
		expect(remoteConsults, 'the consult armed the window, so the next read consulted nobody').to.equal(consultsAfterSettle);
	});

	it('a claim the consult cannot settle flags the next read', async () => {
		// Same cohort, but this node can neither promote nor acquire the corroborated revision, so the
		// pass ends with an unsettled claim. The read that started it was already answered unflagged;
		// the doubt is stamped on the reads after it.
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const storageRepo = makeStorageRepo(blockId, 1, false);
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(localPeer) ? selfFrom(storageRepo, blockId)() : { actionId: 'remote-action', rev: 2 };
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peerA, peerB]), storageRepo, callback, { clusterSize: 3 });

		const first = await repo.get({ blockIds: [blockId] });
		expect(first[blockId]?.unconfirmedAheadRev).to.equal(undefined);

		await repo.settleHeldBlockConsults();
		const second = await repo.get({ blockIds: [blockId] });

		expect(second[blockId]?.state?.latest?.rev).to.equal(1);
		expect(second[blockId]?.unconfirmedAheadRev).to.equal(2);
	});

	it('an older pass that ends late cannot retire a doubt a newer pass recorded', async () => {
		// Pass A runs behind an unfloored read and is held open at peer X. Pass B, a floored read's
		// blocking consult, starts after it and records X's claim of revision 3. A then ends with X
		// answering "nothing ahead" — an answer older than the claim B recorded — and must not retire it.
		// `clusterSize` is left at its default (10), so X alone never corroborates and its claim stays
		// unsettled; the per-peer budget is widened so A cannot expire into silence before it is released.
		const localPeer = await makePeerId();
		const peerX = await makePeerId();
		const storageRepo = makeStorageRepo(blockId, 1, false);
		let arrivedA!: () => void;
		const aArrived = new Promise<void>(resolve => { arrivedA = resolve; });
		let releaseA!: (answer: ActionRev | undefined) => void;
		const aAnswer = new Promise<ActionRev | undefined>(resolve => { releaseA = resolve; });
		let xAsked = 0;
		const callback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(localPeer)) return selfFrom(storageRepo, blockId)();
			xAsked++;
			if (xAsked === 1) {
				arrivedA();
				return aAnswer;
			}
			return { actionId: 'remote-action', rev: 3 };
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peerX]), storageRepo, callback, { cohortQueryTimeoutMs: 5_000 });

		const first = await repo.get({ blockIds: [blockId] });
		expect(first[blockId]?.unconfirmedAheadRev).to.equal(undefined);
		await aArrived;

		const floored = await repo.get({ blockIds: [blockId], floors: { [blockId]: 2 } });
		expect(floored[blockId]?.unconfirmedAheadRev, 'pass B recorded X\'s claim').to.equal(3);

		const captured = await captureLog('coordinator-repo', async () => {
			releaseA(undefined);
			await repo.settleHeldBlockConsults();
		});
		expect(hasTag(captured, 'cluster-fetch:stale-pass-ignored'), 'pass A\'s retirement was refused').to.equal(true);

		const after = await repo.get({ blockIds: [blockId] });
		expect(after[blockId]?.unconfirmedAheadRev, 'the memo B wrote stands').to.equal(3);
	});
});
