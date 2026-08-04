/**
 * Ticket: remote-read-consults-cohort
 *
 * A block read arriving over the REPO protocol is a read made by another node — the
 * normal case in any party with more than one machine. `RepoService` handed those reads
 * to the repo with `skipClusterFetch: true`, which makes `CoordinatorRepo.get` skip the
 * cohort consult entirely. A coordinator that holds nothing then answered a bare
 * `{ state: {} }` — an AUTHORITATIVE absence that `NetworkTransactor.get` never retries —
 * without ever asking the cohort peer that actually holds the block.
 *
 * These specs pin that a repo-protocol read reaches the consult, while the
 * cluster-internal sync read (`sync/service.ts`, which must keep the skip or the consult
 * recurses into itself) is untouched.
 */

import { expect } from 'chai';
import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev, RepoMessage, GetBlockResult,
	FindCoordinatorOptions
} from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { RepoService, type RepoServiceComponents } from '../src/repo/service.js';
import { toString as u8ToString } from 'uint8arrays';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
		};
	}
	return peers;
};

const makeKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const writeStubs = {
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [] };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true };
	}
};

/**
 * Storage repo answering every block with `entry` — a bare absent by default, or a
 * present block when one is supplied — and recording each read it was asked for.
 */
const makeStorageRepo = (entry: GetBlockResult = { state: {} }): { repo: IRepo, calls: BlockGets[] } => {
	const calls: BlockGets[] = [];
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			return Object.fromEntries(blockGets.blockIds.map(id => [id, structuredClone(entry)]));
		},
		...writeStubs
	};
	return { repo, calls };
};

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

const makeServiceComponents = (repo: IRepo, peerId: PeerId): RepoServiceComponents => ({
	logger: { forComponent: () => ({ error: () => { }, info: () => { }, trace: () => { }, debug: () => { } }) as any },
	registrar: { handle: async () => { }, unhandle: async () => { } },
	repo,
	peerId,
	// No networkManager: checkRedirect short-circuits to null, so the op is handled
	// locally — exactly the state of a node the client already routed to.
});

/** Drive one repo-protocol `get` through the real inbound-stream handler. */
async function repoProtocolGet(service: RepoService, blockId: BlockId): Promise<GetBlockResult | undefined> {
	const message: RepoMessage = {
		operations: [{ get: { blockIds: [blockId], context: undefined } }],
		expiration: Date.now() + 30_000
	} as RepoMessage;
	const { stream, sent, done } = makeServiceStream(await encodeJson(message));
	(service as unknown as { handleIncomingStream: (s: unknown, c: unknown) => void })
		.handleIncomingStream(stream, undefined);
	await done;
	const responses = await decodeJson(sent);
	return (responses[0] as GetBlockResults | undefined)?.[blockId];
}

describe('repo-protocol get consults the cohort', () => {
	const blockId: BlockId = 'default/CadrePeer';

	/**
	 * A 2-peer cohort whose local member answers with `localEntry` (nothing by default) and
	 * whose other member claims `cohortLatest` — `null` for a peer that answers "I hold
	 * nothing", which is a real answer and not silence. `acquireBlockFromCohort` is
	 * deliberately not wired, so a corroborated revision this node lacks can never be
	 * acquired — the consult ends INCONCLUSIVE, the shape that must surface as `unavailable`.
	 *
	 * Defaults reproduce the observed failure: this node joined after the block was written,
	 * routing now points reads at it, and it has never held the block, while the cohort peer
	 * that DOES hold it corroborates rev 2.
	 */
	const buildCoordinator = async (
		{ cohortLatest = { actionId: 'remote-action', rev: 2 }, localEntry }:
			{ cohortLatest?: ActionRev | null, localEntry?: GetBlockResult } = {}
	): Promise<{ repo: CoordinatorRepo, localPeer: PeerId, storageCalls: BlockGets[] }> => {
		const localPeer = await makePeerId();
		const holder = await makePeerId();
		const cluster = makeClusterPeers([localPeer, holder]);
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(localPeer) ? localEntry?.state?.latest : (cohortLatest ?? undefined);
		const { repo: storageRepo, calls } = makeStorageRepo(localEntry);
		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 2 },
			undefined,
			localPeer,
			undefined,
			callback
		);
		return { repo, localPeer, storageCalls: calls };
	};

	it('does not answer a bare authoritative absent for a block the cohort holds', async () => {
		const { repo, localPeer } = await buildCoordinator();
		const service = new RepoService(makeServiceComponents(repo, localPeer));

		const entry = await repoProtocolGet(service, blockId);

		expect(entry, 'a get response was produced').to.exist;
		expect(entry!.unavailable, 'unconfirmed absence is flagged, not reported as authoritative')
			.to.equal('peers-unreachable');
	});

	it('a repo-protocol get reaches the cohort consult', async () => {
		const { repo, localPeer, storageCalls } = await buildCoordinator();
		const service = new RepoService(makeServiceComponents(repo, localPeer));

		await repoProtocolGet(service, blockId);

		// The consult re-reads local storage after fetching, so a consult that ran means
		// more than the single plain local read.
		expect(storageCalls.length, 'the cohort consult ran (local read + post-consult re-read)')
			.to.be.greaterThan(1);
	});

	it('a cluster-internal sync read still skips the consult (no recursion)', async () => {
		const { repo, storageCalls } = await buildCoordinator();

		const result = await repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as MessageOptions);

		expect(result[blockId]!.state).to.deep.equal({});
		expect('unavailable' in result[blockId]!).to.equal(false);
		expect(storageCalls.length, 'only the plain local read ran').to.equal(1);
	});

	// The other half of the contract. Reaching the consult must not make every absence
	// look uncertain: `createOrOpen` probes a not-yet-existing header on every open, and a
	// healthy cohort answering "I hold nothing" is a real answer. Flagging it would cost a
	// transactor-level retry against another peer on the routine new-collection path.
	it('keeps the absent authoritative when the whole cohort answers "holds nothing"', async () => {
		const { repo, localPeer } = await buildCoordinator({ cohortLatest: null });
		const service = new RepoService(makeServiceComponents(repo, localPeer));

		const entry = await repoProtocolGet(service, blockId);

		expect(entry!.state, 'the block reads as absent').to.deep.equal({});
		expect(entry!.unavailable, 'a cohort that answered is authoritative — no flag').to.equal(undefined);
	});

	// A locally-present block still consults (lazy read-repair, no last-seen timestamp yet),
	// but the cohort corroborates the revision this node already holds, so the read is served
	// from local state unflagged rather than being downgraded by the consult it now reaches.
	it('serves a locally-present block unflagged when the cohort corroborates it', async () => {
		const latest: ActionRev = { actionId: 'held-action', rev: 2 };
		const { repo, localPeer } = await buildCoordinator({
			cohortLatest: latest,
			localEntry: { state: { latest } }
		});
		const service = new RepoService(makeServiceComponents(repo, localPeer));

		const entry = await repoProtocolGet(service, blockId);

		expect(entry!.state.latest, 'the local revision is returned').to.deep.equal(latest);
		expect(entry!.unavailable, 'a present block is never flagged').to.equal(undefined);
	});
});
