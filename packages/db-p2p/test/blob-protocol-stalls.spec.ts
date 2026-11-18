/**
 * The blob protocol gives up on a transfer when it stops moving, from either end (docs/blobs.md
 * §Moving pieces between machines): a responder whose header promises a piece it never sends, and a
 * requester that stops reading. Two real nodes over loopback TCP, with a 500 ms response deadline, so
 * each stall is detected within one deadline rather than hanging.
 */
import { expect } from 'chai';
import type { Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import * as lp from 'it-length-prefixed';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { pieceIdOfCid, RAW_CODEC, type PieceId } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { BlobProtocolClient } from '../src/blob/blob-protocol-client.js';
import { readBlobFrames, sendBlobFrame } from '../src/blob/blob-frames.js';
import { BlobTransferStalledError, buildBlobProtocol, encodeBlobHeader } from '../src/blob/blob-protocol.js';
import { MAX_BLOB_HEADER_BYTES } from '../src/protocol-limits.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'blob-protocol-stalls';
const PREFIX = `/optimystic/${NETWORK}`;
const RESPONSE_TIMEOUT_MS = 500;
/** Several deadlines, so a stall that is detected passes and one that is not fails well before mocha's timeout. */
const DETECTED_WITHIN_MS = 3_000;
const ONE_MIB = 1024 * 1024;

async function rawPieceOf(bytes: Uint8Array): Promise<PieceId> {
	return pieceIdOfCid(CID.create(1, RAW_CODEC, await sha256.digest(bytes)));
}

function localTcpAddr(node: OptimysticNode): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No loopback TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

/** A deadline for a hand-written responder: it never fires, since the spec is about the other end's. */
const NEVER_STALLS = { touch: (): void => { }, signal: new AbortController().signal };

describe('blob protocol stalls', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	let a: OptimysticNode | undefined;
	let b: OptimysticNode | undefined;
	let aPieces: MemoryPieceStore;

	async function spawn(extra: Record<string, unknown> = {}): Promise<OptimysticNode> {
		return await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			rpcDeadlines: { responseTimeoutMs: RESPONSE_TIMEOUT_MS },
			...extra
		});
	}

	beforeEach(async () => {
		aPieces = new MemoryPieceStore();
		a = await spawn({ pieceStorage: aPieces });
		b = await spawn();
		await b.dial(multiaddr(localTcpAddr(a)));
	});

	afterEach(async () => {
		const toStop = [a, b].filter((n): n is OptimysticNode => !!n);
		a = undefined; b = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a header that promises a piece it never sends fails the read within one deadline', async () => {
		const piece = await rawPieceOf(Uint8Array.of(1, 2, 3));
		// Replaces A's real service: reads the request, answers that it holds the piece, then sends nothing and never closes.
		await registerProtocolHandler(a!, buildBlobProtocol(PREFIX), async (stream: Stream) => {
			const frames = readBlobFrames(stream, NEVER_STALLS, 'requester');
			await frames.next();
			await sendBlobFrame(stream, encodeBlobHeader({ kind: 'get', held: [true] }), NEVER_STALLS, MAX_BLOB_HEADER_BYTES);
		}, { force: true });

		const client = new BlobProtocolClient({ peerNetwork: b!.keyNetwork, protocolPrefix: PREFIX, deadlines: b!.linkDeadlines });
		const reply = await client.get(a!.peerId, [piece]);
		expect(reply.held).to.deep.equal([piece]);

		const startedAt = Date.now();
		let failure: unknown;
		try {
			for await (const _received of reply.pieces) {
				expect.fail('the responder sent no piece');
			}
		} catch (err) {
			failure = err;
		}
		expect(failure).to.be.instanceOf(BlobTransferStalledError);
		expect(Date.now() - startedAt).to.be.below(DETECTED_WITHIN_MS);
	});

	it('a responder whose requester stops reading gives up within one deadline instead of buffering', async () => {
		// Three pieces, so the answer is larger than any window the requester granted before it paused:
		// yamux doubles a stream's receive window when data arrives within a few round trips, which the
		// protocol negotiation can do on loopback. Still under the requester's own 4 MiB read-buffer cap,
		// past which it would reset the stream itself.
		const pieces = [1, 2, 3].map(fill => new Uint8Array(ONE_MIB).fill(fill));
		const ids: PieceId[] = [];
		for (const bytes of pieces) {
			const id = await rawPieceOf(bytes);
			// Straight into the store under its real id: the server only calls `has` and `get`.
			await aPieces.put(id, bytes);
			ids.push(id);
		}

		const stream = await b!.keyNetwork.connect(a!.peerId, buildBlobProtocol(PREFIX)) as unknown as Stream;
		const ended = new Promise<{ error?: Error; local: boolean }>(resolve => {
			stream.addEventListener('close', (event) => resolve(event as unknown as { error?: Error; local: boolean }), { once: true });
		});
		// Paused before anything arrives, so no window update ever lets more than yamux's first window through.
		stream.pause();
		const startedAt = Date.now();
		stream.send(lp.encode.single(encodeBlobHeader({ kind: 'get', pieces: ids })));
		await stream.close();

		const outcome = await Promise.race([
			ended,
			new Promise<'still open'>(resolve => setTimeout(() => resolve('still open'), DETECTED_WITHIN_MS)),
		]);
		expect(outcome, 'the responder reset the stream').to.not.equal('still open');
		const { error, local } = outcome as { error?: Error; local: boolean };
		expect(local, 'the reset came from the responder').to.equal(false);
		expect(error, 'the stream ended with an error').to.be.instanceOf(Error);
		expect(Date.now() - startedAt).to.be.below(DETECTED_WITHIN_MS);
	});
});
