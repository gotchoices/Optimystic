import { expect } from 'chai';
import { pipe } from 'it-pipe';
import { encode as lpEncode } from 'it-length-prefixed';
import all from 'it-all';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { ClusterService } from '../src/cluster/service.js';
import { RepoService } from '../src/repo/service.js';
import { DisputeProtocolService } from '../src/dispute/service.js';
import { SyncService } from '../src/sync/service.js';
import { BlockTransferService, type IBlockReplicaStore } from '../src/cluster/block-transfer-service.js';
import { ClusterClient } from '../src/cluster/client.js';
import { SyncClient } from '../src/sync/client.js';
import { MAX_CONTROL_MESSAGE_BYTES, MAX_BLOCK_MESSAGE_BYTES } from '../src/protocol-limits.js';

/**
 * The `it-length-prefixed` library's own default `maxDataLength` (its `MAX_DATA_LENGTH`
 * constant). A block handler that omitted the `maxDataLength` edit would fall back to
 * this, so a frame declaring *above* it but *below* the block cap is the guard that
 * proves the block cap is actually applied — not the library default.
 */
const LIBRARY_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Inbound message caps (p2p-consensus-inbound-message-caps).
 *
 * Two independent protections per server stream handler:
 *  1. Size cap — the length-prefix decoder is given a `maxDataLength`, so a frame
 *     whose *declared* length exceeds the cap is rejected at the prefix (before any
 *     allocation against the declared size). The throw propagates through the pipe
 *     into the handler's catch, which aborts the stream.
 *  2. One request per stream — cluster/repo/dispute generators `return` after the
 *     first response (sync/block-transfer already did), so a second request queued
 *     on the same stream is never read or parsed.
 *
 * The handlers are private; each service registers its handler via `registrar.handle`,
 * so the tests capture that callback at `start()` and drive it with a mock duplex
 * stream (same shape the real libp2p registrar passes).
 */

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** A callable logger with the `.error`/etc. methods the services expect. */
function makeLogger(): any {
	const fn: any = (..._args: any[]) => { };
	fn.error = () => { };
	fn.trace = () => { };
	fn.debug = () => { };
	fn.info = () => { };
	fn.warn = () => { };
	return { forComponent: () => fn };
}

/** A registrar that captures the handler registered by a service's `start()`. */
function capturingRegistrar() {
	let handler: ((...args: any[]) => any) | undefined;
	const registrar = {
		handle: async (_protocol: string, h: (...args: any[]) => any, _opts?: any) => { handler = h; },
		unhandle: async () => { },
	};
	return { registrar, getHandler: () => handler! };
}

/**
 * Mock duplex stream. `[Symbol.asyncIterator]` replays the supplied wire frames
 * (the read side the handler decodes); `send` collects the encoded reply; `close`
 * and `abort` each resolve `finished` so a test can await handler completion.
 */
function makeMockStream(inputFrames: Array<Uint8Array>) {
	const sent: unknown[] = [];
	let aborted = false;
	let closed = false;
	let resolveFinished!: () => void;
	const finished = new Promise<void>((r) => { resolveFinished = r; });
	const stream = {
		id: 'mock-stream',
		send: (chunk: unknown) => { sent.push(chunk); },
		close: async () => { closed = true; resolveFinished(); },
		abort: (_err?: unknown) => { aborted = true; resolveFinished(); },
		async *[Symbol.asyncIterator]() { for (const f of inputFrames) yield f; },
	};
	return { stream, sent, finished, isAborted: () => aborted, isClosed: () => closed };
}

/**
 * An IPeerNetwork whose `connect()` returns a stream that replays `frames` as the
 * response the client reads. Lets a test drive the *client-side* response cap: a mock
 * peer returns an oversized reply frame and the client must reject at its length-prefix.
 */
function frameRespondingNetwork(frames: Array<Uint8Array>) {
	return {
		async connect() {
			return {
				send: () => { },
				close: async () => { },
				abort: () => { },
				async *[Symbol.asyncIterator]() { for (const f of frames) yield f; },
			} as any;
		},
	} as any;
}

/** Length-prefix-encode each value into its own wire frame (as the real client does). */
async function encodeMessages(...values: unknown[]): Promise<Uint8Array[]> {
	const inputs = values.map(v => new TextEncoder().encode(JSON.stringify(v)));
	const out = await all(pipe(inputs, lpEncode));
	return out.map((c: any) => (typeof c?.subarray === 'function' ? c.subarray() : c));
}

/**
 * A single length-prefix whose declared body length is `declaredLength`, with no
 * body bytes. The decoder parses the varint prefix and throws
 * `InvalidDataLengthError` the instant `declaredLength > maxDataLength` — before it
 * ever waits for (or allocates) the body — so this is enough to exercise the cap.
 */
function oversizedFrame(declaredLength: number): Uint8Array {
	const out: number[] = [];
	let n = declaredLength;
	while (n >= 0x80) {
		out.push((n & 0x7f) | 0x80);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return Uint8Array.from(out);
}

describe('inbound message caps', () => {
	describe('cluster service', () => {
		it('aborts the stream on an oversized frame (declared > control cap)', async () => {
			const stub = { calls: 0, async update(r: any) { stub.calls++; return r; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new ClusterService({ logger: makeLogger(), registrar, cluster: stub as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(mock.isAborted(), 'oversized frame must abort the stream').to.equal(true);
			expect(stub.calls, 'oversized frame must never reach cluster.update').to.equal(0);
		});

		it('processes only the first of two requests on one stream', async () => {
			const stub = { calls: 0, async update(r: any) { stub.calls++; return r; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new ClusterService({ logger: makeLogger(), registrar, cluster: stub as any }, {});
			await service.start();

			const req = { operation: 'update', record: { peers: {} } };
			const frames = await encodeMessages(req, req);
			const mock = makeMockStream(frames);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(stub.calls, 'second request on the same stream must not be processed').to.equal(1);
			expect(mock.isClosed(), 'stream closes normally after one response').to.equal(true);
		});
	});

	describe('repo service', () => {
		it('aborts the stream on an oversized frame (declared > block cap)', async () => {
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new RepoService({ logger: makeLogger(), registrar, repo: repo as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_BLOCK_MESSAGE_BYTES + 1)]);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(mock.isAborted(), 'oversized frame must abort the stream').to.equal(true);
			expect(repo.calls, 'oversized frame must never reach repo.get').to.equal(0);
		});

		it('does NOT apply the control cap: a frame above control (within block) is not rejected', async () => {
			// Guards the request-vs-response asymmetry the ticket calls out: block handlers
			// must NOT collapse to the small control cap. A frame declaring a length just
			// above the control cap (but below the block cap and below the library 4 MiB
			// default) must survive the length check — so it is not aborted. (No body is
			// supplied, so no message is decoded; the point is only that the cap did not fire.)
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new RepoService({ logger: makeLogger(), registrar, repo: repo as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(mock.isAborted(), 'a frame above the control cap must not be rejected by a block handler').to.equal(false);
		});

		it('applies the block cap, not the library default: a frame above 4 MiB (within block cap) is not rejected', async () => {
			// Strong regression guard for the `maxDataLength: MAX_BLOCK_MESSAGE_BYTES` edit.
			// The frame declares just above the library's own 4 MiB default but below the
			// 8 MiB block cap. If the edit were reverted, the decoder would fall back to the
			// 4 MiB default and abort this frame — so a passing "not aborted" proves the cap
			// is actually threaded and raised, which the `block cap + 1` oversized test (also
			// above the default) cannot distinguish.
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new RepoService({ logger: makeLogger(), registrar, repo: repo as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(LIBRARY_DEFAULT_MAX_BYTES + 1)]);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(mock.isAborted(), 'a frame within the block cap must not be rejected (would fail at the 4 MiB default)').to.equal(false);
		});

		it('processes only the first of two requests on one stream', async () => {
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new RepoService({ logger: makeLogger(), registrar, repo: repo as any }, {});
			await service.start();

			const req = { operations: [{ get: { blockIds: ['b1'] } }] };
			const frames = await encodeMessages(req, req);
			const mock = makeMockStream(frames);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(repo.calls, 'second request on the same stream must not be processed').to.equal(1);
			expect(mock.isClosed(), 'stream closes normally after one response').to.equal(true);
		});
	});

	describe('dispute service', () => {
		it('aborts the stream on an oversized frame (declared > control cap)', async () => {
			const disputeService = { calls: 0, async handleChallenge() { disputeService.calls++; return { verdict: 'ok' }; }, handleResolution() { } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new DisputeProtocolService({ logger: makeLogger(), registrar, disputeService: disputeService as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(mock.isAborted(), 'oversized frame must abort the stream').to.equal(true);
			expect(disputeService.calls, 'oversized frame must never reach handleChallenge').to.equal(0);
		});

		it('processes only the first of two requests on one stream', async () => {
			const disputeService = { calls: 0, async handleChallenge() { disputeService.calls++; return { verdict: 'ok' }; }, handleResolution() { } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new DisputeProtocolService({ logger: makeLogger(), registrar, disputeService: disputeService as any }, {});
			await service.start();

			const req = { type: 'challenge', challenge: { disputeId: 'd1' } };
			const frames = await encodeMessages(req, req);
			const mock = makeMockStream(frames);
			getHandler()(mock.stream as any, { remotePeer: await makePeerId() } as any);
			await mock.finished;

			expect(disputeService.calls, 'second request on the same stream must not be processed').to.equal(1);
			expect(mock.isClosed(), 'stream closes normally after one response').to.equal(true);
		});
	});

	describe('sync service', () => {
		it('aborts the stream on an oversized frame (declared > control cap)', async () => {
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { registrar, getHandler } = capturingRegistrar();
			const service = new SyncService({ logger: makeLogger(), registrar, repo: repo as any }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			getHandler()(mock.stream as any);
			await mock.finished;

			expect(mock.isAborted(), 'oversized frame must abort the stream').to.equal(true);
			expect(repo.calls, 'oversized frame must never reach repo.get').to.equal(0);
		});
	});

	describe('block-transfer service', () => {
		it('aborts the stream on an oversized frame (declared > block cap)', async () => {
			const repo: IBlockReplicaStore = {
				calls: 0,
				async get() { (repo as any).calls++; return {}; },
				async saveReplicatedBlock() { },
			} as any;
			const { registrar, getHandler } = capturingRegistrar();
			const service = new BlockTransferService({ registrar, repo }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_BLOCK_MESSAGE_BYTES + 1)]);
			await getHandler()(mock.stream as any);
			await mock.finished;

			expect(mock.isAborted(), 'oversized frame must abort the stream').to.equal(true);
			expect((repo as any).calls, 'oversized frame must never reach repo.get').to.equal(0);
		});

		it('does NOT apply the control cap: a frame above control (within block) is not rejected', async () => {
			const repo: IBlockReplicaStore = {
				async get() { return {}; },
				async saveReplicatedBlock() { },
			} as any;
			const { registrar, getHandler } = capturingRegistrar();
			const service = new BlockTransferService({ registrar, repo }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			await getHandler()(mock.stream as any);
			await mock.finished;

			expect(mock.isAborted(), 'a frame above the control cap must not be rejected by a block handler').to.equal(false);
		});

		it('applies the block cap, not the library default: a frame above 4 MiB (within block cap) is not rejected', async () => {
			// Strong regression guard: a frame above the library's 4 MiB default but below the
			// 8 MiB block cap. Reverting the `maxDataLength` edit would abort this at the default.
			const repo: IBlockReplicaStore = {
				async get() { return {}; },
				async saveReplicatedBlock() { },
			} as any;
			const { registrar, getHandler } = capturingRegistrar();
			const service = new BlockTransferService({ registrar, repo }, {});
			await service.start();

			const mock = makeMockStream([oversizedFrame(LIBRARY_DEFAULT_MAX_BYTES + 1)]);
			await getHandler()(mock.stream as any);
			await mock.finished;

			expect(mock.isAborted(), 'a frame within the block cap must not be rejected (would fail at the 4 MiB default)').to.equal(false);
		});
	});

	// The response a client reads is capped the same way (ProtocolClient.processMessage
	// threads `maxDataLength` into the response decode). A hostile peer that replies with
	// an oversized frame must be rejected at the length-prefix, before allocation.
	describe('client response cap', () => {
		it('control-cap client rejects an oversized response frame (declared > control cap)', async () => {
			// The declared length is above the control cap but BELOW the 4 MiB library
			// default — so this passes only if the client actually threads the control cap
			// into its response decode. A broken thread would fall back to the 4 MiB default,
			// not reject, and surface "No response received" instead.
			const peerId = await makePeerId();
			const network = frameRespondingNetwork([oversizedFrame(MAX_CONTROL_MESSAGE_BYTES + 1)]);
			const client = ClusterClient.create(peerId, network, '/optimystic/test');

			let caught: unknown;
			try { await client.update({} as any, 0); } catch (e) { caught = e; }
			expect(caught, 'an oversized response must reject the caller').to.be.instanceOf(Error);
			expect((caught as Error).message, 'must reject at the length-prefix cap').to.match(/Message length too long/);
		});

		it('block-cap client rejects an oversized response frame (declared > block cap)', async () => {
			const peerId = await makePeerId();
			const network = frameRespondingNetwork([oversizedFrame(MAX_BLOCK_MESSAGE_BYTES + 1)]);
			const client = new SyncClient(peerId, network, '/optimystic/test');

			let caught: unknown;
			try { await client.requestBlock({ blockId: 'b1' } as any); } catch (e) { caught = e; }
			expect(caught, 'an oversized response must reject the caller').to.be.instanceOf(Error);
			expect((caught as Error).message, 'must reject at the length-prefix cap').to.match(/Message length too long/);
		});
	});
});
