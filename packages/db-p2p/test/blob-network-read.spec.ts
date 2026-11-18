/**
 * `node.blobs` over the network (docs/blobs.md §The node's blob service): a read on one machine
 * brings the pieces another machine holds, reporting progress as they arrive, a `stat` probe finds
 * the holder, and `waitMs` keeps a read alive until a holder appears. Two real nodes over loopback TCP.
 */
import { expect } from 'chai';
import { multiaddr } from '@multiformats/multiaddr';
import { BlobUnavailableError, buildBlob, routingKeyForBlob, type BlobProgressEvent, type BlobRef } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { buildBlobProtocol } from '../src/blob/blob-protocol.js';
import { concat, localTcpAddr, streamOf, until } from './support/blob-mesh.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'blob-network-read';
const PREFIX = `/optimystic/${NETWORK}`;
/** Three 256 KiB data pieces (the last one short) under one list piece. */
const SIZE = 600 * 1024;

/** Bytes from a seeded xorshift, so no two of the blob's data pieces are equal and share one piece id. */
function deterministicBytes(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		bytes[i] = state & 0xff;
	}
	return bytes;
}

/** The reference `content` gets, without storing it anywhere. */
async function referenceOf(content: Uint8Array): Promise<BlobRef> {
	return (await buildBlob(streamOf(content), { put: async () => undefined })).ref;
}

describe('node blob service over the network', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	let nodes: OptimysticNode[] = [];

	afterEach(async () => {
		const toStop = nodes;
		nodes = [];
		await Promise.allSettled(toStop.map(node => node.stop()));
	});

	async function startPair(aPieces: MemoryPieceStore): Promise<{ a: OptimysticNode; b: OptimysticNode }> {
		const spawn = (pieceStorage: MemoryPieceStore): Promise<OptimysticNode> => createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 2,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			pieceStorage,
		});
		const a = await spawn(aPieces);
		nodes.push(a);
		const b = await spawn(new MemoryPieceStore());
		nodes.push(b);
		await b.dial(multiaddr(localTcpAddr(a)));
		const protocol = buildBlobProtocol(PREFIX);
		await until(async () => (await b.keyNetwork.peersServing(protocol, [a.peerId.toString()])).length === 1, 'B knows A serves the blob protocol');
		await until(async () => (await a.keyNetwork.peersServing(protocol, [b.peerId.toString()])).length === 1, 'A knows B serves the blob protocol');
		return { a, b };
	}

	async function untilCohortIncludes(b: OptimysticNode, a: OptimysticNode, ref: BlobRef): Promise<void> {
		await until(async () => Object.keys(await b.keyNetwork.findCluster(routingKeyForBlob(ref))).includes(a.peerId.toString()),
			"A is in B's view of the blob's cohort");
	}

	it('reads a blob held by another machine, finding it by probe and reporting progress', async () => {
		const aPieces = new MemoryPieceStore();
		const { a, b } = await startPair(aPieces);
		const content = deterministicBytes(SIZE, 1);
		const { ref } = await a.blobs.put(streamOf(content));
		await untilCohortIncludes(b, a, ref);
		let pieceBytes = 0;
		for await (const id of aPieces.list()) pieceBytes += (await aPieces.get(id))!.byteLength;

		expect((await b.blobs.stat(ref)).locality).to.equal('unknown');
		expect((await b.blobs.stat(ref, { probe: true })).locality).to.equal('elsewhere');

		const events: BlobProgressEvent[] = [];
		const unsubscribe = b.blobs.onProgress(event => events.push(event));
		const read = await concat(b.blobs.read(ref));
		expect(Buffer.compare(read, content)).to.equal(0);
		// Progress is counted a microtask behind the store, so the last event may follow the read's end.
		await until(async () => events.length === 4, 'four progress events');
		unsubscribe();
		const last = events[events.length - 1]!;
		expect(last).to.deep.equal({ ref, piecesFetched: 4, bytesFetched: pieceBytes, size: SIZE });
		expect((await b.blobs.stat(ref)).locality).to.equal('here');
	});

	it('keeps a read with waitMs alive until a holder has the blob', async () => {
		const aPieces = new MemoryPieceStore();
		const { a, b } = await startPair(aPieces);
		const content = deterministicBytes(SIZE, 2);
		const ref = await referenceOf(content);
		await untilCohortIncludes(b, a, ref);

		let failure: unknown;
		try {
			await concat(b.blobs.read(ref));
		} catch (error) {
			failure = error;
		}
		expect(failure).to.be.instanceOf(BlobUnavailableError);
		expect((failure as BlobUnavailableError).reason).to.equal('not-held');

		const reading = concat(b.blobs.read(ref, { waitMs: 10_000 }));
		await new Promise(resolve => setTimeout(resolve, 300));
		await a.blobs.put(streamOf(content));
		expect(Buffer.compare(await reading, content)).to.equal(0);
	});
});
