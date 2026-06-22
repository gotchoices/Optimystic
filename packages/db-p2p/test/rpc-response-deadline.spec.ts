import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import { encode as lpEncode } from 'it-length-prefixed';
import all from 'it-all';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork } from '@optimystic/db-core';
import { ClusterClient } from '../src/cluster/client.js';
import { SyncClient } from '../src/sync/client.js';
import { DisputeClient } from '../src/dispute/client.js';
import { RepoClient } from '../src/repo/client.js';
import { ResponseTimeoutError, RESPONSE_TIMEOUT_ERROR_CODE } from '../src/protocol-client.js';

/**
 * Gap-2 regression: every ProtocolClient subclass that issues a request must bound
 * the *response* read, not just the dial. A peer that connects then goes silent must
 * reject the caller within a bounded deadline rather than hanging forever. These
 * specs model the silent peer exactly as the dial/round-trip specs do (a stream that
 * dials OK but whose source never yields; `abort(err)` ends the never-fed read), and
 * also assert a promptly-replying peer still succeeds with the deadline configured.
 */

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Length-prefix-encode a JSON value into the wire frames the client's lpDecode expects. */
async function encodeFrames(value: unknown): Promise<unknown[]> {
	return await all(pipe([new TextEncoder().encode(JSON.stringify(value))], lpEncode));
}

/**
 * A stream that dials OK but never writes a reply and never closes its read. `abort(err)`
 * ends the (never-fed) read queue so a deadline-driven `stream.abort(...)` can actually
 * interrupt the otherwise-blocked read — exactly what a real libp2p stream does on abort.
 * `aborted()` reports whether the read was torn down (proves no leaked pending read).
 */
function makeSilentStream() {
	const toClient = pushable<unknown>({ objectMode: true });
	let wasAborted = false;
	const stream = {
		send: (_chunk: unknown) => { /* swallow the request */ },
		close: async () => { /* deliberately does NOT end the read queue */ },
		abort: (err?: Error) => { wasAborted = true; toClient.end(err ?? new Error('aborted')); },
		async *[Symbol.asyncIterator]() { yield* toClient; },
	};
	return { stream, aborted: () => wasAborted };
}

/** An IPeerNetwork whose connect() hands back a fresh silent stream and records the latest one. */
function silentNetwork() {
	let last: ReturnType<typeof makeSilentStream> | undefined;
	const network = {
		async connect(_p: PeerId, _proto: string, _opts?: unknown) {
			last = makeSilentStream();
			return last.stream as any;
		},
	} as unknown as IPeerNetwork;
	return { network, lastStream: () => last };
}

/** An IPeerNetwork whose connect() replies immediately with `response` (length-prefixed). */
function respondingNetwork(response: unknown) {
	const network = {
		async connect(_p: PeerId, _proto: string, _opts?: unknown) {
			const frames = await encodeFrames(response);
			return {
				send: (_chunk: unknown) => { },
				close: async () => { },
				abort: () => { },
				async *[Symbol.asyncIterator]() { yield* frames; },
			} as any;
		},
	} as unknown as IPeerNetwork;
	return network;
}

describe('RPC response deadline (cluster / sync / dispute)', () => {
	it('ClusterClient.update rejects with ResponseTimeoutError when the peer goes silent', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const { network } = silentNetwork();
		const client = ClusterClient.create(peerId, network, '/optimystic/test');

		const t0 = Date.now();
		let caught: unknown;
		try {
			// Tight per-call response override so a regression fails fast.
			await client.update({} as any, 0, { responseTimeoutMs: 80 });
		} catch (e) { caught = e; }
		const elapsed = Date.now() - t0;
		expect(caught, 'a silent cluster peer must not hang the caller').to.be.instanceOf(ResponseTimeoutError);
		expect((caught as ResponseTimeoutError).code).to.equal(RESPONSE_TIMEOUT_ERROR_CODE);
		expect(elapsed).to.be.lessThan(1500);
	});

	it('ClusterClient.update succeeds when the peer replies promptly (deadline configured)', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const record = { ok: true, tag: 'cluster-rt' };
		const client = ClusterClient.create(peerId, respondingNetwork(record), '/optimystic/test');
		const result = await client.update({} as any);
		expect(result).to.deep.equal(record);
	});

	it('SyncClient.requestBlock rejects with ResponseTimeoutError when the peer goes silent', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const { network } = silentNetwork();
		const client = new SyncClient(peerId, network, '/optimystic/test');

		const t0 = Date.now();
		let caught: unknown;
		try {
			await client.requestBlock({ blockId: 'b1' } as any, { responseTimeoutMs: 80 });
		} catch (e) { caught = e; }
		const elapsed = Date.now() - t0;
		expect(caught, 'a silent sync peer must not hang the caller').to.be.instanceOf(ResponseTimeoutError);
		expect((caught as ResponseTimeoutError).code).to.equal(RESPONSE_TIMEOUT_ERROR_CODE);
		expect(elapsed).to.be.lessThan(1500);
	});

	it('SyncClient.requestBlock succeeds when the peer replies promptly (deadline configured)', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const response = { success: true, blockId: 'b1' };
		const client = new SyncClient(peerId, respondingNetwork(response), '/optimystic/test');
		const result = await client.requestBlock({ blockId: 'b1' } as any);
		expect(result).to.deep.equal(response);
	});

	it('DisputeClient.sendResolution rejects with ResponseTimeoutError when the peer goes silent', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const { network } = silentNetwork();
		const client = DisputeClient.create(peerId, network, '/optimystic/test');

		const t0 = Date.now();
		let caught: unknown;
		try {
			await client.sendResolution({ disputeId: 'd1' } as any, { responseTimeoutMs: 80 });
		} catch (e) { caught = e; }
		const elapsed = Date.now() - t0;
		expect(caught, 'a silent broadcast peer must not hang the caller').to.be.instanceOf(ResponseTimeoutError);
		expect((caught as ResponseTimeoutError).code).to.equal(RESPONSE_TIMEOUT_ERROR_CODE);
		expect(elapsed).to.be.lessThan(1500);
	});

	it('DisputeClient.sendResolution succeeds when the peer acks promptly (deadline configured)', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const client = DisputeClient.create(peerId, respondingNetwork({ type: 'ack' }), '/optimystic/test');
		await client.sendResolution({ disputeId: 'd1' } as any);
		// No throw == success (sendResolution returns void).
	});
});

describe('RPC response deadline (repo, leak fix)', () => {
	it('RepoClient rejects with "RepoClient timeout" AND tears down the read when the peer goes silent', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const { network, lastStream } = silentNetwork();
		const client = RepoClient.create(peerId, network, '/optimystic/test');

		const t0 = Date.now();
		let caught: unknown;
		try {
			// Short expiration → small deadline; no dialTimeoutMs so the deadline fires
			// during the response phase and surfaces the caller-facing message.
			await client.get({ blockIds: ['b1'] } as any, { expiration: Date.now() + 80 } as any);
		} catch (e) { caught = e; }
		const elapsed = Date.now() - t0;

		expect(caught, 'a silent repo peer must not hang the caller').to.be.instanceOf(Error);
		expect((caught as Error).message).to.equal('RepoClient timeout');
		expect(elapsed).to.be.lessThan(1500);
		// The decisive leak-fix assertion: the deadline actually aborted the inner
		// stream read rather than leaving it running (the old Promise.race did not).
		expect(lastStream()?.aborted(), 'deadline must tear down the inner read, not leak it').to.equal(true);
	});

	it('RepoClient succeeds when the peer replies promptly within the expiration budget', async function () {
		this.timeout(2000);
		const peerId = await makePeerId();
		const blockResults = { b1: { block: { header: { id: 'b1' } } } };
		const client = RepoClient.create(peerId, respondingNetwork(blockResults), '/optimystic/test');
		const result = await client.get({ blockIds: ['b1'] } as any, { expiration: Date.now() + 5_000 } as any);
		expect(result).to.deep.equal(blockResults);
	});

	it('RepoClient follows a redirect and the retry rebuilds its own deadline', async function () {
		this.timeout(2000);
		const startPeer = await makePeerId();
		const targetPeer = await makePeerId();
		const finalResults = { b1: { block: { header: { id: 'b1' } } } };

		// First dial → redirect to targetPeer; second dial → the final result.
		let dialCount = 0;
		const network = {
			async connect(_p: PeerId, _proto: string, _opts?: unknown) {
				dialCount++;
				const response = dialCount === 1
					? { redirect: { peers: [{ id: targetPeer.toString() }] } }
					: finalResults;
				const frames = await encodeFrames(response);
				return {
					send: () => { },
					close: async () => { },
					abort: () => { },
					async *[Symbol.asyncIterator]() { yield* frames; },
				} as any;
			},
		} as unknown as IPeerNetwork;

		const client = RepoClient.create(startPeer, network, '/optimystic/test');
		const result = await client.get({ blockIds: ['b1'] } as any, { expiration: Date.now() + 5_000 } as any);
		expect(result).to.deep.equal(finalResults);
		expect(dialCount).to.equal(2);
	});
});
