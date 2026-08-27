/**
 * Ticket: replicate-owned-blocks-when-the-cohort-grows (upstream gotchoices/Optimystic#15).
 *
 * The behavioural fix for the single-holder deadlock that `coordinator-repo-single-holder.spec.ts`
 * pins: a block committed while the deployment was ONE machine has one copy; when machines join and
 * become co-responsible, nothing previously pushed them a copy (the holder never LOSES the block, so
 * neither departure-triggered push path fires), and the read-repair corroboration floor of two
 * distinct claimants makes the block permanently unreadable by anyone but its holder.
 *
 * This spec runs the whole heal end-to-end over real components:
 *   - node A: real `StorageRepo` with the founder block committed at rev 1, a real
 *     `RebalanceMonitor` (fed a growing cohort through a mock FRET), and a real
 *     `BlockTransferCoordinator` whose pushes travel through the REAL wire path — the
 *     `BlockTransferClient` length-prefixed protocol frames, loopback-routed into each target's
 *     real `BlockTransferService.handlePush`;
 *   - nodes B and C: real `StorageRepo`s that persist the pushed replica, and (for B) the same
 *     three-peer `CoordinatorRepo` + `createReconcileBlock` reader harness the single-holder spec
 *     uses, so "B can now read it" is decided by the very corroboration arithmetic that previously
 *     declined.
 *
 * Before the growth event: B's read fails exactly as the single-holder spec pins. After the monitor
 * reports the grown cohort and the coordinator pushes, B and C each hold a durable replica at the
 * SOURCE's `(rev, actionId)` — which is what lets them corroborate A's claim — and B's read serves
 * the founder's content. No read-path change is involved; the copy count is what changed.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	ActionId, BlockHeader, BlockId, ClusterPeers, IBlock, IKeyNetwork, IRepo, Transforms, ActionRev,
	FindCoordinatorOptions, IPeerNetwork
} from '@optimystic/db-core';
import { toString as u8ToString } from 'uint8arrays';
import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import type { BlockArchive } from '../src/storage/struct.js';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import { createReconcileBlock } from '../src/cluster/reconcile-block.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { BlockTransferService, type BlockTransferRequest, type BlockTransferResponse } from '../src/cluster/block-transfer-service.js';
import { BlockTransferCoordinator } from '../src/cluster/block-transfer.js';
import { RebalanceMonitor, type RebalanceMonitorDeps } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';
import type { RestorationCoordinator } from '../src/storage/restoration-coordinator.js';
import type { FretService } from 'p2p-fret';

const BLOCK_ID = 'block-founder' as BlockId;
const COLLECTION_ID = 'founder-collection' as BlockId;

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

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

// --- A-side monitor plumbing (mock libp2p events + mock FRET cohort) ---

type EventHandler = (...args: any[]) => void;

class MockLibp2p {
	peerId!: PeerId;
	private listeners = new Map<string, EventHandler[]>();
	addEventListener(event: string, handler: EventHandler): void {
		const list = this.listeners.get(event) ?? [];
		list.push(handler);
		this.listeners.set(event, list);
	}
	removeEventListener(event: string, handler: EventHandler): void {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(event, list.filter(h => h !== handler));
	}
}

class MockFret {
	private cohort: string[] = [];
	setCohort(peers: string[]): void { this.cohort = peers; }
	assembleCohort(_coord: Uint8Array, _wants: number): string[] { return this.cohort; }
	// FretService stubs
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	setMode(): void {}
	async ready(): Promise<void> {}
	neighborDistance(): number { return 0; }
	getNeighbors(): string[] { return []; }
	expandCohort(): string[] { return []; }
	async routeAct(): Promise<any> { return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 }; }
	report(): void {}
	setMetadata(): void {}
	getMetadata(): Record<string, any> | undefined { return undefined; }
	listPeers(): Array<{ id: string }> { return []; }
	reportNetworkSize(): void {}
	getNetworkSizeEstimate() { return { size_estimate: 1, confidence: 0.5, sources: 0 }; }
	getNetworkChurn(): number { return 0; }
	detectPartition(): boolean { return false; }
	exportTable(): any { return { entries: [] }; }
	async importTable(): Promise<number> { return 0; }
}

// --- The loopback wire: real client frames → real service handler → real response frames ---

/**
 * A duplex-shaped stream whose receive side is computed from what the client sent. `ProtocolClient`
 * writes every length-prefixed request frame via `stream.send(...)` BEFORE it starts reading the
 * stream's async iterator, so by first pull the request is complete: LP-decode it, drive the target
 * node's real `BlockTransferService` push/pull handler, and yield the LP-encoded response.
 */
function createLoopbackStream(
	handle: (request: BlockTransferRequest) => Promise<BlockTransferResponse>
): any {
	const sentChunks: Array<Uint8Array | { subarray(): Uint8Array }> = [];
	return {
		send(chunk: Uint8Array) { sentChunks.push(chunk); },
		close: async () => {},
		abort: (_err: Error) => {},
		[Symbol.asyncIterator]: async function* () {
			const frames = pipe(
				(async function* () { for (const c of sentChunks) yield c as Uint8Array; })(),
				(source) => lpDecode(source)
			);
			for await (const frame of frames) {
				const request = JSON.parse(new TextDecoder().decode(frame.subarray())) as BlockTransferRequest;
				const response = await handle(request);
				const encoded = pipe(
					[new TextEncoder().encode(JSON.stringify(response))],
					lpEncode
				);
				for await (const chunk of encoded) yield chunk;
				return; // one request → one response per stream
			}
		}
	};
}

/** Routes a dial to the target peer's real BlockTransferService (push/pull handlers driven directly). */
class LoopbackPeerNetwork implements IPeerNetwork {
	private readonly services = new Map<string, BlockTransferService>();
	dialed: string[] = [];
	/** Peer ids whose dial fails (a transiently unreachable machine). */
	readonly unreachable = new Set<string>();

	register(peerId: PeerId, service: BlockTransferService): void {
		this.services.set(peerId.toString(), service);
	}

	async connect(peerId: PeerId, _protocol: string): Promise<any> {
		if (this.unreachable.has(peerId.toString())) {
			throw new Error(`loopback: ${peerId.toString()} is unreachable`);
		}
		const target = this.services.get(peerId.toString());
		if (!target) throw new Error(`loopback: no service registered for ${peerId.toString()}`);
		this.dialed.push(peerId.toString());
		return createLoopbackStream(async (request) =>
			request.type === 'push'
				? await (target as any).handlePush(request)
				: await (target as any).handlePull(request));
	}
}

// --- Tests ---

describe('cohort growth replicates the founder block and makes it readable', function () {
	this.timeout(10_000);

	const build = async () => {
		// Three real storage stacks. A holds the founder block; B and C hold nothing.
		// One raw storage per node, shared across createBlockStorage calls — the factory runs per
		// operation, so a fresh MemoryRawStorage inside it would lose the pend before the commit.
		const aStorage = new MemoryRawStorage();
		const bStorage = new MemoryRawStorage();
		const cStorage = new MemoryRawStorage();
		const aRepo = new StorageRepo(id => new BlockStorage(id, aStorage));
		const bRepo = new StorageRepo(id => new BlockStorage(id, bStorage));
		const cRepo = new StorageRepo(id => new BlockStorage(id, cStorage));
		await writeRevision(aRepo, 'action-1' as ActionId, 1, 'v1');

		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const peerC = await makePeerId();

		// B and C run the REAL receiving service over their real repos.
		const registrarStub = { handle: async () => {}, unhandle: async () => {} };
		const bService = new BlockTransferService({ registrar: registrarStub, repo: bRepo });
		const cService = new BlockTransferService({ registrar: registrarStub, repo: cRepo });

		const network = new LoopbackPeerNetwork();
		network.register(peerB, bService);
		network.register(peerC, cService);

		// A's monitor + coordinator — the sending side under test.
		const mockLibp2p = new MockLibp2p();
		mockLibp2p.peerId = peerA;
		const mockFret = new MockFret();
		const partitionDetector = new PartitionDetector();
		const deps: RebalanceMonitorDeps = {
			libp2p: mockLibp2p as any,
			fret: mockFret as unknown as FretService,
			partitionDetector,
			fretAdapter: new ArachnodeFretAdapter(mockFret as unknown as FretService)
		};
		const monitor = new RebalanceMonitor(deps, { minRebalanceIntervalMs: 0 });
		const restorationStub = { restore: async () => undefined } as unknown as RestorationCoordinator;
		const coordinator = new BlockTransferCoordinator(
			aRepo, network, restorationStub, partitionDetector, '', { maxRetries: 0 });

		// B's reader — the same three-peer CoordinatorRepo + createReconcileBlock harness the
		// single-holder spec pins the deadlock with, except C answers from its REAL repo (so after
		// the push, C's answer becomes a second claim instead of "I hold nothing").
		const cluster = makeClusterPeers([peerA, peerB, peerC]);
		const localLatest = async (repo: IRepo, blockId: BlockId, context: unknown): Promise<ActionRev | undefined> => {
			const local = await repo.get({ blockIds: [blockId], context } as never, { skipClusterFetch: true } as never);
			return local[blockId]?.state?.latest;
		};
		const clusterLatestCallback: ClusterLatestCallback = async (peerId, blockId, context) => {
			if (peerId.equals(peerB)) return await localLatest(bRepo, blockId, context);
			if (peerId.equals(peerC)) return await localLatest(cRepo, blockId, context);
			if (peerId.equals(peerA)) return latestFromArchive(await serveArchive(aRepo, blockId));
			return undefined;
		};
		const acquireBlockFromCohort = createReconcileBlock({
			selfPeerId: peerB.toString(),
			fetchArchive: async (peerIdStr, blockId) => {
				if (peerIdStr === peerA.toString()) return await serveArchive(aRepo, blockId);
				if (peerIdStr === peerC.toString()) return await serveArchive(cRepo, blockId);
				return undefined;
			},
			saveReplicatedBlock: (blockId, block, source) => bRepo.saveReplicatedBlock(blockId, block, source),
			simpleMajorityThreshold: 0.51,
			repairCorroborationClusterSize: 3
		});
		const bCoordinator = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			bRepo,
			{ clusterSize: 3, readRepairMode: 'paranoid' },
			undefined,
			peerB,
			undefined,
			clusterLatestCallback,
			undefined,
			undefined,
			acquireBlockFromCohort
		);

		return { aRepo, bRepo, cRepo, peerA, peerB, peerC, mockFret, monitor, coordinator, network, bCoordinator };
	};

	it('pins the starting point: before growth, the reader cannot acquire the singly-held block', async () => {
		const { bRepo, bCoordinator } = await build();

		const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
		expect(served[BLOCK_ID]?.state?.latest, 'one holder, floor two — the read declines').to.equal(undefined);
		expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest, 'B acquired nothing').to.equal(undefined);
	});

	it('grows the cohort, pushes over the real wire path, and the reader then serves the content', async () => {
		const { bRepo, cRepo, peerA, peerB, peerC, mockFret, monitor, coordinator, network, bCoordinator } = await build();

		// Founder era: A is the sole cohort member for its block.
		mockFret.setCohort([peerA.toString()]);
		monitor.trackBlock(BLOCK_ID);
		const baseline = await monitor.checkNow();
		expect(baseline?.gained, 'baseline: A observes it is responsible').to.deep.equal([BLOCK_ID]);
		expect(baseline?.grown.size, 'no co-responsible peers yet — nothing grown').to.equal(0);

		// B fails to read while the block has one copy (same decline the single-holder spec pins).
		const before = await bCoordinator.get({ blockIds: [BLOCK_ID] });
		expect(before[BLOCK_ID]?.state?.latest, 'pre-growth read declines').to.equal(undefined);

		// B and C join and become co-responsible. A KEEPS the block: nothing gained, nothing lost —
		// only the new grown arm reports anything at all.
		mockFret.setCohort([peerA.toString(), peerB.toString(), peerC.toString()]);
		const event = await monitor.checkNow();
		expect(event, 'growth alone produces an event').to.not.be.null;
		expect(event!.gained).to.deep.equal([]);
		expect(event!.lost).to.deep.equal([]);
		expect(event!.grown.get(BLOCK_ID), 'both joiners newly co-responsible').to.have.members(
			[peerB.toString(), peerC.toString()]);

		// The reaction pushes through the real BlockTransferClient frames into the real services.
		const result = await coordinator.handleRebalanceEvent(event!);
		expect(result.replicated, 'the grown block confirmed on the floor of new peers').to.deep.equal([BLOCK_ID]);
		expect(result.released, 'nothing released — A keeps the block').to.deep.equal([]);
		expect(network.dialed, 'both joiners were dialed').to.have.members([peerB.toString(), peerC.toString()]);

		// The node-base handler feeds the reaction's outcomes back — that is what records the peers
		// as seen (the monitor no longer records anything at report time).
		for (const [blockId, outcome] of result.growth) monitor.recordGrowthOutcome(blockId, outcome);

		// B and C now hold durable replicas at the SOURCE's (rev, actionId) — the blockMeta ride-along
		// is what makes these replicas able to corroborate A's claim in the quorum vote.
		expect((await bRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest).to.deep.equal(
			{ rev: 1, actionId: 'action-1' });
		expect((await cRepo.get({ blockIds: [BLOCK_ID] }))[BLOCK_ID]?.state?.latest).to.deep.equal(
			{ rev: 1, actionId: 'action-1' });

		// And the read that was permanently declined now serves the founder's content: A and C are two
		// distinct claimants for (rev 1, action-1), meeting the untouched corroboration floor.
		const served = await bCoordinator.get({ blockIds: [BLOCK_ID] });
		expect(payloadOf(served[BLOCK_ID]?.block), 'the reader serves the founder block').to.equal('v1');
		expect(served[BLOCK_ID]?.state?.latest?.rev).to.equal(1);

		// Repeating the check re-emits nothing — the growth was recorded, no re-push loop.
		expect(await monitor.checkNow(), 'stable cohort → no event').to.equal(null);
	});
});
