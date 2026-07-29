/**
 * Tickets: bug-read-repair-unrepairable-small-cluster, read-repair-cannot-transfer-block-content.
 *
 * Selecting the right revision is necessary for read-repair, but it is not the same
 * thing as converging. Every other read-repair spec in this package stubs `IRepo`, so it
 * can only observe that a restoration call was *made* with the right context. This spec
 * wires two nodes' REAL `StorageRepo`/`BlockStorage` over an in-process stand-in for the
 * sync protocol (`serveArchive` mirrors `SyncService.buildArchive`, node B's
 * `restoreCallback` plays the part of `RestorationCoordinator`, and B's
 * `acquireBlockFromCohort` is the real `createReconcileBlock` over that same stand-in, as
 * `libp2p-node-base` wires it) and then asks the only question that matters: after the read,
 * does the lagging node actually hold the newer block?
 *
 * It now does — for a stale block AND for one it had never seen. The last spec pins the
 * boundary that keeps that affordable: a block no peer claims corroborates nothing, so it
 * never reaches the archive fetch.
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
import { createReconcileBlock } from '../src/cluster/reconcile-block.js';
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

	/**
	 * Node A holds rev 2. Node B either stopped at rev 1 (`seedB: true`, the default — a CONTENT gap)
	 * or has never seen the block at all (`seedB: false` — the case that blocks a fresh reader from
	 * ever opening a collection whose header block it missed). B then reads and repairs itself from A.
	 *
	 * `restoreB: false` drops B's storage-layer restore callback, which is what makes a forward
	 * revision genuinely unreachable by promotion — see the `promote-unavailable` spec.
	 */
	const buildDivergedPair = async ({ seedB = true, restoreB = true }: { seedB?: boolean, restoreB?: boolean } = {}) => {
		const aStorage = new MemoryRawStorage();
		const bStorage = new MemoryRawStorage();

		const aRepo = new StorageRepo(id => new BlockStorage(id, aStorage));
		// B's restore callback is the in-process stand-in for RestorationCoordinator: when
		// BlockStorage decides it needs a revision it does not hold, it pulls A's archive.
		const restoreFromA: RestoreCallback = async (blockId) => await serveArchive(aRepo, blockId);
		const bRepo = new StorageRepo(id => new BlockStorage(id, bStorage, restoreB ? restoreFromA : undefined));

		// A lands rev 1 then rev 2; B lands only rev 1, and only when seeded.
		await writeRevision(aRepo, 'action-1' as ActionId, 1, 'v1');
		if (seedB) await writeRevision(bRepo, 'action-1' as ActionId, 1, 'v1');
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

		// Counts the archive fetches the acquisition path costs, so a spec can assert that a
		// genuinely-absent block pays for none.
		let archiveFetches = 0;
		const acquireBlockFromCohort = createReconcileBlock({
			selfPeerId: peerB.toString(),
			fetchArchive: async (peerIdStr, blockId) => {
				archiveFetches++;
				return peerIdStr === peerA.toString() ? await serveArchive(aRepo, blockId) : undefined;
			},
			saveReplicatedBlock: (blockId, block, source) => bRepo.saveReplicatedBlock(blockId, block, source),
			simpleMajorityThreshold: 0.51,
			assumedClusterSize: 2
		});

		const bCoordinator = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			bRepo,
			{ clusterSize: 2, readRepairMode: 'paranoid' },
			undefined,
			peerB,
			undefined,
			clusterLatestCallback,
			undefined,
			undefined,
			acquireBlockFromCohort
		);

		return { aRepo, bRepo, bCoordinator, archiveFetches: () => archiveFetches };
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

	it('selects the peer\'s newer revision and reports a real sync', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair();

		const captured = await captureLog('coordinator-repo', async () => {
			await bCoordinator.get({ blockIds: [BLOCK_ID] });
		});

		// Selection no longer declines: A's rev 2 is corroborated (A is the only peer that
		// could corroborate) and drives a restoration attempt against B's real storage.
		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'must not decline').to.equal(false);
		// The attempt is reported by its OUTCOME, and the outcome is now a genuine transfer.
		// `cluster-fetch:synced` was unreachable for a content gap until block acquisition landed;
		// it must never be logged without a matching advance in storage, asserted below.
		expect(hasTagAtRev(captured, 'cluster-fetch:synced', 2), 'the transfer is reported').to.equal(true);
		expect(hasTag(captured, 'cluster-fetch:not-restored')).to.equal(false);
		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest?.rev).to.equal(2);
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
	 * The acceptance test for `read-repair-cannot-transfer-block-content`.
	 *
	 * Selecting the corroborated revision was never enough on its own: the restore
	 * `fetchBlockFromCluster` used to perform (`storageRepo.get({ context: { committed, rev } })`)
	 * only promotes a pending this node ALREADY holds, and B never pended `action-2`. The follow-up
	 * `getBlock(2)` cannot rescue it either — `BlockStorage` records coverage as the open-ended span
	 * `[E, +inf)`, so `ensureRevision` treats rev 2 as covered and the descending walk resolves it
	 * down to B's own rev-1 materialization. B stayed at `v1` forever.
	 *
	 * The read path now falls through to `acquireBlockFromCohort` — the same
	 * `createReconcileBlock` the commit path uses — so the bytes actually move. The read itself must
	 * also serve the converged content, not just leave it in storage for the next caller.
	 */
	it('converges the block content and the latest pointer', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair();

		const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
		expect(served[BLOCK_ID]?.state?.latest?.rev, 'the repairing read serves the new revision').to.equal(2);
		expect(payloadOf(served[BLOCK_ID]?.block), 'the repairing read serves the new content').to.equal('v2');

		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest?.rev, 'latest pointer advanced durably').to.equal(2);
		expect(payloadOf(after[BLOCK_ID]?.block), 'content converged durably').to.equal('v2');
	});

	/**
	 * The downstream blocker: a collection's header block committed solo on the writer during a
	 * cohort-formation race, so the reader has NO local metadata for it. `BlockStorage.getBlock`
	 * returns `undefined` before `ensureRevision` runs, so the restore callback is unreachable — the
	 * reader could establish `clusterRev` and still never obtain the block, logging
	 * `cluster-fetch:not-restored { localRev: undefined, clusterRev: 1 }` on every read.
	 */
	it('acquires a block it has never seen once the cohort corroborates one', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair({ seedB: false });

		const before = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(before[BLOCK_ID]?.state?.latest, 'B starts with no metadata at all').to.equal(undefined);

		const captured = await captureLog('coordinator-repo', async () => {
			const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
			expect(payloadOf(served[BLOCK_ID]?.block), 'the acquiring read serves the block').to.equal('v2');
		});
		expect(hasTagAtRev(captured, 'cluster-fetch:synced', 2)).to.equal(true);

		const after = await bRepo.get({ blockIds: [BLOCK_ID] });
		expect(after[BLOCK_ID]?.state?.latest?.rev).to.equal(2);
		expect(payloadOf(after[BLOCK_ID]?.block)).to.equal('v2');
	});

	/**
	 * A forward revision no local promotion can reach must be an ABSENCE, not a read failure.
	 *
	 * B holds metadata for the block (seeded by a pend of some unrelated action) but no committed
	 * revision, so `StorageRepo.get` with the corroborated commit context finds no pending to promote
	 * and then throws out of `BlockStorage.ensureRevision` — rev 2 is outside B's (empty) coverage
	 * ranges and B has no storage-layer restore to supply it. That throw used to escape
	 * `fetchBlockFromCluster` as `cluster-fetch:error`, ending the pass before the one mechanism that
	 * CAN supply the revision ever ran. It must now be logged and stepped over.
	 */
	it('falls through to acquisition when no local promotion can reach the revision', async () => {
		const { bRepo, bCoordinator } = await buildDivergedPair({ seedB: false, restoreB: false });
		const pended = await bRepo.pend({
			actionId: 'action-unrelated' as ActionId,
			rev: 1,
			transforms: { inserts: { [BLOCK_ID]: makeBlock('never-committed') }, updates: {}, deletes: [] } as Transforms,
			policy: 'c'
		});
		expect(pended.success).to.equal(true);

		const captured = await captureLog('coordinator-repo', async () => {
			const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
			expect(payloadOf(served[BLOCK_ID]?.block), 'the read still serves the cohort content').to.equal('v2');
		});

		expect(hasTag(captured, 'cluster-fetch:promote-unavailable'), 'the unreachable promotion is reported').to.equal(true);
		expect(hasTag(captured, 'cluster-fetch:error'), 'but it must not abort the pass').to.equal(false);
		expect(hasTagAtRev(captured, 'cluster-fetch:synced', 2), 'acquisition supplied it instead').to.equal(true);
		expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest?.rev).to.equal(2);
	});

	/**
	 * The boundary that keeps acquisition affordable. An insert probes a fresh random block id for a
	 * collision, and that read must not cost a block transfer. No peer claims the id, so nothing is
	 * corroborated and `fetchBlockFromCluster` returns before the acquisition step — the absence stays
	 * as cheap as it was, priced at the latest-query round trip that already happened.
	 */
	it('never fetches an archive for a block no peer claims', async () => {
		const { bCoordinator, archiveFetches } = await buildDivergedPair();
		const absentId = 'block-nobody-has' as BlockId;

		const captured = await captureLog('coordinator-repo', async () => {
			const result = await bCoordinator.get({ blockIds: [absentId] });
			expect(result[absentId]?.state?.latest, 'reported absent').to.equal(undefined);
		});

		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'nothing corroborated the id').to.equal(true);
		expect(archiveFetches(), 'a genuine absence costs no archive fetch').to.equal(0);

		// Control on the counter itself: a zero above must mean "the absence declined early", not
		// "nothing is wired to this counter". The same fixture's corroborable block does fetch.
		await bCoordinator.get({ blockIds: [BLOCK_ID] });
		expect(archiveFetches(), 'a corroborated block does reach the archive fetch').to.be.greaterThan(0);
	});
});
