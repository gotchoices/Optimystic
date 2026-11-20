/**
 * Ticket: feat-blob-reads-say-whether-a-cohort-confirmed-them
 *
 * `GetBlockResult.cohortConfirmed` is the read path's positive answer to "did a machine other than
 * the one answering stand behind this?" — the fact docs/blobs.md §Lifetime needs before a blob may
 * be deleted on the strength of a read. These specs pin the three cases the reclaim pass must tell
 * apart, which were indistinguishable from the reader's side before:
 *
 *  - a cohort that answered in full (marked),
 *  - a cohort one member of which was silent (unmarked, and served exactly as before),
 *  - a view holding only this node, which answers an absent block as authoritatively absent and a
 *    held one from its own copy, both unflagged (unmarked).
 *
 * Plus `BlockGets.awaitConsult`, which moves an expired window's consult in FRONT of the answer so
 * it can carry that consult's verdict instead of being answered while the consult runs behind it.
 */

import { expect } from 'chai';
import { localDurability } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
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

/** The write half of an `IRepo` double: nothing here commits, so only a consult ever stamps the window. */
const writeRepo = {
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	}
};

/** Storage holding `blockId` at `held`. */
const makePresentStorageRepo = (blockId: BlockId, held: ActionRev): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(blockGets.blockIds.map(id => [id, id === blockId ? { state: { latest: held } } : { state: {} }]));
	},
	...writeRepo
});

/** Storage holding nothing, so every read is a local miss. */
const makeEmptyStorageRepo = (): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: {} }]));
	},
	...writeRepo
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

/** What one cohort member other than this node does when consulted (see {@link ClusterLatestCallback}). */
type MemberAnswer = 'holds-local-rev' | 'holds-nothing' | 'silent';

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>(settle => { resolve = settle; });
	return { promise, resolve };
}

describe('CoordinatorRepo cohort-confirmed reads', () => {
	const blockId: BlockId = 'block-cohort-confirmed';
	const LOCAL: ActionRev = { actionId: 'local-action', rev: 1 };
	const WINDOW_MS = 10_000;
	const BASE_TIME = 1_000_000;

	const makeRepo = async (opts: {
		/** Whether this node's storage holds the block. */
		holds: boolean;
		/** One entry per cohort member OTHER than this node; empty means a self-only cohort view. */
		members: MemberAnswer[];
		/** false leaves the window's consult behind the read, as production does. */
		awaitWindowConsults?: boolean;
		/** While unresolved, every non-self member's answer waits on it. */
		gate?: Promise<void>;
	}) => {
		const localPeer = await makePeerId();
		const memberPeers = await Promise.all(opts.members.map(() => makePeerId()));
		const cluster = makeClusterPeers([localPeer, ...memberPeers]);
		const answerOf = new Map(memberPeers.map((peer, index) => [peer.toString(), opts.members[index]!]));
		const consulted: string[] = [];
		const consultStarted = deferred();
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			consulted.push(peerId.toString());
			consultStarted.resolve();
			// Self answers from local storage rather than dialling itself, as `libp2p-node-base`'s does.
			if (peerId.equals(localPeer)) return opts.holds ? LOCAL : undefined;
			await opts.gate;
			const answer = answerOf.get(peerId.toString());
			if (answer === 'silent') throw new Error('peer unreachable');
			// A member that holds the block agrees with this node on `(rev, actionId)`, so two of them
			// corroborate what it holds and the pass takes the local-current exit rather than converging.
			return answer === 'holds-local-rev' ? LOCAL : undefined;
		};

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			opts.holds ? makePresentStorageRepo(blockId, LOCAL) : makeEmptyStorageRepo(),
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);
		repo.awaitWindowConsults = opts.awaitWindowConsults ?? true;
		let clock = BASE_TIME;
		repo.now = () => clock;

		return {
			repo,
			consulted,
			/** Resolves once the cohort has been consulted for some read. */
			consultStarted: consultStarted.promise,
			advance: (ms: number) => { clock += ms; },
			/** Arm the window with an unvouched stamp, then step past it, so the next read is window-demanded. */
			expireWindow: () => { repo.setLastSeenForTest(blockId, clock); clock += WINDOW_MS + 1; }
		};
	};

	it('marks an answer the whole cohort stood behind, and the reads inside the window it armed', async () => {
		// A block nobody holds: both members answer "I hold nothing", which is a real answer.
		const absent = await makeRepo({ holds: false, members: ['holds-nothing', 'holds-nothing'] });
		const missing = await absent.repo.get({ blockIds: [blockId] });
		expect(missing[blockId]?.unavailable, 'the whole cohort answered, so the absence stays authoritative').to.equal(undefined);
		expect(missing[blockId]?.cohortConfirmed, 'and it is marked as one the cohort confirmed').to.equal(true);

		// A block this node holds, at the revision both members report.
		const held = await makeRepo({ holds: true, members: ['holds-local-rev', 'holds-local-rev'] });
		const first = await held.repo.get({ blockIds: [blockId] });
		expect(first[blockId]?.cohortConfirmed, 'the consult this read waited on vouched for it').to.equal(true);

		held.advance(1_000);
		const second = await held.repo.get({ blockIds: [blockId] });
		expect(held.consulted.length, 'the second read is inside the window and consults nobody').to.equal(3);
		expect(second[blockId]?.cohortConfirmed, 'the window that consult armed vouches for the reads inside it').to.equal(true);
	});

	it('leaves an answer unmarked when one cohort member was silent, and serves it as before', async () => {
		const { repo, expireWindow } = await makeRepo({
			holds: true, members: ['holds-local-rev', 'silent'], awaitWindowConsults: false
		});
		expireWindow();

		const result = await repo.get({ blockIds: [blockId], awaitConsult: true });

		expect(result[blockId]?.state?.latest?.rev, 'the local copy is still served').to.equal(LOCAL.rev);
		expect(result[blockId]?.unavailable).to.equal(undefined);
		expect(result[blockId]?.unconfirmedAheadRev, 'nobody claimed anything ahead of it').to.equal(undefined);
		expect(result[blockId]?.cohortConfirmed, 'a partially silent consult does not vouch').to.equal(undefined);
	});

	it('never marks a self-only view, whose answers are the ones a confirmed read was indistinguishable from', async () => {
		const absent = await makeRepo({ holds: false, members: [] });
		const missing = await absent.repo.get({ blockIds: [blockId] });
		expect(missing[blockId]?.unavailable, 'a self-only view answers absent unflagged — the hazard this marker exists for').to.equal(undefined);
		expect(missing[blockId]?.cohortConfirmed, 'and asking nobody confirms nothing').to.equal(undefined);
		expect(absent.consulted, 'the solo-self exit skips the callback entirely').to.deep.equal([]);

		const held = await makeRepo({ holds: true, members: [] });
		const first = await held.repo.get({ blockIds: [blockId] });
		expect(first[blockId]?.cohortConfirmed, 'the solo-self exit asked nobody').to.equal(undefined);
		held.advance(1_000);
		const second = await held.repo.get({ blockIds: [blockId] });
		expect(second[blockId]?.cohortConfirmed, 'and the window it armed vouches for nothing').to.equal(undefined);
	});

	it('awaitConsult puts the window consult in front of the answer, so the answer carries its verdict', async () => {
		// Without the field: the read is answered from the local copy while the consult runs behind it.
		// The members' answers are held, so the read resolving at all is the proof it did not wait.
		const behind = deferred();
		const plain = await makeRepo({
			holds: true, members: ['holds-local-rev', 'holds-local-rev'], awaitWindowConsults: false, gate: behind.promise
		});
		plain.expireWindow();
		const served = await plain.repo.get({ blockIds: [blockId] });
		expect(served[blockId]?.cohortConfirmed, 'an answer no consult has backed yet is unmarked').to.equal(undefined);
		behind.resolve();
		await plain.repo.settleHeldBlockConsults();

		// With it: the read cannot be answered until the cohort has answered.
		const front = deferred();
		const awaiting = await makeRepo({
			holds: true, members: ['holds-local-rev', 'holds-local-rev'], awaitWindowConsults: false, gate: front.promise
		});
		awaiting.expireWindow();
		let answered = false;
		const read = awaiting.repo.get({ blockIds: [blockId], awaitConsult: true }).then(result => { answered = true; return result; });
		await awaiting.consultStarted;
		expect(answered, 'the read waits on the consult it asked for').to.equal(false);
		front.resolve();
		expect((await read)[blockId]?.cohortConfirmed, "and then carries that consult's verdict").to.equal(true);
	});
});
