/**
 * Ticket: received-replicas-report-their-source-as-a-holder.
 *
 * A block that arrives as a pushed replica is persisted by `StorageRepo.saveReplicatedBlock`, which
 * emits a collection change — so it enters the receiver's owned-block set exactly as a committed
 * block does, and the rebalance monitor treats a block it has no memory of as brand new. Before this
 * ticket the next check reported the whole non-self cohort `grown` (the reaction pushes the block to
 * each of them, INCLUDING the peer that just sent it) and reported the block `gained` (the reaction
 * fetches it again over `/sync`): two useless transfers per replica received.
 *
 * `BlockTransferService.handlePush` therefore reports the sending peer as a holder of every block it
 * ACCEPTS, through the same `BlockHoldersSink` the two commit sites already feed.
 *
 * The push runs through the REGISTERED stream handler, driven by a real `BlockTransferClient` over a
 * linked in-memory duplex pair, with a connection carrying the sender's peer id — the one place that
 * identity is available. Calling the private `handlePush` directly would hand the id over by fiat and
 * prove nothing about the threading.
 */

import { expect } from 'chai';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import type { PeerId } from '@libp2p/interface';
import { canonicalBlockHash } from '@optimystic/db-core';
import type {
	ActionId, BlockHeader, BlockId, CommitRequest, IBlock, IPeerNetwork, RoutingKey
} from '@optimystic/db-core';
import type { FretService } from 'p2p-fret';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import {
	BlockTransferClient, BlockTransferService,
	type BlockTransferResponse, type PushCertification
} from '../src/cluster/block-transfer-service.js';
import { RebalanceMonitor, type BlockHolders, type RebalanceEvent } from '../src/cluster/rebalance-monitor.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { ArachnodeFretAdapter } from '../src/storage/arachnode-fret-adapter.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { makeKeyPair, makeSignedProof, PROOF_THRESHOLDS } from './support/commit-proof-fixtures.js';
import { makeLinkedPair } from './support/linked-duplex-pair.js';

const SUPER_MAJORITY = PROOF_THRESHOLDS.superMajorityThreshold;

const makeBlock = (id: string): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
});

type Meta = { rev: number; actionId: ActionId };

/** The cohort commit proof an honest pusher would have retained for exactly these bytes. */
const certify = async (blockId: string, block: IBlock, meta: Meta): Promise<BlockCommitProof> => {
	const commit: CommitRequest = {
		actionId: meta.actionId,
		blockIds: [blockId as BlockId],
		tailId: blockId as BlockId,
		rev: meta.rev,
		blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
	};
	const { proof } = await makeSignedProof(4, commit);
	return proof;
};

/** What an honest, upgraded sender attaches for one block: meta and proof built for one revision. */
const certificationFor = async (blockId: string, block: IBlock, meta: Meta): Promise<PushCertification> => ({
	blockMeta: { [blockId]: meta },
	blockProofs: { [blockId]: await certify(blockId, block, meta) }
});

const wireBytes = (block: IBlock): Uint8Array => u8FromString(JSON.stringify(block), 'utf8');

/** Just enough libp2p for the monitor: its peer id and the connection listeners it registers. */
const monitorLibp2p = (peerId: PeerId) => ({
	peerId,
	addEventListener: () => {},
	removeEventListener: () => {}
});

/** FRET stand-in: the cohort comes from the injected key network, so only the adapter needs a target. */
const idleFret = {} as unknown as FretService;

interface Rig {
	monitor: RebalanceMonitor;
	/** Every report the service made to the holder sink, in order. */
	reports: BlockHolders[];
	/** Push blocks to this node over the wire, as `sender`. */
	pushAs: (
		sender: PeerId, blockIds: string[], blocks: IBlock[], certification: PushCertification
	) => Promise<BlockTransferResponse>;
	stop: () => Promise<void>;
}

/**
 * A receiving node: its storage, a started `BlockTransferService` whose holder reports feed a started
 * `RebalanceMonitor`, and the monitor's owned-block set fed from the storage change feed — the
 * `libp2p-node-base` wiring, minus libp2p.
 */
const buildRig = async (self: PeerId, cohort: PeerId[]): Promise<Rig> => {
	const rawStorage = new MemoryRawStorage();
	const repo = new StorageRepo((blockId: BlockId) => new BlockStorage(blockId, rawStorage));
	const reports: BlockHolders[] = [];

	const owned = new Set<string>();
	repo.onAnyCollectionChange(e => { for (const blockId of e.blockIds) owned.add(blockId); });

	const monitor = new RebalanceMonitor({
		libp2p: monitorLibp2p(self) as never,
		fret: idleFret,
		partitionDetector: new PartitionDetector(),
		fretAdapter: new ArachnodeFretAdapter(idleFret),
		trackedBlocks: owned,
		// Every block routes to one fixed cohort: this node plus the pushing peer(s).
		keyNetwork: {
			findCluster: async (_key: RoutingKey) =>
				Object.fromEntries(cohort.map(p => [p.toString(), {}])) as never
		},
		clusterSize: cohort.length
	}, { minRebalanceIntervalMs: 0, growthRecheckIntervalMs: 0 });
	await monitor.start();

	let handler: ((stream: any, connection?: any) => void | Promise<void>) | undefined;
	const service = new BlockTransferService({
		registrar: {
			handle: async (_proto: string, h: any) => { handler = h; },
			unhandle: async () => { handler = undefined; }
		},
		repo,
		superMajorityThreshold: SUPER_MAJORITY,
		onBlockHolders: (holders: BlockHolders) => {
			reports.push(holders);
			monitor.recordBlockHolders(holders);
		}
	});
	await service.start();

	/** Dials "into" this node: each connect runs the registered handler against a fresh stream pair. */
	const peerNetworkFor = (sender: PeerId): IPeerNetwork => ({
		async connect() {
			const { clientStream, serverStream } = makeLinkedPair();
			// Not awaited — mirrors how libp2p invokes a stream handler, with the connection alongside.
			void Promise.resolve()
				.then(() => handler?.(serverStream, { remotePeer: sender }))
				.catch(() => { /* isolated; a handler fault surfaces as a client-side timeout */ });
			return clientStream;
		}
	} as unknown as IPeerNetwork);

	return {
		monitor,
		reports,
		pushAs: (sender, blockIds, blocks, certification) =>
			new BlockTransferClient(self, peerNetworkFor(sender))
				.pushBlocks(blockIds, blocks.map(wireBytes), 'replication', certification),
		stop: async () => { await service.stop(); await monitor.stop(); }
	};
};

/** The transfers a check's reaction would start: a pull per gained block, a push per grown (block, peer). */
const transfersOf = (event: RebalanceEvent | null): { pulls: string[]; pushes: string[] } => ({
	pulls: event?.gained ?? [],
	pushes: [...(event?.grown ?? new Map<string, string[]>())]
		.flatMap(([blockId, peers]) => peers.map(peer => `${blockId}->${peer}`))
});

describe('rebalance after a received replica (the push reports its sender as a holder)', () => {

	it('does not push a received replica back to its sender, nor pull it again', async () => {
		const [self, sender] = await Promise.all([makeKeyPair(), makeKeyPair()]);
		const rig = await buildRig(self.peerId, [self.peerId, sender.peerId]);
		const blockId = 'block-pushed';
		const block = makeBlock(blockId);
		const meta: Meta = { rev: 4, actionId: 'a4' as ActionId };

		const response = await rig.pushAs(
			sender.peerId, [blockId], [block], await certificationFor(blockId, block, meta));
		expect(response.missing, 'precondition: the push was accepted').to.deep.equal([]);

		expect(rig.reports, 'the sender is reported as a holder of the accepted block').to.deep.equal([
			{ blockIds: [blockId], holders: [sender.peerId.toString()] }
		]);

		expect(transfersOf(await rig.monitor.checkNow()), 'no pull, and no push back to the sender')
			.to.deep.equal({ pulls: [], pushes: [] });
		expect(transfersOf(await rig.monitor.checkNow()), 'a later check stays quiet too')
			.to.deep.equal({ pulls: [], pushes: [] });

		await rig.stop();
	});

	it('reports only the blocks the push accepted', async () => {
		// A block that fails certification is not one this node holds, so naming it would suppress a
		// `gained` report the node genuinely owes. The sink must see the accepted block alone.
		const [self, sender] = await Promise.all([makeKeyPair(), makeKeyPair()]);
		const rig = await buildRig(self.peerId, [self.peerId, sender.peerId]);
		const accepted = 'block-accepted';
		const refused = 'block-refused';
		const acceptedBlock = makeBlock(accepted);
		const refusedBlock = makeBlock(refused);
		const acceptedMeta: Meta = { rev: 2, actionId: 'a2' as ActionId };

		const response = await rig.pushAs(sender.peerId, [accepted, refused], [acceptedBlock, refusedBlock], {
			blockMeta: {
				[accepted]: acceptedMeta,
				[refused]: { rev: 2, actionId: 'b2' as ActionId }
			},
			// An uncertified rider: refused under the strict default.
			blockProofs: { [accepted]: await certify(accepted, acceptedBlock, acceptedMeta) }
		});

		expect(response.missing).to.deep.equal([refused]);
		expect(rig.reports).to.deep.equal([
			{ blockIds: [accepted], holders: [sender.peerId.toString()] }
		]);

		await rig.stop();
	});
});
