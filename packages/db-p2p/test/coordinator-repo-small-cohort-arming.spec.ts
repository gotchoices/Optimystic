/**
 * Ticket: small-cohort-arming-rule.
 *
 * One rule decides when a repair pass may arm the lazy read-repair window: mark a block
 * freshness-checked exactly when re-asking the cohort sooner than one window could not teach this
 * node anything the next consult would not. These specs pin the rule's application at the exits a
 * SMALL cohort (one or two machines — supported production sizes) actually reaches:
 *
 *  - a corroborated `local-current` arms, single voter included (and now says `voters` out loud);
 *  - a certified claim converges and arms with no second peer, at any declared size;
 *  - a provably PERMANENT corroboration decline (`cohort-too-small` — the cohort cannot field the
 *    quorum even if every member answered and agreed) arms, damping the measured re-ask-forever
 *    loop of an undeclared two-machine cohort to one consult per window;
 *  - everything transient — a silent peer, a `sole-holder` missing copy, an agreed absence — keeps
 *    consulting on every read, because there re-asking can genuinely learn.
 *
 * The measured defect this closes: an undeclared two-machine cohort whose partner answers a
 * proof-less claim at the reader's own revision ran the consult on EVERY read — 6 peer queries
 * across three reads inside one 10 s window, versus 0 with the size declared — because the
 * deadlock verdict was computed for a log line and thrown away.
 *
 * TRAP (same as coordinator-repo-solo-read-repair-window.spec.ts): do NOT advance the clock past
 * `readRepairWindowMs` between reads that are supposed to be suppressed — a lapsed window
 * re-triggers by design, and a probe that steps a full window shows N triggers before and after
 * the fix.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type CoordinatorRepoConfig } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog } from './support/capture-log.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';

const captureCoordinatorLog = (fn: () => Promise<void>): Promise<unknown[][]> =>
	captureLog('coordinator-repo', fn);

const countTag = (captured: unknown[][], tag: string): number =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag)).length;

/** The structured payload of the first captured line carrying `tag`, or undefined. */
const payloadOf = (captured: unknown[][], tag: string): Record<string, unknown> | undefined =>
	captured.find(args => typeof args[0] === 'string' && args[0].includes(tag))?.[1] as Record<string, unknown> | undefined;

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

/** Storage repo holding BLOCK at `rev`. Nothing here ever commits, so nothing else arms the window. */
const makeStorageRepo = (blockId: BlockId, rev: number): IRepo => {
	const held: ActionRev = { actionId: 'local-action', rev };
	return {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId ? { state: { latest: held } } : { state: {} };
			}
			return result;
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			return { success: true, pending: [], blockIds: [] };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			return { success: true };
		}
	};
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

/** What one cohort partner answers the latest-revision consult with. */
type PartnerAnswer =
	| { kind: 'claims'; rev: number; actionId: string; proof?: BlockCommitProof }
	| { kind: 'holds-nothing' }
	| { kind: 'silent' };

const BLOCK: BlockId = 'block-small-cohort-arming';
const WINDOW_MS = 10_000;
const BASE_TIME = 1_000_000;
const LOCAL_REV = 1;

describe('CoordinatorRepo small-cohort arming rule', () => {

	/**
	 * A coordinator whose cohort is this node plus one partner per entry of `partners`, holding
	 * BLOCK at rev 1 locally. `cfg` layers over the lazy-window defaults — pass
	 * `assumedClusterSize: 2` for a DECLARED two-machine cohort; leave it off and
	 * `repairCorroborationClusterSize` falls back to `clusterSize` (default 10), the undeclared
	 * shape whose corroboration floor never relaxes.
	 */
	const makeCohortRepo = async (partners: PartnerAnswer[], cfg?: Partial<CoordinatorRepoConfig>) => {
		const localPeer = await makePeerId();
		const partnerPeers = await Promise.all(partners.map(() => makePeerId()));
		const cluster = makeClusterPeers([localPeer, ...partnerPeers]);
		const answers = new Map<string, PartnerAnswer>(
			partnerPeers.map((peer, i) => [peer.toString(), partners[i]!]));
		/** Every peer the callback was asked about, self included — one entry per consult per peer. */
		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			const id = peerId.toString();
			callbackInvocations.push(id);
			if (id === localPeer.toString()) return undefined;	// self short-circuit stand-in
			const answer = answers.get(id);
			if (!answer || answer.kind === 'silent') throw new Error('partner unreachable');
			if (answer.kind === 'holds-nothing') return undefined;
			return { rev: answer.rev, actionId: answer.actionId, ...(answer.proof ? { proof: answer.proof } : {}) };
		};

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			makeStorageRepo(BLOCK, LOCAL_REV),
			{ readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0, ...cfg },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);
		let clock = BASE_TIME;
		repo.now = () => clock;
		return { repo, callbackInvocations, setClock: (t: number) => { clock = t; } };
	};

	/** Three reads spaced one second apart — all inside one window — returning every result. */
	const threeReadsInsideWindow = async (
		repo: CoordinatorRepo, setClock: (t: number) => void
	): Promise<GetBlockResults[]> => {
		const results: GetBlockResults[] = [];
		for (let i = 0; i < 3; i++) {
			setClock(BASE_TIME + i * 1_000);
			results.push(await repo.get({ blockIds: [BLOCK] }));
		}
		return results;
	};

	describe('the joint-outcome table: a declared cohort is never worse off than an undeclared one', () => {

		it('declared two-machine cohort, partner corroborates: one consult per window, and the line says voters=1', async () => {
			const { repo, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: LOCAL_REV, actionId: 'local-action' }],
				{ assumedClusterSize: 2 }
			);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'the corroborated local-current exit arms the window').to.equal(1);
			const line = payloadOf(captured, 'cluster-fetch:local-current');
			expect(line?.voters, 'currency rests on a single voter, and the log says so').to.equal(1);
			expect(line?.certified, 'plain corroboration, not a certified selection').to.equal(undefined);
		});

		it('undeclared two-machine cohort, partner serves a certified claim: one consult per window', async () => {
			// The zero-configuration quiet path: the partner's claim carries a cohort commit proof the
			// reader verifies itself, so selection needs no second voter at ANY declared size.
			const { proof } = await makeSignedProof(2, {
				actionId: 'a-cert', blockIds: [BLOCK], tailId: BLOCK, rev: LOCAL_REV
			});
			const { repo, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: LOCAL_REV, actionId: 'a-cert', proof }]
			);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'a certified equal-revision claim lands in local-current and arms').to.equal(1);
			expect(countTag(captured, 'cluster-fetch:certified-selected'), 'the certified rule chose').to.equal(1);
			const line = payloadOf(captured, 'cluster-fetch:local-current');
			expect(line?.voters).to.equal(1);
			expect(line?.certified, 'the corroboration is a proof, and the log says so').to.equal(true);
		});

		it('undeclared two-machine cohort, proof-less claim at the reader\'s revision: cohort-too-small arms — one consult per window, deadlock named once', async () => {
			// The measured re-ask-forever loop: floor stays 2 (measured against the default
			// repairCorroborationClusterSize of 10), one partner can never meet it, and before the fix
			// this consulted on every read (6 peer queries across three reads in one window).
			const { repo, callbackInvocations, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: LOCAL_REV, actionId: 'local-action' }]
			);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'a provably permanent decline arms the window — re-asking the same hopeless question teaches nothing').to.equal(1);
			expect(callbackInvocations.length, 'one pass consults self + partner; before the fix this was 6').to.equal(2);
			expect(countTag(captured, 'cluster-fetch:no-quorum')).to.equal(1);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock'), 'named once per episode').to.equal(1);
			expect(payloadOf(captured, 'cluster-fetch:repair-deadlock')?.reason).to.equal('cohort-too-small');
		});

		it('a silent partner never arms: consults every read, whatever the declared size says', async () => {
			// The classify guard is load-bearing for the arming consumer, not just for the log: a pass
			// with any silent peer proves nothing, even in a declared cohort whose arithmetic would
			// otherwise relax the floor. This is also the relay-outage shape for two phones — a
			// relay-only partner that cannot be reached lands in `silent` exactly like a dead one.
			for (const cfg of [undefined, { assumedClusterSize: 2 }]) {
				const { repo, setClock } = await makeCohortRepo([{ kind: 'silent' }], cfg);

				const captured = await captureCoordinatorLog(async () => {
					await threeReadsInsideWindow(repo, setClock);
				});

				expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
					`silence keeps re-asking (declared=${cfg !== undefined}) — the partner can recover any moment`).to.equal(3);
				expect(countTag(captured, 'cluster-fetch:repair-deadlock'),
					'a pass with silence makes no permanent claim').to.equal(0);
			}
		});
	});

	describe('what arming must not erase or suppress', () => {

		it('doubt survives arming: reads inside the armed window still carry unconfirmedAheadRev', async () => {
			// An undeclared reader genuinely BEHIND a proof-less partner: the claim cannot be
			// corroborated (cohort-too-small), the window arms — and every read inside it must still
			// say the served content may be behind rev 5. The window damps repair EFFORT, never
			// honesty (the invariant fix/currency-doubt-cleared-by-a-partial-answer protects).
			const { repo, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: 5, actionId: 'a-ahead' }]
			);

			const captured = await captureCoordinatorLog(async () => {
				const results = await threeReadsInsideWindow(repo, setClock);
				for (const [i, result] of results.entries()) {
					expect(result[BLOCK]?.unconfirmedAheadRev,
						`read ${i + 1} must carry the doubt memo, consulted or suppressed`).to.equal(5);
				}
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'armed: one consult per window even while doubted').to.equal(1);
			expect(payloadOf(captured, 'cluster-fetch:repair-deadlock')?.reason).to.equal('cohort-too-small');
		});

		it('the second window re-arms with one more consult, and the deadlock line does not repeat', async () => {
			// The split this ticket makes — verdict every pass, log once per episode — is what lets
			// both be true. Before it, returning the say-once outcome would have armed exactly once.
			const { repo, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: LOCAL_REV, actionId: 'local-action' }]
			);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);          // read 1 consults and arms at BASE_TIME
				setClock(BASE_TIME + WINDOW_MS + 1_000);               // the window armed at BASE_TIME lapsed
				await repo.get({ blockIds: [BLOCK] });                 // consults again, re-arms
				setClock(BASE_TIME + WINDOW_MS + 2_000);
				await repo.get({ blockIds: [BLOCK] });                 // suppressed by the re-arm
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'exactly one consult per window, window after window').to.equal(2);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock'),
				'the verdict re-armed the second window without re-announcing the episode').to.equal(1);
		});

		it('arming a block this node does not hold changes nothing: the read still consults and still flags', async () => {
			// The arming stamp is keyed on the block id, and `cohort-too-small` is a property of the
			// COHORT, so it stamps a block the reader holds nothing of just as readily. That stamp must
			// stay inert: `get` triggers on `isMissing` BEFORE it consults the window, because a read
			// of a block this node lacks has to attempt an acquisition rather than serve an unverified
			// absent. Pinned here so a future "unify the two triggers" edit cannot quietly turn an
			// unheld block's arming into a suppressed acquisition — the block would then read as an
			// authoritative absent for a whole window (`unavailable` unset, so NetworkTransactor stops
			// retrying) while a cohort peer is claiming it exists.
			const UNHELD: BlockId = 'block-this-node-does-not-hold';
			const { repo, callbackInvocations, setClock } = await makeCohortRepo(
				[{ kind: 'claims', rev: 3, actionId: 'a-elsewhere' }]
			);

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 3; i++) {
					setClock(BASE_TIME + i * 1_000);
					const result = await repo.get({ blockIds: [UNHELD] });
					expect(result[UNHELD]?.unavailable,
						`read ${i + 1}: a peer claims the block, so the absent is never authoritative`)
						.to.equal('claimed-elsewhere');
				}
			});

			expect(callbackInvocations.length,
				'every read consults — the window is stamped but a missing block never reads it').to.equal(6);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock'), 'still named once per episode').to.equal(1);
			expect(payloadOf(captured, 'cluster-fetch:repair-deadlock')?.reason).to.equal('cohort-too-small');
		});
	});

	describe('transient declines keep re-asking', () => {

		it('sole-holder: consults every read, deadlock named once', async () => {
			// Cohort of three (reader + 2): one partner holds the block, the other answers that it
			// holds nothing. The missing thing is a COPY — the cohort-growth push or the next commit
			// can deliver it at any moment — so re-asking can genuinely learn, and the window must
			// stay unarmed.
			const { repo, setClock } = await makeCohortRepo([
				{ kind: 'claims', rev: LOCAL_REV, actionId: 'local-action' },
				{ kind: 'holds-nothing' }
			]);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
				'a missing copy is not a permanent condition of the cohort — keep asking').to.equal(3);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock')).to.equal(1);
			expect(payloadOf(captured, 'cluster-fetch:repair-deadlock')?.reason).to.equal('sole-holder');
		});

		it('an agreed absence: consults every read, no deadlock', async () => {
			// Every partner answers "I hold nothing" while the reader holds the block. Zero claims is
			// an answer, not a deadlock — and a partner gaining a copy or a newer revision is exactly
			// what re-asking can learn.
			const { repo, setClock } = await makeCohortRepo([
				{ kind: 'holds-nothing' },
				{ kind: 'holds-nothing' }
			]);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(3);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock'),
				'zero claims is an agreed absence, never a deadlock').to.equal(0);
		});

		it('declared two-machine cohort whose partner holds nothing: consults every read until the copy arrives', async () => {
			// Founding data the partner has not yet received (the growing 1 → 2 shape): bounded by the
			// cohort-growth push delivering the copy, not by the read-repair window. Pinned as the
			// current, intended behaviour — the partner gaining the copy is what re-asking learns.
			const { repo, setClock } = await makeCohortRepo(
				[{ kind: 'holds-nothing' }],
				{ assumedClusterSize: 2 }
			);

			const captured = await captureCoordinatorLog(async () => {
				await threeReadsInsideWindow(repo, setClock);
			});

			expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(3);
			expect(countTag(captured, 'cluster-fetch:repair-deadlock')).to.equal(0);
		});
	});
});
