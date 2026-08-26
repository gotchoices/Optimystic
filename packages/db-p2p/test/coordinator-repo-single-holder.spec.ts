/**
 * Ticket: name-the-single-holder-deadlock (upstream gotchoices/Optimystic#15).
 *
 * The unit specs in `coordinator-repo-read-repair.spec.ts` pin the classification against a stubbed
 * `IRepo`. This one pins the same thing end-to-end, over REAL `StorageRepo`/`BlockStorage` instances
 * and the real `createReconcileBlock` acquisition path — the harness from
 * `coordinator-repo-read-repair-content.spec.ts`, extended from two peers to three so the cohort is
 * big enough to reach a quorum and the block still has only one copy.
 *
 * The shape: node A holds the block, reader B holds nothing, node C holds nothing and ANSWERS so —
 * an affirmative "I hold nothing", not silence. That is the whole picture, and it is permanent: the
 * only two mechanisms that would give C (or B) a copy are read-repair and reconcile, and both
 * consume this same decision.
 *
 * What this spec asserts is the DIAGNOSIS, not a behaviour change. B still does not acquire the
 * block — the corroboration floor is untouched by this ticket, and making the block reachable is the
 * separate `replicate-owned-blocks-when-the-cohort-grows` work. The two-peer control alongside shows
 * the harness itself converges when the arithmetic allows it, so a failure to acquire here is the
 * cohort's copy count and not a broken fixture.
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
import type { BlockArchive } from '../src/storage/struct.js';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import { createReconcileBlock } from '../src/cluster/reconcile-block.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { captureLog, hasTag } from './support/capture-log.js';

const BLOCK_ID = 'block-single-holder' as BlockId;
const COLLECTION_ID = 'single-holder-collection' as BlockId;

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

/** The archive a peer serves for its own latest revision. Mirrors `SyncService.buildArchive`. */
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

const DEADLOCK = 'cluster-fetch:repair-deadlock';
type DeadlockPayload = {
	reason?: string, cohortPeers?: number, answered?: number, claimants?: number,
	requiredEvenIfAllAnswered?: number, repairCorroborationClusterSize?: number, message?: string
};
const deadlockLines = (captured: unknown[][]) =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(DEADLOCK));
const noQuorumPayloads = (captured: unknown[][]) => captured
	.filter(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:no-quorum'))
	.map(args => args[1] as { cohortPeers?: number, holders?: number, absent?: number, silent?: number, required?: number });

describe('a block only one machine holds', function () {
	this.timeout(5_000);

	/**
	 * Node A holds the block at rev 1. Reader B holds nothing. `extraNonHolders` further peers hold
	 * nothing and answer so — they are wired into the cohort view AND into the latest-query callback,
	 * which is what makes their absence an answer rather than silence.
	 *
	 * `clusterSize` doubles as the resolved `repairCorroborationClusterSize`; nothing here declares
	 * `assumedClusterSize`.
	 */
	const buildCohort = async ({ extraNonHolders, clusterSize }: { extraNonHolders: number, clusterSize: number }) => {
		const aStorage = new MemoryRawStorage();
		const bStorage = new MemoryRawStorage();

		const aRepo = new StorageRepo(id => new BlockStorage(id, aStorage));
		const bRepo = new StorageRepo(id => new BlockStorage(id, bStorage));

		await writeRevision(aRepo, 'action-1' as ActionId, 1, 'v1');

		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const nonHolders = await Promise.all(Array.from({ length: extraNonHolders }, () => makePeerId()));
		const cluster = makeClusterPeers([peerA, peerB, ...nonHolders]);

		// Every peer answers. B answers from its own storage, A from the archive it would serve over
		// the sync protocol, and each extra peer answers `undefined` — "I hold nothing", which the
		// coordinator counts as an absent claim, never as silence.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context) => {
			if (peerId.equals(peerB)) {
				const local = await bRepo.get({ blockIds: [blockId], context }, { skipClusterFetch: true } as never);
				return local[blockId]?.state?.latest;
			}
			if (peerId.equals(peerA)) return latestFromArchive(await serveArchive(aRepo, blockId));
			return undefined;
		};

		const acquireBlockFromCohort = createReconcileBlock({
			selfPeerId: peerB.toString(),
			fetchArchive: async (peerIdStr, blockId) =>
				peerIdStr === peerA.toString() ? await serveArchive(aRepo, blockId) : undefined,
			saveReplicatedBlock: (blockId, block, source) => bRepo.saveReplicatedBlock(blockId, block, source),
			simpleMajorityThreshold: 0.51,
			repairCorroborationClusterSize: clusterSize
		});

		const bCoordinator = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			bRepo,
			{ clusterSize, readRepairMode: 'paranoid' },
			undefined,
			peerB,
			undefined,
			clusterLatestCallback,
			undefined,
			undefined,
			acquireBlockFromCohort
		);

		return { aRepo, bRepo, bCoordinator };
	};

	/**
	 * The control. Two machines with an honest `clusterSize: 2`: the cohort has exactly one peer, the
	 * floor relaxes to one corroborator, and B acquires the block. Same fixture, same wiring — so
	 * every failure to acquire below is the copy count, not the harness.
	 */
	it('control: with only one peer in the cohort, a declared two-node deployment does converge', async () => {
		const { bRepo, bCoordinator } = await buildCohort({ extraNonHolders: 0, clusterSize: 2 });

		const captured = await captureLog('coordinator-repo', async () => {
			const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
			expect(payloadOf(served[BLOCK_ID]?.block), 'the repairing read serves the block').to.equal('v1');
		});

		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'nothing declines here').to.equal(false);
		expect(deadlockLines(captured), 'and nothing is permanent here').to.have.lengthOf(0);
		expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest?.rev).to.equal(1);
	});

	/**
	 * The reported case. Three machines, one copy. Repeated reads to show the condition is stable and
	 * the line is said once — the field symptom was thousands of identical per-pass declines with no
	 * line naming what was actually wrong.
	 */
	it('names the single holder, once, and still does not acquire the block', async () => {
		const { bRepo, bCoordinator } = await buildCohort({ extraNonHolders: 1, clusterSize: 3 });

		const captured = await captureLog('coordinator-repo', async () => {
			for (let pass = 0; pass < 5; pass++) {
				const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
				expect(served[BLOCK_ID]?.state?.latest, `pass ${pass}: B cannot obtain the block`).to.equal(undefined);
			}
		});

		// Behaviour is unchanged — this ticket is diagnosis only.
		expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest, 'B still holds nothing').to.equal(undefined);

		// The per-pass line fires every pass and now separates the three populations, so a reader of
		// the log can see "1 holder, 1 confirmed non-holder, 0 silent" rather than "1 of 2 responded".
		const declines = noQuorumPayloads(captured);
		expect(declines, 'one decline per pass').to.have.lengthOf(5);
		expect(declines[0]?.cohortPeers).to.equal(2);
		expect(declines[0]?.holders).to.equal(1);
		expect(declines[0]?.absent, 'the third machine ANSWERED that it holds nothing').to.equal(1);
		expect(declines[0]?.silent).to.equal(0);
		expect(declines[0]?.required).to.equal(2);

		// ...and the permanent condition is named once, as a copy-count problem.
		expect(deadlockLines(captured), 'said once across five reads').to.have.lengthOf(1);
		const payload = deadlockLines(captured)[0]![1] as DeadlockPayload;
		expect(payload.reason).to.equal('sole-holder');
		expect(payload.cohortPeers).to.equal(2);
		expect(payload.answered, 'every cohort peer answered').to.equal(2);
		expect(payload.claimants).to.equal(1);
		// The cohort is big enough — this is what makes it a different problem from cohort-too-small.
		expect(payload.requiredEvenIfAllAnswered).to.equal(2);
		expect(payload.message).to.contain('ONLY ONE COHORT PEER HOLDS THIS BLOCK');
		expect(payload.message).to.contain('MORE MACHINES DO NOT FIX THIS');
	});

	/**
	 * The row of the machine-count table this ticket corrects. Four machines was documented as the
	 * first size that "survives one unreachable peer" — true for a block two peers already hold, and
	 * false for this one. Adding machines adds non-holders.
	 */
	it('is not fixed by adding machines — four and six machines diagnose identically', async () => {
		for (const machines of [4, 6]) {
			const { bRepo, bCoordinator } = await buildCohort({ extraNonHolders: machines - 2, clusterSize: machines });

			const captured = await captureLog('coordinator-repo', async () => {
				await bCoordinator.get({ blockIds: [BLOCK_ID] });
			});

			expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest, `${machines} machines`).to.equal(undefined);
			const payload = deadlockLines(captured)[0]![1] as DeadlockPayload;
			expect(payload.reason, `${machines} machines`).to.equal('sole-holder');
			expect(payload.cohortPeers).to.equal(machines - 1);
			expect(payload.claimants, 'still exactly one copy').to.equal(1);
		}
	});
});
