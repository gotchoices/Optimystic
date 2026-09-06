/**
 * Ticket: a-reader-cannot-tell-its-view-stopped-advancing.
 *
 * A successful commit used to arm the lazy read-repair window unconditionally
 * (`markBlocksSeen` on every commit-side success path), so a node that kept writing a
 * block never re-checked it against the cohort: its own writes counted as proof of
 * freshness. That is only sound when the commit's approvals form a majority of the FULL
 * cohort — then any rival commit's quorum must intersect ours and the rival would have
 * surfaced. A commit on a downsized quorum (solo short-circuit under a declared larger
 * cohort, degraded routing, or a consensus record that enrolled a minority of the full
 * cohort) proves nothing about rivals — exactly the moments forks happen — so it must
 * leave the window unarmed and let the next read past the window consult the cohort.
 *
 * The field shape this pins: node B's periodic writes to a control collection re-armed
 * the window forever while node C's newer commits landed on a quorum excluding B; B
 * served the same stale rows for 45 s across 156 reads with zero consults.
 *
 * These specs observe the window through the read path (a consult fires or it does not)
 * rather than through any internal getter, because the read path is what the window
 * exists to gate.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev, ClusterRecord, RepoMessage
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog } from './support/capture-log.js';

const captureCoordinatorLog = (fn: () => Promise<void>): Promise<unknown[][]> =>
	captureLog('coordinator-repo', fn);

const countTag = (captured: unknown[][], tag: string): number =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag)).length;

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const BLOCK: BlockId = 'block-commit-freshness';
const WINDOW_MS = 10_000;
const BASE_TIME = 1_000_000;
const REQUEST: CommitRequest = { actionId: 'a-fresh', blockIds: [BLOCK], tailId: BLOCK, rev: 2 };

/** Storage repo holding BLOCK at rev 1; `commit` does whatever `commitImpl` says (default: success). */
const makeStorageRepo = (commitImpl?: () => Promise<CommitResult>): IRepo => {
	const held: ActionRev = { actionId: 'local-action', rev: 1 };
	return {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === BLOCK ? { state: { latest: held } } : { state: {} };
			}
			return result;
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			return { success: true, pending: [], blockIds: [] };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		commit: commitImpl ?? (async (): Promise<CommitResult> => ({ success: true }))
	};
};

/** A consensus record with `enrolled` peers of which the first `approvals` signed approving commits. */
const makeRecord = (approvals: number, enrolled: number): ClusterRecord => {
	const peers: ClusterPeers = {};
	const commits: ClusterRecord['commits'] = {};
	for (let i = 0; i < enrolled; i++) {
		peers[`peer-${i}`] = { multiaddrs: [], publicKey: '' };
		if (i < approvals) {
			commits[`peer-${i}`] = { type: 'approve' } as ClusterRecord['commits'][string];
		}
	}
	return { messageHash: 'mh', peers, message: {} as RepoMessage, promises: {}, commits };
};

describe('CoordinatorRepo commit-side freshness (quorum-intersection gate)', () => {

	describe('solo short-circuit', () => {
		/**
		 * A cohort of exactly this node, with a deterministic clock and a consult-counting
		 * callback. `clusterSize` is the declared full-cohort yardstick
		 * (`repairCorroborationClusterSize` falls back to it) — the knob under test.
		 */
		const makeSoloRepo = async (clusterSize: number) => {
			const localPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer]);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
				undefined,
				localPeer,
				undefined,
				async () => undefined
			);
			let clock = BASE_TIME;
			repo.now = () => clock;
			return { repo, setClock: (t: number) => { clock = t; } };
		};

		it('a solo commit under a declared cohort of 2 does NOT arm the window', async () => {
			// The reported deployment: 2-member cohorts, one member committing alone. Its quorum of
			// one cannot intersect a rival quorum on the other member, so the commit proves nothing
			// about rivals and the next read must consult.
			const { repo, setClock } = await makeSoloRepo(2);

			const captured = await captureCoordinatorLog(async () => {
				expect((await repo.commit(REQUEST)).success).to.equal(true);
				setClock(BASE_TIME + 1_000);	// well inside the window
				await repo.get({ blockIds: [BLOCK] });
			});

			expect(countTag(captured, 'commit:solo-cohort'), 'sanity: the solo branch ran').to.equal(1);
			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'the in-window read must consult — the commit must not have armed the window').to.equal(1);
			// The consult lands on the solo-self-skip exit, which arms the window itself — that is
			// what bounds the cost at one consult per window (see the next assertion and the
			// coordinator-repo-solo-read-repair-window specs).
			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);
		});

		it('after the consult, further in-window reads are suppressed (cost stays one consult per window)', async () => {
			const { repo, setClock } = await makeSoloRepo(2);

			const captured = await captureCoordinatorLog(async () => {
				await repo.commit(REQUEST);
				setClock(BASE_TIME + 1_000);
				await repo.get({ blockIds: [BLOCK] });	// consults, solo-skip arms
				setClock(BASE_TIME + 2_000);
				await repo.get({ blockIds: [BLOCK] });	// suppressed by the consult's own arming
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(1);
		});

		it('a solo commit on a genuine cohort of one DOES arm the window', async () => {
			// Declared and observed cohort are both 1: one approval IS a full-cohort majority, and
			// no rival quorum can exist that excludes this node.
			const { repo, setClock } = await makeSoloRepo(1);

			const captured = await captureCoordinatorLog(async () => {
				expect((await repo.commit(REQUEST)).success).to.equal(true);
				setClock(BASE_TIME + 1_000);
				await repo.get({ blockIds: [BLOCK] });
			});

			expect(countTag(captured, 'commit:solo-cohort'), 'sanity: the solo branch ran').to.equal(1);
			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'a genuine cohort-of-one commit is freshness evidence — no consult inside the window').to.equal(0);
			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(0);
		});
	});

	describe('consensus path', () => {
		/**
		 * A repo whose consensus layer is a double: `getClusterPeerIds` reports `cohort` ids (what
		 * routing sees) and `executeClusterTransaction` yields `record` with
		 * `localExecuted`/`localCommitResult` as given. The keyNetwork's view matches `cohort` so
		 * the read path consults the same peers the commit saw. `clusterSize` is the declared
		 * full-cohort yardstick.
		 */
		const makeConsensusRepo = async (opts: {
			clusterSize: number;
			cohortPeers: number;
			record: ClusterRecord;
			localExecuted: boolean;
			storageCommit?: () => Promise<CommitResult>;
		}) => {
			const localPeer = await makePeerId();
			const remotes = await Promise.all(Array.from({ length: opts.cohortPeers - 1 }, () => makePeerId()));
			const cluster = makeClusterPeers([localPeer, ...remotes]);
			const callbackInvocations: string[] = [];
			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				callbackInvocations.push(peerId.toString());
				return undefined;
			};
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(opts.storageCommit),
				{ clusterSize: opts.clusterSize, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
				undefined,
				localPeer,
				undefined,
				clusterLatestCallback
			);
			(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = {
				async getClusterSize(): Promise<number> { return Object.keys(cluster).length; },
				async getClusterPeerIds(): Promise<string[]> { return Object.keys(cluster); },
				async recoverTransactions(): Promise<void> { /* unused */ },
				async executeClusterTransaction(): Promise<{ record: ClusterRecord, localExecuted: boolean }> {
					return { record: opts.record, localExecuted: opts.localExecuted };
				}
			};
			let clock = BASE_TIME;
			repo.now = () => clock;
			return { repo, callbackInvocations, setClock: (t: number) => { clock = t; } };
		};

		it('a commit whose approvals are a majority of the full cohort arms the window', async () => {
			// Declared 3, enrolled 3, 2 approvals: 2 > 3/2 — any rival majority must share a voter.
			const { repo, callbackInvocations, setClock } = await makeConsensusRepo({
				clusterSize: 3, cohortPeers: 3, record: makeRecord(2, 3), localExecuted: true
			});

			expect((await repo.commit(REQUEST)).success).to.equal(true);
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [BLOCK] });

			expect(callbackInvocations, 'no consult inside the window — the commit armed it').to.deep.equal([]);
		});

		it('a commit whose record enrolled a minority of the full cohort does NOT arm the window', async () => {
			// Declared 5, but routing/enrollment shrank to 2; both enrolled peers approve. That is
			// consensus over the enrolled subset (the commit succeeds), but 2 of a full cohort of 5
			// cannot rule out a rival quorum on the other 3 — the next read must consult.
			const { repo, callbackInvocations, setClock } = await makeConsensusRepo({
				clusterSize: 5, cohortPeers: 2, record: makeRecord(2, 2), localExecuted: true
			});

			expect((await repo.commit(REQUEST)).success).to.equal(true);
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [BLOCK] });

			expect(callbackInvocations.length, 'the in-window read must consult the cohort').to.be.greaterThan(0);
		});

		it('the local-fallback success path applies the same gate', async () => {
			// localExecuted false → CoordinatorRepo commits to its own storage after consensus.
			// Same downsized shape as above; the fallback's success must not arm either.
			const { repo, callbackInvocations, setClock } = await makeConsensusRepo({
				clusterSize: 5, cohortPeers: 2, record: makeRecord(2, 2), localExecuted: false
			});

			expect((await repo.commit(REQUEST)).success).to.equal(true);
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [BLOCK] });

			expect(callbackInvocations.length, 'the in-window read must consult the cohort').to.be.greaterThan(0);
		});

		it('a tolerated local divergence on a full-cohort majority still arms the window', async () => {
			// The cluster committed on a genuine majority; only this peer's local apply failed. The
			// quorum's intersection guarantee holds regardless of the local failure.
			const { repo, callbackInvocations, setClock } = await makeConsensusRepo({
				clusterSize: 3, cohortPeers: 3, record: makeRecord(3, 3), localExecuted: false,
				storageCommit: async () => { throw new Error(`Pending action a-fresh not found for block(s): ${BLOCK}`); }
			});

			expect((await repo.commit(REQUEST)).success, 'divergence is tolerated as success').to.equal(true);
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [BLOCK] });

			expect(callbackInvocations, 'no consult inside the window').to.deep.equal([]);
		});

		it('a tolerated local divergence on a downsized quorum does NOT arm the window', async () => {
			// Enrolled-subset consensus (2 of 2) tolerates the divergence, but 2 of a declared 5
			// proves nothing about rivals — and this peer is KNOWN to be behind here, the worst
			// place for a self-referential freshness stamp.
			const { repo, callbackInvocations, setClock } = await makeConsensusRepo({
				clusterSize: 5, cohortPeers: 2, record: makeRecord(2, 2), localExecuted: false,
				storageCommit: async () => { throw new Error(`Pending action a-fresh not found for block(s): ${BLOCK}`); }
			});

			expect((await repo.commit(REQUEST)).success, 'divergence is tolerated as success').to.equal(true);
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [BLOCK] });

			expect(callbackInvocations.length, 'the in-window read must consult the cohort').to.be.greaterThan(0);
		});
	});
});
