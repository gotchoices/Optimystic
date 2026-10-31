/**
 * Ticket: a-read-does-not-wait-on-a-connected-but-silent-member (GitHub #25, #34).
 *
 * A read of a block this node HOLDS, whose consult only the lazy read-repair window asked for, is
 * answered from the local copy at once; the consult runs behind it (`startHeldBlockConsult`). These
 * specs pin what that makes true of a read: it does not wait on a cohort peer that never answers,
 * what the consult learns reaches the NEXT read, a pass that ends late cannot weaken a doubt memo a
 * pass that started after it recorded, and how many such passes may run at once (counted in consult
 * requests, `HeldBlockConsults`).
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
import type { ClusterLatestBatchCallback } from '../src/repo/consult-round.js';
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

/** The write half of a storage double; these specs only read. */
const noWrites: Pick<IRepo, 'pend' | 'cancel' | 'commit'> = {
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	}
};

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
		...noWrites
	};
};

/** Storage holding every block of `blockIds` at revision 1, fixed. */
const makeStorageHoldingAll = (blockIds: BlockId[]): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(blockGets.blockIds.map(id => [id, blockIds.includes(id) ? { state: { latest: { actionId: 'local-action', rev: 1 } } } : { state: {} }]));
	},
	...noWrites
});

/** The production callback's self short-circuit: this node answers from its own storage. */
const selfFrom = (storageRepo: IRepo, blockId: BlockId) => async (): Promise<ActionRev | undefined> =>
	(await storageRepo.get({ blockIds: [blockId] }))[blockId]?.state?.latest;

/**
 * The single-block callback beside a batch callback: a round asks only this node itself through it.
 * A remote peer asked through it rejects, so a question that bypassed the batch reads as silence.
 */
const selfOnly = (localPeer: PeerId, storageRepo: IRepo): ClusterLatestCallback => async (peerId, blockId) => {
	if (!peerId.equals(localPeer)) throw new Error(`${blockId} asked of ${peerId.toString()} outside the batch`);
	return selfFrom(storageRepo, blockId)();
};

/** A batch callback's reply answering every block asked at the revision the asker holds. */
const answerHeld = (asks: Parameters<ClusterLatestBatchCallback>[1]) => ({ answers: new Map(asks.map(ask => [ask.blockId, ask.held])) });

const buildRepo = (
	localPeer: PeerId, cluster: ClusterPeers, storageRepo: IRepo, callback: ClusterLatestCallback, cfg: CoordinatorRepoConfig,
	batch?: ClusterLatestBatchCallback
): CoordinatorRepo => new CoordinatorRepo(
	makeKeyNetwork(cluster), makeClusterClient, storageRepo,
	{ readRepairMode: 'lazy', ...cfg },
	undefined, localPeer, undefined, callback,
	undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, batch
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
		// The budget is the discriminator: a read that waited on the silent peer takes at least this long,
		// one that did not takes milliseconds. The margin is wide so a slow machine cannot blur the two.
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, silentPeer]), storageRepo, callback, { clusterSize: 2, cohortQueryTimeoutMs: 2_000 });

		const started = Date.now();
		const first = await repo.get({ blockIds: [blockId] });
		const second = await repo.get({ blockIds: [blockId] });
		const elapsedMs = Date.now() - started;

		expect(elapsedMs, 'neither read waited on the silent peer\'s budget').to.be.below(1_000);
		for (const result of [first, second]) {
			expect(result[blockId]?.state?.latest?.rev).to.equal(1);
			expect(result[blockId]?.unavailable).to.equal(undefined);
			expect(result[blockId]?.unconfirmedAheadRev).to.equal(undefined);
		}

		await repo.settleHeldBlockConsults();
		expect(asked.filter(id => id === silentPeer.toString()), 'one consult per block, not one per read').to.have.length(1);
	});

	it('a read marked skipWindowConsult starts no consult for a held block, and leaves the window expired', async () => {
		// Ticket a-read-can-skip-the-background-consult: the watch tick's read of what this node holds.
		const localPeer = await makePeerId();
		const peer = await makePeerId();
		const storageRepo = makeStorageRepo(blockId, 1, false);
		const asked: string[] = [];
		const callback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(localPeer)) return selfFrom(storageRepo, blockId)();
			asked.push(peerId.toString());
			return { actionId: 'local-action', rev: 1 };
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peer]), storageRepo, callback, { clusterSize: 2 });

		const skipped = await repo.get({ blockIds: [blockId], skipWindowConsult: true });
		await repo.settleHeldBlockConsults();
		expect(skipped[blockId]?.state?.latest?.rev).to.equal(1);
		expect(asked, 'no consult behind a skipWindowConsult read').to.have.length(0);

		await repo.get({ blockIds: [blockId] });
		await repo.settleHeldBlockConsults();
		expect(asked, 'the next unmarked read consults: the window was left expired').to.have.length(1);
	});

	it('a read marked skipWindowConsult still consults for a block missing locally', async () => {
		const localPeer = await makePeerId();
		const peer = await makePeerId();
		const storageRepo = makeStorageRepo('some-other-block', 1, false);
		const asked: string[] = [];
		const callback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(localPeer)) return undefined;
			asked.push(peerId.toString());
			return undefined;
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peer]), storageRepo, callback, { clusterSize: 2 });

		const result = await repo.get({ blockIds: [blockId], skipWindowConsult: true });
		expect(asked, 'the absence verdict still asks the cohort').to.have.length(1);
		expect(result[blockId]?.state?.latest).to.equal(undefined);
		expect(result[blockId]?.unavailable, 'the whole cohort answered "holds nothing"').to.equal(undefined);
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

	it('one read naming more held blocks than there are slots consults every one, in two requests per peer', async () => {
		// A batched tail read across 18 collections names 36 blocks. The read's round asks each peer
		// about up to 32 blocks per request, so its 36 passes need 2 of the 16 slots. Counted one per
		// block, the first 16 started and the other 20 were deferred — the same 20 on every such read.
		const localPeer = await makePeerId();
		const peers = [await makePeerId(), await makePeerId()];
		const blockIds = Array.from({ length: 36 }, (_, i) => `block-wide-${i}`);
		const storageRepo = makeStorageHoldingAll(blockIds);
		const batchCalls: { peer: string; blockIds: BlockId[] }[] = [];
		const batch: ClusterLatestBatchCallback = async (peerId, asks) => {
			batchCalls.push({ peer: peerId.toString(), blockIds: asks.map(ask => ask.blockId) });
			return answerHeld(asks);
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, ...peers]), storageRepo, selfOnly(localPeer, storageRepo), { clusterSize: 3 }, batch);

		await repo.get({ blockIds });
		await repo.settleHeldBlockConsults();

		for (const peer of peers) {
			const calls = batchCalls.filter(call => call.peer === peer.toString());
			expect(calls.map(call => call.blockIds.length), 'two requests: 32 blocks, then 4').to.have.members([32, 4]);
			expect(calls.flatMap(call => call.blockIds), 'every block was consulted').to.have.members(blockIds);
		}
	});

	it('a seventeenth single-block read is deferred while sixteen consults are held open', async () => {
		// Unbatched reads keep the bound they always had: each read's round is a request of its own to the peer.
		const localPeer = await makePeerId();
		const peer = await makePeerId();
		const blockIds = Array.from({ length: 17 }, (_, i) => `block-single-${i}`);
		const storageRepo = makeStorageHoldingAll(blockIds);
		const asked: BlockId[] = [];
		let release!: () => void;
		const released = new Promise<void>(resolve => { release = resolve; });
		const batch: ClusterLatestBatchCallback = async (_peerId, asks) => {
			asked.push(...asks.map(ask => ask.blockId));
			await released;
			return answerHeld(asks);
		};
		const repo = buildRepo(localPeer, makeClusterPeers([localPeer, peer]), storageRepo, selfOnly(localPeer, storageRepo), { clusterSize: 2, cohortQueryTimeoutMs: 5_000 }, batch);

		const captured = await captureLog('coordinator-repo', async () => {
			for (const blockId of blockIds) await repo.get({ blockIds: [blockId] });
		});
		release();
		await repo.settleHeldBlockConsults();

		expect(asked, 'each of the first sixteen reads consulted').to.have.members(blockIds.slice(0, 16));
		const deferred = captured.filter(args => typeof args[0] === 'string' && args[0].includes('cluster-tx:read-repair-deferred'));
		expect(deferred.map(args => args[1]), 'the seventeenth was deferred with every slot in use')
			.to.deep.equal([{ blockId: blockIds[16], inFlight: 16, slotsInUse: 16 }]);
	});
});
