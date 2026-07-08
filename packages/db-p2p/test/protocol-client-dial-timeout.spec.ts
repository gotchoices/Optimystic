import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, AbortOptions } from '@libp2p/interface';
import type { IPeerNetwork, PeerId as CorePeerId } from '@optimystic/db-core';
import { ProtocolClient, DialTimeoutError, DIAL_TIMEOUT_ERROR_CODE, ResponseTimeoutError, RESPONSE_TIMEOUT_ERROR_CODE } from '../src/protocol-client.js';

class TestProtocolClient extends ProtocolClient {
	async dial(message: unknown, protocol: string, options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }) {
		return this.processMessage<unknown>(message, protocol, options);
	}
}

/**
 * A stream that dials OK but whose source never yields and never closes. `abort(err)`
 * ends the (never-fed) read so a deadline-driven `stream.abort(...)` can interrupt the
 * otherwise-blocked read — exactly what a real libp2p stream does on abort.
 */
function silentStream() {
	let endRead: ((err?: Error) => void) | undefined;
	return {
		send: () => {},
		close: async () => {},
		abort: (err?: Error) => { endRead?.(err); },
		async *[Symbol.asyncIterator]() {
			await new Promise<void>((_, reject) => { endRead = (err?: Error) => reject(err ?? new Error('aborted')); });
		},
	};
}

async function makePeerId(): Promise<PeerId> {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
}

describe('ProtocolClient dial timeout', () => {
	it('throws DialTimeoutError when dial hangs past dialTimeoutMs', async () => {
		const peerId = await makePeerId();
		const hangingNetwork: IPeerNetwork = {
			async connect(_p: CorePeerId, _proto: string, options?: AbortOptions) {
				return new Promise<never>((_, reject) => {
					if (options?.signal?.aborted) {
						reject(options.signal.reason);
						return;
					}
					options?.signal?.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
				});
			}
		} as unknown as IPeerNetwork;

		const client = new TestProtocolClient(peerId, hangingNetwork);
		const t0 = Date.now();
		let caught: unknown;
		try {
			await client.dial({ ping: true }, '/test/1.0.0', { dialTimeoutMs: 100 });
		} catch (e) {
			caught = e;
		}
		const elapsed = Date.now() - t0;
		expect(caught).to.be.instanceOf(DialTimeoutError);
		expect((caught as DialTimeoutError).code).to.equal(DIAL_TIMEOUT_ERROR_CODE);
		expect(elapsed).to.be.lessThan(500); // generous epsilon for CI jitter
	});

	it('does not impose a dial cap when dialTimeoutMs is omitted', async () => {
		const peerId = await makePeerId();
		let observedSignal: AbortSignal | undefined;
		const network: IPeerNetwork = {
			async connect(_p: CorePeerId, _proto: string, options?: AbortOptions) {
				observedSignal = options?.signal;
				// resolve "successfully" with a stream-shaped stub that the
				// response-wait path will then exercise (and fail on, which is fine
				// for this assertion — we only care that the dial wasn't aborted)
				return { send: () => {}, close: async () => {}, [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; } } as any;
			}
		} as unknown as IPeerNetwork;
		const client = new TestProtocolClient(peerId, network);
		try { await client.dial({}, '/test/1.0.0', {}); } catch { /* response-wait path will fail; not under test */ }
		expect(observedSignal).to.equal(undefined);
	});

	it('forwards parent signal abort to the dial', async () => {
		const peerId = await makePeerId();
		const network: IPeerNetwork = {
			async connect(_p: CorePeerId, _proto: string, options?: AbortOptions) {
				return new Promise<never>((_, reject) => {
					options?.signal?.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
				});
			}
		} as unknown as IPeerNetwork;
		const client = new TestProtocolClient(peerId, network);
		const parent = new AbortController();
		const sentinel = new Error('parent aborted');
		// Deliberate timing (NOT a convergence wait): fire the parent abort at 30ms so it wins the race
		// against the 5_000ms dial-timeout timer — that ordering is the behavior under test.
		setTimeout(() => parent.abort(sentinel), 30);
		let caught: unknown;
		try {
			await client.dial({}, '/test/1.0.0', { signal: parent.signal, dialTimeoutMs: 5_000 });
		} catch (e) { caught = e; }
		// Parent abort surfaces (not a dial-timeout) because the timer didn't fire.
		expect(caught).to.equal(sentinel);
	});
});

describe('ProtocolClient response timeout', () => {
	it('throws ResponseTimeoutError when the dialed stream never yields', async () => {
		const peerId = await makePeerId();
		const network: IPeerNetwork = {
			async connect() {
				// Dial succeeds; the response-read phase is what must be bounded.
				return silentStream() as any;
			}
		} as unknown as IPeerNetwork;

		const client = new TestProtocolClient(peerId, network);
		const t0 = Date.now();
		let caught: unknown;
		try {
			await client.dial({ ping: true }, '/test/1.0.0', { responseTimeoutMs: 100 });
		} catch (e) {
			caught = e;
		}
		const elapsed = Date.now() - t0;
		expect(caught).to.be.instanceOf(ResponseTimeoutError);
		expect((caught as ResponseTimeoutError).code).to.equal(RESPONSE_TIMEOUT_ERROR_CODE);
		expect(elapsed).to.be.lessThan(1000); // bounded by the deadline, not a hang
	});

	it('surfaces the parent reason (not a response-timeout) when the parent signal aborts the read', async () => {
		const peerId = await makePeerId();
		const network: IPeerNetwork = {
			async connect() {
				return silentStream() as any;
			}
		} as unknown as IPeerNetwork;

		const client = new TestProtocolClient(peerId, network);
		const parent = new AbortController();
		const sentinel = new Error('parent aborted read');
		// Deliberate timing (NOT a convergence wait): with no response timer, the read blocks forever, so
		// this scheduled abort at 30ms is the only thing that ends it — letting real time pass IS the test.
		setTimeout(() => parent.abort(sentinel), 30);
		let caught: unknown;
		try {
			// No response timer (responseTimeoutMs omitted); only the parent signal can end the read.
			await client.dial({ ping: true }, '/test/1.0.0', { signal: parent.signal });
		} catch (e) {
			caught = e;
		}
		expect(caught).to.equal(sentinel);
	});

	it('does not impose a response cap when neither responseTimeoutMs nor signal is supplied', async () => {
		const peerId = await makePeerId();
		// A stream that immediately ends its source (no frame) — first(...) hits onEmpty and
		// throws 'No response received', proving no deadline machinery interfered.
		const network: IPeerNetwork = {
			async connect() {
				return {
					send: () => {},
					close: async () => {},
					abort: () => {},
					[Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) }; },
				} as any;
			}
		} as unknown as IPeerNetwork;
		const client = new TestProtocolClient(peerId, network);
		let caught: unknown;
		try {
			await client.dial({ ping: true }, '/test/1.0.0', {});
		} catch (e) {
			caught = e;
		}
		expect(caught).to.be.instanceOf(Error);
		expect((caught as Error).message).to.equal('No response received');
	});
});
