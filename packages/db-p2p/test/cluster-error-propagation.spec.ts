import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork, PeerId as CorePeerId, ICluster, ClusterRecord, RepoMessage } from '@optimystic/db-core';
import { ClusterClient } from '../src/cluster/client.js';
import { ClusterService, type ClusterServiceComponents } from '../src/cluster/service.js';
import {
	CLUSTER_ERROR_KEY,
	toClusterErrorEnvelope,
	isClusterErrorEnvelope,
	clusterErrorFromEnvelope,
} from '../src/cluster/cluster-error.js';

async function makePeerId(): Promise<PeerId> {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
}

/** Length-prefix encode a JSON value into the byte chunks a libp2p stream yields. */
async function encodeJson(value: unknown): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of pipe([new TextEncoder().encode(JSON.stringify(value))], lpEncode)) {
		chunks.push(chunk.subarray());
	}
	return chunks;
}

/** Decode every length-prefixed JSON object out of a set of stream chunks. */
async function decodeJson(chunks: Uint8Array[]): Promise<unknown[]> {
	const source = (async function* () { for (const c of chunks) yield c; })();
	const out: unknown[] = [];
	for await (const data of pipe(source, lpDecode)) {
		out.push(JSON.parse(new TextDecoder().decode(data.subarray())));
	}
	return out;
}

const makeRecord = (): ClusterRecord => ({
	messageHash: 'hash-1',
	peers: {},
	message: { operations: [] } as unknown as RepoMessage,
	promises: {},
	commits: {},
});

/** Fake IPeerNetwork whose single dial returns a stream replaying `responseChunks`. */
function networkReturning(responseChunks: Uint8Array[]): IPeerNetwork {
	return {
		async connect(_p: CorePeerId, _proto: string) {
			return {
				send: () => {},
				close: async () => {},
				abort: () => {},
				async *[Symbol.asyncIterator]() {
					for (const chunk of responseChunks) yield chunk;
				},
			} as unknown;
		},
	} as unknown as IPeerNetwork;
}

/** Build a service stream that sources `requestChunks` and captures sent/close/abort. */
function makeServiceStream(requestChunks: Uint8Array[]) {
	const sent: Uint8Array[] = [];
	let aborted = false;
	let resolveDone: () => void;
	const done = new Promise<void>((resolve) => { resolveDone = resolve; });
	const stream = {
		send: (chunk: { subarray: () => Uint8Array }) => { sent.push(chunk.subarray()); },
		close: async () => { resolveDone(); },
		abort: (_err: unknown) => { aborted = true; resolveDone(); },
		async *[Symbol.asyncIterator]() {
			for (const chunk of requestChunks) yield chunk;
		},
	};
	return { stream, sent, done, wasAborted: () => aborted };
}

const makeComponents = (cluster: ICluster, peerId: PeerId): ClusterServiceComponents => ({
	logger: { forComponent: () => ({ error: () => {}, info: () => {}, trace: () => {}, debug: () => {} }) as any },
	registrar: { handle: async () => {}, unhandle: async () => {} },
	cluster,
	peerId,
});

describe('cluster error envelope', () => {
	describe('helpers', () => {
		it('round-trips message/name/code', () => {
			const err = Object.assign(new Error('validateRecord failed: bad signature'), {
				name: 'ValidationError',
				code: 'ERR_INVALID_SIGNATURE',
			});
			const envelope = toClusterErrorEnvelope(err);
			expect(isClusterErrorEnvelope(envelope)).to.equal(true);
			const restored = clusterErrorFromEnvelope(envelope);
			expect(restored.message).to.equal('validateRecord failed: bad signature');
			expect(restored.name).to.equal('ValidationError');
			expect((restored as { code?: string }).code).to.equal('ERR_INVALID_SIGNATURE');
		});

		it('omits code when the source error carries none', () => {
			const envelope = toClusterErrorEnvelope(new Error('boom'));
			expect(envelope[CLUSTER_ERROR_KEY].code).to.equal(undefined);
		});

		it('coerces a non-Error throw to a message', () => {
			const envelope = toClusterErrorEnvelope('plain string failure');
			expect(envelope[CLUSTER_ERROR_KEY].message).to.equal('plain string failure');
		});

		it('never classifies a ClusterRecord or redirect payload as an error', () => {
			expect(isClusterErrorEnvelope(makeRecord())).to.equal(false);
			expect(isClusterErrorEnvelope({ redirect: { peers: [], reason: 'not_in_cluster' } })).to.equal(false);
			expect(isClusterErrorEnvelope(null)).to.equal(false);
			expect(isClusterErrorEnvelope('record')).to.equal(false);
		});
	});

	describe('ClusterService.handleIncomingStream', () => {
		it('returns a structured envelope and closes the stream (no abort) when update throws', async () => {
			const peerId = await makePeerId();
			const throwingCluster: ICluster = {
				async update(): Promise<ClusterRecord> {
					throw Object.assign(new Error('processUpdate rejected: consensus throw'), {
						name: 'ConsensusError',
						code: 'ERR_CONSENSUS',
					});
				},
			};
			const service = new ClusterService(makeComponents(throwingCluster, peerId));
			const { stream, sent, done, wasAborted } = makeServiceStream(
				await encodeJson({ operation: 'update', record: makeRecord() })
			);

			(service as unknown as { handleIncomingStream: (s: unknown, c: unknown) => void })
				.handleIncomingStream(stream, { remotePeer: peerId });
			await done;

			expect(wasAborted()).to.equal(false);
			const responses = await decodeJson(sent);
			expect(responses).to.have.length(1);
			expect(isClusterErrorEnvelope(responses[0])).to.equal(true);
			const detail = (responses[0] as { [CLUSTER_ERROR_KEY]: { message: string; name: string; code?: string } })[CLUSTER_ERROR_KEY];
			expect(detail.message).to.equal('processUpdate rejected: consensus throw');
			expect(detail.name).to.equal('ConsensusError');
			expect(detail.code).to.equal('ERR_CONSENSUS');
		});

		it('returns the record (not an envelope) when update succeeds', async () => {
			const peerId = await makePeerId();
			const okCluster: ICluster = { async update(record: ClusterRecord) { return record; } };
			const service = new ClusterService(makeComponents(okCluster, peerId));
			const { stream, sent, done, wasAborted } = makeServiceStream(
				await encodeJson({ operation: 'update', record: makeRecord() })
			);

			(service as unknown as { handleIncomingStream: (s: unknown, c: unknown) => void })
				.handleIncomingStream(stream, { remotePeer: peerId });
			await done;

			expect(wasAborted()).to.equal(false);
			const responses = await decodeJson(sent);
			expect(responses).to.have.length(1);
			expect(isClusterErrorEnvelope(responses[0])).to.equal(false);
			expect((responses[0] as ClusterRecord).messageHash).to.equal('hash-1');
		});
	});

	describe('ClusterClient.update', () => {
		it('rejects with the server error (message/name/code) when the response is an envelope', async () => {
			const peerId = await makePeerId();
			const envelope = toClusterErrorEnvelope(Object.assign(new Error('mergeRecords: conflicting commit'), {
				name: 'ConsensusError',
				code: 'ERR_CONSENSUS',
			}));
			const client = ClusterClient.create(peerId, networkReturning(await encodeJson(envelope)), '/optimystic/test');

			let caught: unknown;
			try {
				await client.update(makeRecord());
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(Error);
			expect((caught as Error).message).to.equal('mergeRecords: conflicting commit');
			expect((caught as Error).name).to.equal('ConsensusError');
			expect((caught as { code?: string }).code).to.equal('ERR_CONSENSUS');
		});

		it('returns the record for a normal (non-envelope) response', async () => {
			const peerId = await makePeerId();
			const record = makeRecord();
			const client = ClusterClient.create(peerId, networkReturning(await encodeJson(record)), '/optimystic/test');
			const result = await client.update(record);
			expect(result.messageHash).to.equal('hash-1');
		});
	});
});
