/**
 * Ticket: bug-read-repair-unrepairable-small-cluster.
 *
 * Selecting the right revision is necessary for read-repair, but it is not the same
 * thing as converging. Every other read-repair spec in this package stubs `IRepo`, so it
 * can only observe that a restoration call was *made* with the right context. This spec
 * wires two nodes' REAL `StorageRepo`/`BlockStorage` over an in-process stand-in for the
 * sync protocol (`serveArchive` mirrors `SyncService.buildArchive`, and node B's
 * `restoreCallback` plays the part of `RestorationCoordinator`) and then asks the only
 * question that matters: after the read, does the lagging node actually hold the newer
 * block?
 *
 * It does not. The specs below pin what the read path really does today so the gap is
 * visible in the test output rather than only in a document — see
 * `tickets/fix/read-repair-cannot-transfer-block-content.md`.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	ActionId, BlockHeader, BlockId, ClusterPeers, IBlock, IKeyNetwork, IRepo, Transforms, ActionRev,
	FindCoordinatorOptions
} from '@optimystic/db-core';
import { toString as u8ToString } from 'uint8arrays';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import type { BlockArchive, RestoreCallback } from '../src/storage/struct.js';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { captureLog, hasTag, hasTagAtRev } from './support/capture-log.js';

const BLOCK_ID = 'block-content-convergence' as BlockId;
const COLLECTION_ID = 'content-convergence-collection' as BlockId;

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

const makeBlock = (payload: string): IBlock => ({
	header: { id: BLOCK_ID, type: 'test', collectionId: COLLECTION_ID } as BlockHeader,
	payload
} as unknown as IBlock);

const payloadOf = (block: IBlock | undefined): string | undefined =>
	(block as unknown as { payload?: string } | undefined)?.payload;

/** Pend + commit one whole-block write at `rev`, asserting both halves succeeded. */
const writeRevision = async (repo: IRepo, actionId: ActionId, rev: number, payload: string): Promise<void> => {
	const transforms: Transforms = { inserts: { [BLOCK_ID]: makeBlock(payload) }, updates: {}, deletes: [] };
	const pended = await repo.pend({ actionId, rev, transforms, policy: 'c' });
	expect(pended.success, `pend of ${actionId} must succeed`).to.equal(true);
	const committed = await repo.commit({ actionId, blockIds: [BLOCK_ID], tailId: BLOCK_ID, rev });
	expect(committed.success, `commit of ${actionId} must succeed`).to.equal(true);
};

/**
 * The archive a peer serves for its own latest revision. Mirrors
 * `SyncService.buildArchive`: one revision, carrying the materialized block.
 */
const serveArchive = async (repo: IRepo, blockId: BlockId): Promise<BlockArchive | undefined> => {
	const result = await repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as never);
	const entry = result[blockId];
	const latest = entry?.state?.latest;
	if (!latest) return undefined;
	return {
		blockId,
		revisions: {
			[latest.rev]: {
				action: { actionId: latest.actionId, rev: latest.rev, transform: { insert: entry!.block } },
				block: entry!.block
			}
		},
		range: [latest.rev, latest.rev + 1]
	};
};

/** The latest `(rev, actionId)` a peer advertises, derived from its archive as `libp2p-node-base` does. */
const latestFromArchive = (archive: BlockArchive | undefined): ActionRev | undefined => {
	if (!archive) return undefined;
	const revs = Object.keys(archive.revisions).map(Number);
	if (revs.length === 0) return undefined;
	const maxRev = Math.max(...revs);
	const action = archive.revisions[maxRev]?.action;
	return action ? { actionId: action.actionId, rev: maxRev } : undefined;
};

describe('CoordinatorRepo read-repair CONTENT convergence', function () {
	this.timeout(5_000);

	/** Node A holds rev 2; node B stopped at rev 1. B reads and tries to repair itself from A. */
	const buildDivergedPair = async () => {
		const aStorage = new MemoryRawStorage();
		const bStorage = new MemoryRawStorage();

		const aRepo = new StorageRepo(id => new BlockStorage(id, aStorage));
		// B's restore callback is the in-process stand-in for RestorationCoordinator: when
		// BlockStorage decides it needs a revision it does not hold, it pulls A's archive.
		const restoreFromA: RestoreCallback = async (blockId) => await serveArchive(aRepo, blockId);
		const bRepo = new StorageRepo(id => new BlockStorage(id, bStorage, restoreFromA));

		// Both land rev 1 from the same action; only A goes on to rev 2.
		await writeRevision(aRepo, 'action-1' as ActionId, 1, 'v1');
		await writeRevision(bRepo, 'action-1' as ActionId, 1, 'v1');
		await writeRevision(aRepo, 'action-2' as ActionId, 2, 'v2');

		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const cluster = makeClusterPeers([peerA, peerB]);

		// Production-shaped callback: self short-circuits to local storage, A answers from
		// the archive it would have served over the sync protocol.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context) => {
			if (peerId.equals(peerB)) {
				const local = await bRepo.get({ blockIds: [blockId], context }, { skipClusterFetch: true } as never);
				return local[blockId]?.state?.latest;
			}
			return latestFromArchive(await serveArchive(aRepo, blockId));
		};

		const bCoordinator = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			bRepo,
			{ clusterSize: 2, readRepairMode: 'paranoid' },
			undefined,
			peerB,
			undefined,
			clusterLatestCallback
		);

		return { aRepo, bRepo, bCoordinator };
	};

	it('sanity: the two nodes really are diverged before the read', async () => {
		const { aRepo, bRepo } = await buildDivergedPair();
		const a = await aRepo.get({ blockIds: [BLOCK_ID] });
		const b = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(a[BLOCK_ID]?.state?.latest?.rev).to.equal(2);
		expect(payloadOf(a[BLOCK_ID]?.block)).to.equal('v2');
		expect(b[BLOCK_ID]?.state?.latest?.rev).to.equal(1);
		expect(payloadOf(b[BLOCK_ID]?.block)).to.equal('v1');
	});

	it('selects the peer\'s newer revision (the fix in this ticket)', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair();

		const captured = await captureLog('coordinator-repo', async () => {
			await bCoordinator.get({ blockIds: [BLOCK_ID] });
		});

		// Selection no longer declines: A's rev 2 is corroborated (A is the only peer that
		// could corroborate) and drives a restoration attempt against B's real storage.
		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'must not decline').to.equal(false);
		// The attempt is reported by its OUTCOME. Nothing transfers (see the KNOWN GAP spec
		// below), so `cluster-fetch:synced` must be absent — logging it unconditionally, as this
		// path used to, manufactured hundreds of phantom convergences per run and hid a real
		// replication defect for two debugging sessions.
		// Ticket: bug-member-commits-unmaterializable-revision, secondary defect 1.
		expect(hasTagAtRev(captured, 'cluster-fetch:synced', 2), 'nothing was restored, so nothing may claim it was').to.equal(false);
		expect(hasTag(captured, 'cluster-fetch:not-restored'), 'the failed restore is reported').to.equal(true);
		// And it ran against real storage without throwing, leaving B consistent.
		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest).to.not.equal(undefined);
	});

	/**
	 * Positive control for the outcome logging above: when the restore genuinely moves B
	 * forward, `cluster-fetch:synced` must still fire. B holds `action-2` as a local pending
	 * (it saw the pend but missed the commit), which is the one case today's restore context
	 * can promote.
	 */
	it('logs cluster-fetch:synced only when the block actually advanced', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair();
		const pended = await bRepo.pend({
			actionId: 'action-2' as ActionId,
			rev: 2,
			transforms: { inserts: { [BLOCK_ID]: makeBlock('v2') }, updates: {}, deletes: [] } as Transforms,
			policy: 'c'
		});
		expect(pended.success).to.equal(true);

		const captured = await captureLog('coordinator-repo', async () => {
			await bCoordinator.get({ blockIds: [BLOCK_ID] });
		});

		expect(hasTagAtRev(captured, 'cluster-fetch:synced', 2), 'a real advance must be reported').to.equal(true);
		expect(hasTag(captured, 'cluster-fetch:not-restored')).to.equal(false);
		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest?.rev).to.equal(2);
		expect(payloadOf(after[BLOCK_ID]?.block)).to.equal('v2');
	});

	/**
	 * KNOWN GAP — do not "fix" this spec by loosening it; fix the read path.
	 *
	 * `CoordinatorRepo.fetchBlockFromCluster` restores by calling
	 * `storageRepo.get({ context: { committed: [clusterLatest], rev } })`. That context only
	 * promotes a pending transaction the node ALREADY holds locally; B never pended
	 * `action-2`, so the promotion loop finds nothing. The subsequent `getBlock(2)` does not
	 * rescue it either: `BlockStorage` records coverage as the open-ended span `[E, +inf)`,
	 * so `ensureRevision` considers rev 2 already covered and never calls the restore
	 * callback — the descending walk simply resolves rev 2 to B's rev-1 materialization.
	 * Nothing transfers, and `meta.latest` stays at rev 1.
	 *
	 * Block-transferring restoration exists only on the commit path
	 * (`reconcileBlock` → `fetchArchiveFromPeer` → `saveReplicatedBlock`).
	 * Tracked by `tickets/fix/read-repair-cannot-transfer-block-content.md`.
	 */
	it('KNOWN GAP: does NOT converge the block content or the latest pointer', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair();

		await bCoordinator.get({ blockIds: [BLOCK_ID] });
		// A second read, in case a single pass were merely insufficient.
		await bCoordinator.get({ blockIds: [BLOCK_ID] });

		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest?.rev, 'latest pointer does not advance').to.equal(1);
		expect(payloadOf(after[BLOCK_ID]?.block), 'content does not converge').to.equal('v1');
	});
});
