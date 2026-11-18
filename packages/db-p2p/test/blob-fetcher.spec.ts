/**
 * The blob fetcher's two contracts that need real peers (docs/blobs.md §Moving pieces between
 * machines): a peer that serves wrong bytes is penalized once and another holder supplies the piece,
 * and an interrupted fetch keeps what it stored and asks only for the rest. Three real nodes over
 * loopback TCP; the fetcher under test is built over node B's own parts rather than taken from the
 * node, so it can record every penalty and every stored piece.
 */
import { randomBytes } from 'node:crypto';
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { BlobUnavailableError, readBlob, rootPieceId, walkBlobPieces, type BlobRef, type PieceId } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import { localPieceSource } from '../src/blob/local-piece-source.js';
import { BlobProtocolClient } from '../src/blob/blob-protocol-client.js';
import { buildBlobProtocol } from '../src/blob/blob-protocol.js';
import { BlobFetcher, type PieceStoredEvent } from '../src/blob/blob-fetcher.js';
import { PenaltyReason } from '../src/reputation/types.js';
import { concat, localTcpAddr, streamOf, until } from './support/blob-mesh.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'blob-fetcher';
const PREFIX = `/optimystic/${NETWORK}`;
const PIECE = 262_144;

/** A memory piece store whose `get` can be counted, altered or held, as the server reads through it. */
class ServingPieceStore implements IPieceStore {
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

interface Mesh {
	a: OptimysticNode;
	b: OptimysticNode;
	c: OptimysticNode;
}

/** The data pieces of `ref`'s tree, in order. */
async function dataPiecesOf(ref: BlobRef, pieces: IPieceStore): Promise<PieceId[]> {
	const ids: PieceId[] = [];
	for await (const entry of walkBlobPieces(ref, localPieceSource(pieces))) {
		if (entry.kind === 'data') ids.push(entry.id);
	}
	return ids;
}

describe('blob fetcher', function () {
	// Three real libp2p boots dominate.
	this.timeout(60_000);

	let mesh: Mesh | undefined;

	async function startMesh(stores: { a: IPieceStore; b: IPieceStore; c: IPieceStore }, extra: Record<string, unknown> = {}): Promise<Mesh> {
		const spawn = (pieceStorage: IPieceStore): Promise<OptimysticNode> => createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 3,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			pieceStorage,
			...extra
		});
		const started = { a: await spawn(stores.a), b: await spawn(stores.b), c: await spawn(stores.c) };
		mesh = started;
		await started.b.dial(multiaddr(localTcpAddr(started.a)));
		await started.b.dial(multiaddr(localTcpAddr(started.c)));
		await started.a.dial(multiaddr(localTcpAddr(started.c)));
		const others = [started.a.peerId.toString(), started.c.peerId.toString()];
		await until(async () => (await started.b.keyNetwork.peersServing(buildBlobProtocol(PREFIX), others)).length === 2,
			'B knows A and C serve the blob protocol');
		return started;
	}

	afterEach(async () => {
		const toStop = mesh === undefined ? [] : [mesh.a, mesh.b, mesh.c];
		mesh = undefined;
		await Promise.allSettled(toStop.map(node => node.stop()));
	});

	/** A fetcher over B's parts, recording every penalty and every stored piece. */
	function fetcherOnB(b: OptimysticNode): { fetcher: BlobFetcher; penalties: Array<{ peer: string; reason: PenaltyReason }>; stored: PieceStoredEvent[] } {
		const penalties: Array<{ peer: string; reason: PenaltyReason }> = [];
		const fetcher = new BlobFetcher({
			client: new BlobProtocolClient({ peerNetwork: b.keyNetwork, protocolPrefix: PREFIX, deadlines: b.linkDeadlines }),
			holders: {
				selfPeerId: b.peerId.toString(),
				blobProtocol: buildBlobProtocol(PREFIX),
				keyNetwork: b.keyNetwork,
				membership: undefined,
				reputation: b.reputation,
				isConnected: id => b.getConnections(peerIdFromString(id)).length > 0,
			},
			reputation: {
				reportPeer: (peer, reason, context) => {
					penalties.push({ peer, reason });
					b.reputation.reportPeer(peer, reason, context);
				},
			},
			store: b.blobs.local.fetchStore(),
		});
		const stored: PieceStoredEvent[] = [];
		fetcher.onPieceStored(event => stored.push(event));
		return { fetcher, penalties, stored };
	}

	it('takes a piece from another holder when one serves wrong bytes, and penalizes it once', async () => {
		const aPieces = new ServingPieceStore();
		const bPieces = new MemoryPieceStore();
		const { a, b, c } = await startMesh({ a: aPieces, b: bPieces, c: new MemoryPieceStore() });
		const content = randomBytes(2 * PIECE + 1000);
		const { ref } = await a.blobs.put(streamOf(content));
		await c.blobs.put(streamOf(content));
		// The second of three data pieces, so a good piece precedes the bad one in A's batch.
		const flipped = (await dataPiecesOf(ref, aPieces.inner))[1]!;
		aPieces.serve = async (id, stored) => {
			if (id !== flipped || stored === undefined) return stored;
			stored[0] = stored[0]! ^ 0xff;
			return stored;
		};

		const { fetcher, penalties } = fetcherOnB(b);
		try {
			await fetcher.start(ref, { priority: 'foreground', knownHolders: [a.peerId.toString(), c.peerId.toString()] }).done;
		} finally {
			await fetcher.stop();
		}

		// Read back over a source that is not marked verified, so every piece is hashed.
		const readBack = await concat(readBlob(ref, { get: id => bPieces.get(id) }));
		expect(Buffer.compare(readBack, content)).to.equal(0);
		expect(penalties).to.deep.equal([{ peer: a.peerId.toString(), reason: PenaltyReason.InvalidRestoration }]);
	});

	it('requests each piece once when two sessions fetch one blob at once', async () => {
		const aPieces = new ServingPieceStore();
		const cPieces = new ServingPieceStore();
		const bPieces = new MemoryPieceStore();
		const { a, b, c } = await startMesh({ a: aPieces, b: bPieces, c: cPieces });
		const content = randomBytes(3 * PIECE + 1000);
		const { ref } = await a.blobs.put(streamOf(content));
		await c.blobs.put(streamOf(content));
		const data = await dataPiecesOf(ref, aPieces.inner);
		const [aId, cId] = [a.peerId.toString(), c.peerId.toString()];

		const { fetcher, stored } = fetcherOnB(b);
		try {
			// Each session asks a different holder first, so both reach the batch choice at once.
			await Promise.all([
				fetcher.start(ref, { priority: 'foreground', knownHolders: [aId, cId] }).done,
				fetcher.start(ref, { priority: 'background', knownHolders: [cId, aId] }).done,
			]);
		} finally {
			await fetcher.stop();
		}

		// The list piece is left out of the serving counts: each holder's start-up sweep reads it too.
		expect(data.map(id => (aPieces.gets.get(id) ?? 0) + (cPieces.gets.get(id) ?? 0))).to.deep.equal(data.map(() => 1));
		expect(stored.map(event => event.id).sort()).to.deep.equal([rootPieceId(ref), ...data].sort());
		const readBack = await concat(readBlob(ref, { get: id => bPieces.get(id) }));
		expect(Buffer.compare(readBack, content)).to.equal(0);
	});

	it('keeps what an interrupted fetch stored and asks only for the rest', async () => {
		const aPieces = new ServingPieceStore();
		const bPieces = new MemoryPieceStore();
		// A 500 ms progress deadline, so the stalled piece ends the first fetch quickly.
		const { a, b } = await startMesh({ a: aPieces, b: bPieces, c: new MemoryPieceStore() }, { rpcDeadlines: { responseTimeoutMs: 500 } });
		const content = randomBytes(8 * PIECE);
		const { ref } = await a.blobs.put(streamOf(content));
		const data = await dataPiecesOf(ref, aPieces.inner);
		expect(data).to.have.length(8);
		const [, , , , stalled] = data;
		let release!: () => void;
		const released = new Promise<void>(resolve => { release = resolve; });
		aPieces.serve = async (id, stored) => {
			if (id === stalled) await released;
			return stored;
		};
		const { fetcher, stored } = fetcherOnB(b);
		const request = { priority: 'foreground' as const, knownHolders: [a.peerId.toString()] };

		try {
			let firstFailure: unknown;
			try {
				await fetcher.start(ref, request).done;
			} catch (error) {
				firstFailure = error;
			}
			expect(firstFailure).to.be.instanceOf(BlobUnavailableError);
			const firstSession = stored.splice(0).map(event => event.id);
			const held = await Promise.all(data.map(id => bPieces.has(id)));
			expect(held).to.deep.equal([true, true, true, true, false, false, false, false]);
			expect(await bPieces.has(firstSession[0]!), 'the list piece was kept').to.equal(true);
			expect(firstSession.slice(1)).to.deep.equal(data.slice(0, 4));

			release();
			await fetcher.start(ref, request).done;
			expect(stored.map(event => event.id), 'the second fetch asked only for what was missing').to.deep.equal(data.slice(4));
		} finally {
			release();
			await fetcher.stop();
		}

		// The list piece is left out: A's own start-up sweep reads it too.
		expect(data.map(id => aPieces.gets.get(id))).to.deep.equal([1, 1, 1, 1, 2, 1, 1, 1]);
		const readBack = await concat(readBlob(ref, { get: id => bPieces.get(id) }));
		expect(Buffer.compare(readBack, content)).to.equal(0);
	});
});
