import { expect } from 'chai';
import { pipe } from 'it-pipe';
import { encode as lpEncode } from 'it-length-prefixed';
import all from 'it-all';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { BlockHeader, BlockId } from '@optimystic/db-core';
import { ClusterService } from '../src/cluster/service.js';
import { RepoService } from '../src/repo/service.js';
import { SyncService } from '../src/sync/service.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockTransferClient, BlockTransferService, type IBlockReplicaStore } from '../src/cluster/block-transfer-service.js';
import {
	INBOUND_STREAM_UNAUTHORIZED_CODE,
	UnauthorizedInboundStreamError,
	type AuthorizeInboundStream,
} from '../src/inbound-authorization.js';

/**
 * Inbound-stream authorization (feat-inbound-stream-authorization-hook).
 *
 * The four database services — repo, cluster, sync, block-transfer — otherwise decode and
 * execute whatever any peer that can open a connection sends them. Each now consults an
 * optional embedder predicate ONCE per inbound stream, before decoding anything.
 *
 * Every denial assertion below checks the *underlying repo/cluster mock received nothing*,
 * not merely that an error surfaced: fail-open here would defeat the whole feature, and a
 * handler that executed the operation and then aborted would still look "denied" from the
 * stream's point of view.
 *
 * The handlers are private; each service registers its handler via `registrar.handle`, so the
 * tests capture that callback at `start()` and drive it with a mock stream plus the
 * `{ remotePeer }` connection shape the real libp2p registrar passes as the second argument.
 */

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** A callable logger that records everything written to `.error` (the authorization sink). */
function makeLogger() {
	const errors: string[] = [];
	const fn: any = (..._args: unknown[]) => { };
	fn.error = (msg: string, ...args: unknown[]) => { errors.push(`${msg} ${args.map(a => String(a)).join(' ')}`); };
	fn.trace = () => { };
	fn.debug = () => { };
	fn.info = () => { };
	fn.warn = () => { };
	return { logger: { forComponent: () => fn } as any, errors };
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
 * Mock duplex stream. `[Symbol.asyncIterator]` replays the supplied wire frames, `send`
 * collects the encoded reply, and `close`/`abort` each resolve `finished` so a test can await
 * handler completion. `abortError` is what the authorization gate tore the stream down with.
 */
function makeMockStream(inputFrames: Uint8Array[]) {
	const sent: unknown[] = [];
	let aborted = false;
	let closed = false;
	let abortError: unknown;
	let resolveFinished!: () => void;
	const finished = new Promise<void>((r) => { resolveFinished = r; });
	const stream = {
		id: 'mock-stream',
		send: (chunk: unknown) => { sent.push(chunk); },
		close: async () => { closed = true; resolveFinished(); },
		abort: (err?: unknown) => { aborted = true; abortError = err; resolveFinished(); },
		async *[Symbol.asyncIterator]() { for (const f of inputFrames) yield f; },
	};
	return { stream, sent, finished, isAborted: () => aborted, isClosed: () => closed, getAbortError: () => abortError };
}

/** Length-prefix-encode each value into its own wire frame (as the real client does). */
async function encodeMessages(...values: unknown[]): Promise<Uint8Array[]> {
	const inputs = values.map(v => new TextEncoder().encode(JSON.stringify(v)));
	const out = await all(pipe(inputs, lpEncode));
	return out.map((c: any) => (typeof c?.subarray === 'function' ? c.subarray() : c));
}

/** Assert a stream was torn down by the authorization gate specifically, not by a decode fault. */
function expectAuthorizationAbort(abortError: unknown, protocol: string): void {
	expect(abortError, 'the stream must be aborted with the authorization error').to.be.instanceOf(UnauthorizedInboundStreamError);
	expect((abortError as { code: string }).code).to.equal(INBOUND_STREAM_UNAUTHORIZED_CODE);
	expect((abortError as Error).message, 'the denial names the protocol it was denied on').to.contain(protocol);
}

/** A predicate that records every `(peerId, protocol)` pair it is asked about. */
function recordingPredicate(verdict: boolean): { predicate: AuthorizeInboundStream, calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = [];
	return {
		calls,
		predicate: (remotePeerId, protocol) => { calls.push([remotePeerId, protocol]); return verdict; },
	};
}

/**
 * The four services under one shape so each semantic (allow / deny / throw / absent) is asserted
 * against all of them rather than against whichever one was convenient.
 *
 * `build` returns a started service's captured handler, the mock stream it will be driven with,
 * and `executions()` — the count of operations the underlying repo/cluster mock actually ran.
 */
interface ServiceCase {
	readonly name: string;
	readonly protocol: string;
	build: (init: { authorizeInboundStream?: AuthorizeInboundStream, authorizeInboundStreamTimeoutMs?: number }) => Promise<{
		drive: (connection?: unknown) => Promise<void>;
		mock: ReturnType<typeof makeMockStream>;
		executions: () => number;
		errors: string[];
	}>;
}

const PREFIX = '/optimystic/authz-test';

const SERVICE_CASES: ServiceCase[] = [
	{
		name: 'repo',
		protocol: `${PREFIX}/repo/1.0.0`,
		async build(init) {
			const repo = { calls: 0, async get() { repo.calls++; return {}; }, async pend() { repo.calls++; return {}; }, async cancel() { repo.calls++; return {}; }, async commit() { repo.calls++; return {}; } };
			const { logger, errors } = makeLogger();
			const { registrar, getHandler } = capturingRegistrar();
			const service = new RepoService({ logger, registrar, repo: repo as any }, { protocolPrefix: PREFIX, ...init });
			await service.start();
			const mock = makeMockStream(await encodeMessages({ operations: [{ get: { blockIds: ['block-1'] } }] }));
			return {
				mock,
				errors,
				executions: () => repo.calls,
				drive: async (connection) => { getHandler()(mock.stream as any, connection as any); await mock.finished; },
			};
		},
	},
	{
		name: 'cluster',
		protocol: `${PREFIX}/cluster/1.0.0`,
		async build(init) {
			const cluster = { calls: 0, async update(record: any) { cluster.calls++; return record; } };
			const { logger, errors } = makeLogger();
			const { registrar, getHandler } = capturingRegistrar();
			const service = new ClusterService({ logger, registrar, cluster: cluster as any }, { protocolPrefix: PREFIX, ...init });
			await service.start();
			const mock = makeMockStream(await encodeMessages({ operation: 'update', record: { messageHash: 'h1', peers: {} } }));
			return {
				mock,
				errors,
				executions: () => cluster.calls,
				drive: async (connection) => { getHandler()(mock.stream as any, connection as any); await mock.finished; },
			};
		},
	},
	{
		name: 'sync',
		protocol: `${PREFIX}/db-p2p/sync/1.0.0`,
		async build(init) {
			const repo = { calls: 0, async get() { repo.calls++; return {}; } };
			const { logger, errors } = makeLogger();
			const { registrar, getHandler } = capturingRegistrar();
			const service = new SyncService({ logger, registrar, repo: repo as any }, { protocolPrefix: PREFIX, ...init });
			await service.start();
			const mock = makeMockStream(await encodeMessages({ blockId: 'block-1' }));
			return {
				mock,
				errors,
				executions: () => repo.calls,
				drive: async (connection) => { getHandler()(mock.stream as any, connection as any); await mock.finished; },
			};
		},
	},
	{
		name: 'block-transfer',
		protocol: `${PREFIX}/db-p2p/block-transfer/1.0.0`,
		async build(init) {
			const repo = { calls: 0, async get() { repo.calls++; return {}; }, async saveReplicatedBlock() { repo.calls++; } } as unknown as IBlockReplicaStore & { calls: number };
			const { logger, errors } = makeLogger();
			const { registrar, getHandler } = capturingRegistrar();
			const service = new BlockTransferService({ registrar, repo, logger, superMajorityThreshold: 0.75 }, { protocolPrefix: PREFIX, ...init });
			await service.start();
			const mock = makeMockStream(await encodeMessages({ type: 'pull', blockIds: ['block-1'], reason: 'rebalance' }));
			return {
				mock,
				errors,
				executions: () => repo.calls,
				drive: async (connection) => { await getHandler()(mock.stream as any, connection as any); await mock.finished; },
			};
		},
	},
];

describe('inbound stream authorization', () => {
	for (const svc of SERVICE_CASES) {
		describe(`${svc.name} service`, () => {
			it('no predicate → the operation runs and the stream closes normally (unchanged behavior)', async () => {
				const driven = await svc.build({});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'the operation must execute when no predicate is configured').to.equal(1);
				expect(driven.mock.isAborted(), 'no predicate must never abort a stream').to.equal(false);
				expect(driven.mock.isClosed(), 'the stream closes normally').to.equal(true);
			});

			it('predicate returns true → the operation runs, unchanged', async () => {
				const { predicate, calls } = recordingPredicate(true);
				const peerId = await makePeerId();
				const driven = await svc.build({ authorizeInboundStream: predicate });
				await driven.drive({ remotePeer: peerId });

				expect(driven.executions(), 'an authorized peer\'s operation must execute').to.equal(1);
				expect(driven.mock.isAborted()).to.equal(false);
				expect(calls, 'the predicate is consulted exactly once per stream').to.have.length(1);
				expect(calls[0], 'the predicate receives PeerId.toString() and the full protocol id')
					.to.deep.equal([peerId.toString(), svc.protocol]);
			});

			it('predicate returns false → the operation NEVER reaches the repo/cluster, and the stream is aborted', async () => {
				const { predicate } = recordingPredicate(false);
				const driven = await svc.build({ authorizeInboundStream: predicate });
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'a denied stream must not execute its operation').to.equal(0);
				expect(driven.mock.isAborted(), 'a denied stream is torn down').to.equal(true);
				expect(driven.mock.sent, 'a denied stream must not write a response').to.have.length(0);
				expectAuthorizationAbort(driven.mock.getAbortError(), svc.protocol);
			});

			it('predicate throws → denied (never falls through to execution)', async () => {
				const driven = await svc.build({
					authorizeInboundStream: () => { throw new Error('membership lookup exploded'); },
				});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'a throwing predicate must deny, not fail open').to.equal(0);
				expect(driven.mock.isAborted()).to.equal(true);
				expectAuthorizationAbort(driven.mock.getAbortError(), svc.protocol);
			});

			it('predicate rejects → denied', async () => {
				const driven = await svc.build({
					authorizeInboundStream: async () => { throw new Error('membership lookup timed out upstream'); },
				});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'a rejecting predicate must deny, not fail open').to.equal(0);
				expect(driven.mock.isAborted()).to.equal(true);
			});

			it('predicate never settles → denied once the deadline expires', async () => {
				const driven = await svc.build({
					authorizeInboundStream: () => new Promise<boolean>(() => { /* never settles */ }),
					authorizeInboundStreamTimeoutMs: 25,
				});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'a hanging predicate must deny once its deadline expires').to.equal(0);
				expect(driven.mock.isAborted()).to.equal(true);
				expect((driven.mock.getAbortError() as Error).message, 'the denial names the deadline').to.contain('25ms');
			});

			it('predicate configured but the remote peer is unidentifiable → denied (fail closed)', async () => {
				const { predicate, calls } = recordingPredicate(true);
				const driven = await svc.build({ authorizeInboundStream: predicate });
				// No connection at all — the handler cannot name the remote, so it cannot authorize it.
				await driven.drive(undefined);

				expect(driven.executions(), 'an unidentifiable remote must not execute an operation').to.equal(0);
				expect(driven.mock.isAborted()).to.equal(true);
				expect(calls, 'the predicate is not even asked when there is no peer id to ask about').to.have.length(0);
			});

			it('a truthy non-boolean verdict does not count as authorization', async () => {
				const driven = await svc.build({
					// An embedder returning the wrong shape (a truthy object, a Promise-of-string) must not
					// be read as consent: only a literal `true` allows.
					authorizeInboundStream: (() => 'yes') as unknown as AuthorizeInboundStream,
				});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.executions(), 'only a literal true authorizes').to.equal(0);
				expect(driven.mock.isAborted()).to.equal(true);
			});
		});
	}

	// All four services route the gate's diagnostics through the component logger's `error` sink,
	// so an embedder sees denials on the same channel as every other service error.
	for (const svc of SERVICE_CASES) {
		describe(`${svc.name} service logging`, () => {
			it('logs the predicate failure rather than swallowing it', async () => {
				const driven = await svc.build({
					authorizeInboundStream: () => { throw new Error('membership lookup exploded'); },
				});
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.errors.join('\n'), 'the throw itself must be logged, not swallowed')
					.to.contain('authorization predicate threw');
				expect(driven.errors.join('\n'), 'the denial is logged with its reason')
					.to.contain('inbound stream denied');
			});

			it('logs the denial when the predicate simply returns false', async () => {
				const driven = await svc.build({ authorizeInboundStream: () => false });
				await driven.drive({ remotePeer: await makePeerId() });

				expect(driven.errors.join('\n')).to.contain('inbound stream denied');
			});
		});
	}
});

/**
 * The gate from the *dialing client's* side, over a real request/response round trip.
 *
 * The per-service cases above drive handlers with a scripted mock stream, which proves the
 * server never executes a denied operation but cannot show what the caller ends up with. Here a
 * real `BlockTransferClient` talks to a real `BlockTransferService` across a linked duplex pair
 * (the harness from `block-transfer-roundtrip.spec.ts`), so two things the unit cases leave open
 * are pinned down: an *authorized* request still round-trips intact with the gate installed, and
 * a *denied* one fails the caller promptly instead of hanging until its response deadline.
 */
function makeLinkedPair() {
	const toServer = pushable<any>({ objectMode: true });
	const toClient = pushable<any>({ objectMode: true });
	const clientStream = {
		send: (chunk: any) => { toServer.push(chunk); },
		close: async () => { toServer.end(); },
		abort: (err?: Error) => { toServer.end(err); toClient.end(err); },
		async *[Symbol.asyncIterator]() { yield* toClient; },
	};
	const serverStream = {
		send: (chunk: any) => { toClient.push(chunk); },
		close: async () => { toClient.end(); },
		abort: (err?: Error) => { toClient.end(err); toServer.end(err); },
		async *[Symbol.asyncIterator]() { yield* toServer; },
	};
	return { clientStream, serverStream };
}

describe('inbound stream authorization — what the dialing client observes', () => {
	const BLOCK_ID = 'authz-roundtrip-1' as BlockId;

	/** A started block-transfer service reachable through a `BlockTransferClient`. */
	async function wire(init: { authorizeInboundStream?: AuthorizeInboundStream }, clientPeerId: PeerId) {
		const rawStorage = new MemoryRawStorage();
		const repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		await repo.saveReplicatedBlock(BLOCK_ID, {
			header: { id: BLOCK_ID, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader
		});

		const { logger } = makeLogger();
		const { registrar, getHandler } = capturingRegistrar();
		const service = new BlockTransferService({ registrar, repo, logger, superMajorityThreshold: 0.75 }, { protocolPrefix: PREFIX, ...init });
		await service.start();

		const peerNetwork = {
			async connect() {
				const { clientStream, serverStream } = makeLinkedPair();
				// Not awaited — mirrors how libp2p invokes a stream handler, with the connection
				// object the registrar passes as the second argument.
				void Promise.resolve()
					.then(() => getHandler()(serverStream, { remotePeer: clientPeerId }))
					.catch(() => { /* the handler aborts its own stream */ });
				return clientStream;
			},
		};
		return { service, client: new BlockTransferClient(clientPeerId, peerNetwork as any) };
	}

	it('an authorized pull still round-trips the block intact through the gate', async function () {
		this.timeout(4000);
		const peerId = await makePeerId();
		const { service, client } = await wire({ authorizeInboundStream: () => true }, peerId);
		try {
			const response = await client.pullBlocks([BLOCK_ID], 'replication');
			expect(response.blocks, 'the gate must not disturb the response framing').to.have.property(BLOCK_ID);
			expect(response.missing).to.deep.equal([]);
		} finally {
			await service.stop();
		}
	});

	it('a denied pull fails the caller promptly rather than hanging', async function () {
		// Well under BlockTransferClient's own response deadline: a denial must surface as a
		// stream teardown, not as a request that sits open until it times out.
		this.timeout(4000);
		const peerId = await makePeerId();
		const { service, client } = await wire({ authorizeInboundStream: () => false }, peerId);
		try {
			const started = Date.now();
			await client.pullBlocks([BLOCK_ID], 'replication')
				.then(
					() => { throw new Error('a denied pull must not resolve with a response'); },
					() => { /* any rejection is correct: the remote only ever sees a reset */ }
				);
			expect(Date.now() - started, 'the denial surfaces immediately, not on a timeout').to.be.lessThan(2000);
		} finally {
			await service.stop();
		}
	});
});
