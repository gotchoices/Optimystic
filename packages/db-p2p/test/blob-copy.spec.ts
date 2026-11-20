/**
 * Ticket: feat-blob-owed-copies-are-drained.
 *
 * `announce` over two real machines (docs/blobs.md §Placement, copying and durability, *Copying*):
 * the writer owes the blob to its cohort and keeps announcing it until the other member holds it,
 * reporting `full` once it does — including across the writer's own restart, since the owed entry and
 * the `owed` hold are on its durable store.
 *
 * The drain's own rules over doubles are `blob-copy-drain.spec.ts`; the receiver's answers are
 * `blob-announce-receiver.spec.ts` and `blob-announce.spec.ts`; piece-level resumption is
 * `blob-fetcher.spec.ts`. What is left to these specs is the round trip: an answer the drain must act
 * on and ask again after (`unreferenced`), and durable state that must outlive a process.
 */
import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import {
	BlobReferenceTree, BlobScopeRegistry, routingKeyForBlob, walkBlobPieces,
	type BlobDurabilityEvent, type BlobRef, type BlobScope, type ITransactor, type PieceId
} from '@optimystic/db-core';
import type { BlobCopyDrain } from '../src/blob/blob-copy-drain.js';
import { buildBlobProtocol } from '../src/blob/blob-protocol.js';
import { localPieceSource } from '../src/blob/local-piece-source.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import type { OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { createNodeNetworkTransactor } from '../src/node-network-transactor.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { concat, localTcpAddr, streamOf, until } from './support/blob-mesh.js';
import { captureLog, hasLine } from './support/capture-log.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'blob-copy';
const PREFIX = `/optimystic/${NETWORK}`;
const SCOPE: BlobScope = 'app/photos/blobrefs';
const PIECE = 256 * 1024;

/** Bytes that differ by `seed`, so two blobs in one spec never share a piece id. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

/**
 * The writer's piece store, counting what it served and able to stall one piece — so a restart can be
 * made to land mid-pull, and what the receiver asked for after it can be told from what it asked
 * before. Kept across the restart, as a real node's store is.
 */
class CountingPieceStore implements IPieceStore {
	readonly durability = 'none' as const;
	readonly inner = new MemoryPieceStore();
	readonly gets = new Map<PieceId, number>();
	/** What a `get` returns, given what is stored. */
	serve: (id: PieceId, stored: Uint8Array | undefined) => Promise<Uint8Array | undefined> = async (_id, stored) => stored;

	has(id: PieceId): Promise<boolean> { return this.inner.has(id); }
	async get(id: PieceId): Promise<Uint8Array | undefined> {
		this.gets.set(id, (this.gets.get(id) ?? 0) + 1);
		return this.serve(id, await this.inner.get(id));
	}
	put(id: PieceId, bytes: Uint8Array): Promise<void> { return this.inner.put(id, bytes); }
	delete(id: PieceId): Promise<void> { return this.inner.delete(id); }
	list(): AsyncIterable<PieceId> { return this.inner.list(); }
	bytesUsed(): Promise<number> { return this.inner.bytesUsed(); }
	flush(): Promise<void> { return this.inner.flush(); }
}

/** The data pieces of `ref`'s tree, in order. */
async function dataPiecesOf(ref: BlobRef, pieces: IPieceStore): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	for await (const entry of walkBlobPieces(ref, localPieceSource(pieces))) {
		if (entry.kind === 'data') ids.push(entry.id);
	}
	return ids;
}

describe("a blob's owed copies drained over the network", function () {
	// Real libp2p boots, a real commit through the cohort and a 2 MB transfer dominate; the second
	// spec boots the writer twice.
	this.timeout(180_000);

	let nodes: OptimysticNode[] = [];

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(node => node.stop()));
	});

	/** A serving node in every cohort (`clusterSize: 2`), tracked for teardown. */
	async function spawn(extra: Record<string, unknown> = {}): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 2,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...extra
		});
		nodes.push(node);
		return node;
	}

	/** Connect `from` to `to` and wait until each knows the other serves the blob protocol. */
	async function link(from: OptimysticNode, to: OptimysticNode): Promise<void> {
		await from.dial(multiaddr(localTcpAddr(to)));
		const protocol = buildBlobProtocol(PREFIX);
		await until(async () => (await from.keyNetwork.peersServing(protocol, [to.peerId.toString()])).length === 1,
			'the dialing node knows the other serves the blob protocol');
		await until(async () => (await to.keyNetwork.peersServing(protocol, [from.peerId.toString()])).length === 1,
			'the dialed node knows the other serves the blob protocol');
	}

	/** The transactor a host over `node` would build: the one construction the node reads committed state through. */
	function transactorOver(node: OptimysticNode): ITransactor {
		return createNodeNetworkTransactor({
			peerId: node.peerId,
			keyNetwork: node.keyNetwork,
			coordinatedRepo: node.coordinatedRepo,
			storageRepo: node.storageRepo,
			protocolPrefix: PREFIX,
			linkDeadlines: node.linkDeadlines,
			clock: node.hlcClock,
		});
	}

	// The factory exposes both for tests and diagnostics, as it exposes the block drain and its ledger.
	const drainOf = (node: OptimysticNode): BlobCopyDrain => (node as unknown as { blobCopyDrain: BlobCopyDrain }).blobCopyDrain;
	const ledgerOf = (node: OptimysticNode): OwedBlobLedger => (node as unknown as { owedBlobLedger: OwedBlobLedger }).owedBlobLedger;

	async function untilBothInCohort(node: OptimysticNode, ref: BlobRef): Promise<void> {
		await until(async () => Object.keys(await node.keyNetwork.findCluster(routingKeyForBlob(ref))).length === 2,
			"the blob's cohort holds both nodes");
	}

	/** Commit a reference to `ref` in {@link SCOPE}, which is what makes the other member take it. */
	async function commitReference(net: ITransactor, ref: BlobRef, referrer: string): Promise<void> {
		const references = await BlobReferenceTree.createOrOpen(net, SCOPE);
		await references.stageAdd(ref, referrer);
		await references.tree.sync();
	}

	it('asks again after the receiver cannot find the reference, and reports full once it holds the blob', async () => {
		const a = await spawn();
		const b = await spawn();
		await link(b, a);
		const net = transactorOver(a);
		await BlobScopeRegistry.register(net, SCOPE);
		const { ref } = await a.blobs.put(streamOf(bytesOf(4 * 1024, 1)));
		await untilBothInCohort(a, ref);

		const events: BlobDurabilityEvent[] = [];
		a.blobs.onDurability(event => events.push(event));

		// Announced before anything references it — the order a writer that announces off its commit
		// path can reach, and the order a receiver whose committed-state read is slow sees anyway.
		const beforeCommit = await captureLog('blob:copy', async () => {
			await a.blobs.announce(ref, SCOPE);
			await drainOf(a).checkNow();
		});

		expect(events.map(event => event.durability.quorum), 'announce reports the writer holding it alone').to.deep.equal(['local']);
		expect(hasLine(beforeCommit, 'answer=unreferenced'), 'B will not take a blob nothing committed names').to.equal(true);
		expect(await ledgerOf(a).get(ref), 'so the blob is still owed').to.include({ ref, scope: SCOPE });
		expect(await b.blobs.local.stat(ref), 'and B holds nothing of it').to.include({ locality: 'unknown' });

		await commitReference(net, ref, 'row-1');

		const afterCommit = await captureLog('blob:copy', async () => {
			await drainOf(a).checkNow();
			await until(async () => (await a.blobs.stat(ref)).durability?.quorum === 'full', 'A reports the cohort holding the blob');
		});

		expect(hasLine(afterCommit, 'answer=fetching'), 'the same announcement now starts B pulling').to.equal(true);
		expect(events.map(event => event.durability.quorum), 'one event per class, and no majority step in a cohort of two').to.deep.equal(['local', 'full']);
		expect(await ledgerOf(a).get(ref), 'nothing is owed once the cohort holds it').to.equal(undefined);
		expect(await b.blobs.local.responsibleScope(ref), 'B keeps it under the scope it was announced in').to.equal(SCOPE);
	});

	it('keeps owing the blob across the writer restarting, and finishes the copy from the pieces the receiver lacked', async () => {
		const writerKey: PrivateKey = await generateKeyPair('Ed25519');
		// The three stores a restart keeps: the pieces it serves, the records and owed entries, and the
		// blocks it holds as a cohort member.
		const writerPieces = new CountingPieceStore();
		const writerKv = new MemoryKVStore();
		const writerStorage = new MemoryRawStorage();
		const writerOptions = { privateKey: writerKey, pieceStorage: writerPieces, kvStore: writerKv, storage: writerStorage };
		const receiverPieces = new MemoryPieceStore();

		let a = await spawn(writerOptions);
		const b = await spawn({ pieceStorage: receiverPieces });
		await link(b, a);
		const net = transactorOver(a);
		await BlobScopeRegistry.register(net, SCOPE);
		const content = bytesOf(8 * PIECE, 2);
		const { ref } = await a.blobs.put(streamOf(content));
		const data = await dataPiecesOf(ref, writerPieces.inner);
		expect(data, 'eight data pieces, so a restart can land with half of them across').to.have.length(8);
		await commitReference(net, ref, 'row-2');
		await untilBothInCohort(a, ref);

		// The writer withholds the fifth data piece: it declares the batch held and then resets the
		// stream on reaching the piece that is gone, so B keeps what arrived before it and its pull
		// gives up with the blob part-way across — the state a resumed copy has to finish from.
		let withheld: PieceId | undefined = data[4];
		writerPieces.serve = async (id, stored) => (id === withheld ? undefined : stored);

		await a.blobs.announce(ref, SCOPE);
		await drainOf(a).checkNow();
		await until(async () => receiverPieces.has(data[0]!), 'B has begun storing the blob');

		// The writer goes away mid-copy, taking the blob's only holder with it. Both tallies below are
		// read after it has stopped, so neither can move under the assertions.
		await a.stop();
		nodes = nodes.filter(node => node !== a);
		const servedBeforeRestart = new Map(writerPieces.gets);
		const alreadyHeld = await Promise.all(data.map(id => receiverPieces.has(id)));
		const kept = data.filter((_, index) => alreadyHeld[index]);
		const lacked = data.filter((_, index) => !alreadyHeld[index]);
		expect(kept, 'B holds some of the blob').to.not.be.empty;
		expect(lacked, 'and lacks the rest, the withheld piece among it').to.include(data[4]);

		a = await spawn(writerOptions);
		withheld = undefined;
		await link(a, b);
		await untilBothInCohort(a, ref);

		expect(await ledgerOf(a).get(ref), 'the owed entry outlived the process that recorded it').to.include({ ref, scope: SCOPE });

		await drainOf(a).checkNow();
		await until(async () => (await a.blobs.stat(ref)).durability?.quorum === 'full',
			'the restarted writer reports the cohort holding the blob', 60_000);

		const servedSinceRestart = (id: PieceId): number => (writerPieces.gets.get(id) ?? 0) - (servedBeforeRestart.get(id) ?? 0);
		expect(kept.map(servedSinceRestart), 'the pieces B already had were not served again').to.deep.equal(kept.map(() => 0));
		expect(lacked.filter(id => servedSinceRestart(id) === 0), 'every piece B lacked was served after the restart').to.be.empty;
		expect(await ledgerOf(a).get(ref), 'nothing is owed once the copy completes').to.equal(undefined);
		expect(Buffer.compare(await concat(b.blobs.read(ref, { from: 'here' })), content), 'B holds the blob B was sent').to.equal(0);
	});
});
