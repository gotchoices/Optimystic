/**
 * Ticket: a-block-we-do-not-hold-is-consulted-on-every-read (GitHub issue #8)
 *
 * `CoordinatorRepo.get` consults a block's cohort for two reasons: the block is MISSING locally,
 * or it is held but the lazy read-repair window says it may be stale. The second trigger has been
 * bounded to one consult per `readRepairWindowMs` for a long time; the first had no bound at all,
 * so a caller probing a record that has not been created yet paid a full consult on every probe,
 * forever. (Measured in the field: a never-written `Revocation` collection cost two consults per
 * control-plane call, six calls out of six.)
 *
 * The fix gives an absence the same freshness window content already gets, but only where it can
 * carry the same guarantee: when this node is the block's whole cohort. There every acknowledged
 * commit of the block lands in this node's storage before the writer hears success, so the block
 * reads present and the memo dies. A multi-peer cohort's unanimous "nothing" is NOT remembered:
 * this node takes part in other coordinators' writes as a cohort member without passing through
 * its own coordinator, and a commit acknowledged at super-majority reaches the remaining members
 * in the background — remembering it served a writer's own create as absent through a lagging
 * member (fresh-node-ddl-multi Scenario B). See backlog feat-a-cohort-member-remembers-a-settled-absence.
 *
 * Consults are counted by `cluster-fetch:solo-self-skip` lines on a cohort of one (that exit
 * queries nobody, so the log line is the only trace) and by the cluster-latest callback's
 * invocations addressed to THIS node on a multi-peer cohort (a real consult always asks every
 * cohort member, self included, so that is exactly one per consult even when the remotes reject).
 *
 * TRAP for anyone editing this file (same as coordinator-repo-solo-read-repair-window.spec.ts):
 * take the repeated reads INSIDE the window. A lapsed window is supposed to consult again, so a
 * probe that steps a full window between reads shows N consults before and after the fix alike.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, GetBlockResult,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev, ActionId, Transforms
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { createMesh, buildNetworkTransactor } from '../src/testing/mesh-harness.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog } from './support/capture-log.js';

const WINDOW_MS = 10_000;
const BASE_TIME = 1_000_000;

/** How many captured lines carry `tag`. */
const countTag = (captured: unknown[][], tag: string): number =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag)).length;

const captureCoordinatorLog = (fn: () => Promise<void>): Promise<unknown[][]> =>
	captureLog('coordinator-repo', fn);

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

const peerEntry = (peerId: PeerId): ClusterPeers[string] => ({
	multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
	publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
});

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers =>
	Object.fromEntries(peerIds.map(peerId => [peerId.toString(), peerEntry(peerId)]));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const blockOf = (id: BlockId) => ({ header: { id, type: 'T', collectionId: 'c' as BlockId } });

/** What this node's storage holds for a block: nothing, a committed revision, or a pending-only
 *  insert served through the pending overlay (content, no committed revision under it). */
type Holding = ActionRev | 'pending-only';

/**
 * A storage double whose holdings, and whose answer to a pend or commit, a spec can change
 * between reads. Pends and commits never change the holdings on their own — the specs that care
 * about the memo being cleared need the block to still be missing on the read that follows.
 */
const makeControllableStorage = (opts: { adoptFromContext?: boolean } = {}) => {
	const held = new Map<BlockId, Holding>();
	let pendAnswer: PendResult | Error = { success: true, pending: [], blockIds: [] };
	let commitAnswer: CommitResult | Error = { success: true };
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				// Models a local store the read-repair promotion lands in: a restoration context
				// naming a newer committed revision is adopted (see the same double in
				// coordinator-repo-unavailable.spec.ts).
				if (opts.adoptFromContext) {
					const current = held.get(id);
					const currentRev = typeof current === 'object' ? current.rev : undefined;
					const adopting = blockGets.context?.committed?.find(c => currentRev === undefined || c.rev > currentRev);
					if (adopting) held.set(id, adopting);
				}
				const holding = held.get(id);
				result[id] = holding === undefined ? { state: {} }
					: holding === 'pending-only' ? { block: blockOf(id), state: { pendings: ['p1'] } }
						: { block: blockOf(id), state: { latest: holding } };
			}
			return result;
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			if (pendAnswer instanceof Error) throw pendAnswer;
			return pendAnswer;
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			if (commitAnswer instanceof Error) throw commitAnswer;
			return commitAnswer;
		}
	};
	return {
		repo,
		hold: (id: BlockId, holding: Holding) => { held.set(id, holding); },
		drop: (id: BlockId) => { held.delete(id); },
		latestOf: (id: BlockId): ActionRev | undefined => {
			const holding = held.get(id);
			return typeof holding === 'object' ? holding : undefined;
		},
		answerPendWith: (answer: PendResult | Error) => { pendAnswer = answer; },
		answerCommitWith: (answer: CommitResult | Error) => { commitAnswer = answer; }
	};
};

/** How a remote cohort peer answers the latest-revision consult. */
type RemoteAnswer = 'nothing' | 'reject' | ActionRev;

/**
 * A coordinator over a cohort of this node plus `remoteCount` remote peers (0 = a cohort of one).
 * Everything a spec varies is live: `cluster` is re-read on every `findCluster`, `answers` on every
 * consult, the clock and RNG on every read.
 */
const buildHarness = async (opts: {
	remoteCount: number;
	mode?: 'off' | 'lazy' | 'paranoid';
	sampleRate?: number;
	adoptFromContext?: boolean;
}) => {
	const localPeer = await makePeerId();
	const remotes = await Promise.all(Array.from({ length: opts.remoteCount }, () => makePeerId()));
	const cluster = makeClusterPeers([localPeer, ...remotes]);
	const storage = makeControllableStorage({ adoptFromContext: opts.adoptFromContext });
	const answers = new Map<string, RemoteAnswer>();
	const calls: Array<{ peer: string; blockId: BlockId }> = [];
	let clock = BASE_TIME;
	let draw = 0.99;
	let findClusterCalls = 0;
	let findClusterThrows = false;
	let lookupTakesMs = 0;

	const keyNetwork: IKeyNetwork = {
		async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
			throw new Error('not implemented');
		},
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			findClusterCalls++;
			clock += lookupTakesMs;	// a slow cohort lookup moves the clock under the read
			if (findClusterThrows) throw new Error('cohort lookup failed');
			return { ...cluster };
		}
	};

	const callback: ClusterLatestCallback = async (peerId, blockId) => {
		calls.push({ peer: peerId.toString(), blockId });
		// This node's own answer reads the storage being repaired, as the production callback does.
		if (peerId.equals(localPeer)) return storage.latestOf(blockId);
		const answer = answers.get(peerId.toString()) ?? 'nothing';
		if (answer === 'reject') throw new Error('dial failed');
		return answer === 'nothing' ? undefined : answer;
	};

	const repo = new CoordinatorRepo(
		keyNetwork,
		makeClusterClient,
		storage.repo,
		{
			clusterSize: 3,
			readRepairMode: opts.mode ?? 'lazy',
			readRepairWindowMs: WINDOW_MS,
			readRepairSampleRate: opts.sampleRate ?? 0
		},
		undefined,
		localPeer,
		undefined,
		callback
	);
	repo.now = () => clock;
	repo.rand = () => draw;

	return {
		repo, localPeer, remotes, cluster, storage, answers,
		clock: () => clock,
		setClock: (t: number) => { clock = t; },
		setDraw: (r: number) => { draw = r; },
		failFindCluster: (fails: boolean) => { findClusterThrows = fails; },
		setLookupDuration: (ms: number) => { lookupTakesMs = ms; },
		findClusterCalls: () => findClusterCalls,
		/** Multi-peer consults of `blockId`: one self-addressed callback per consult. */
		consultsOf: (blockId: BlockId) => calls.filter(c => c.peer === localPeer.toString() && c.blockId === blockId).length,
		/** Callback invocations addressed to `peer`, for any block. */
		callsTo: (peer: PeerId) => calls.filter(c => c.peer === peer.toString()).length
	};
};

/** An authoritative absent: an entry, no content, no committed revision, and no doubt flag. */
const expectAuthoritativeAbsent = (entry: GetBlockResult | undefined, why: string): void => {
	expect(entry, why).to.not.equal(undefined);
	expect(entry!.state, why).to.deep.equal({});
	expect(entry!.block, why).to.equal(undefined);
	expect('unavailable' in entry!, `${why}: must not be flagged`).to.equal(false);
};

const pendInsert = (blockId: BlockId): PendRequest => ({
	actionId: 'action-1' as ActionId,
	policy: 'c',
	transforms: { inserts: { [blockId]: blockOf(blockId) }, updates: {}, deletes: [] } as unknown as Transforms
});

const commitOf = (blockId: BlockId): CommitRequest => ({
	actionId: 'action-1' as ActionId,
	blockIds: [blockId],
	tailId: blockId,
	rev: 1
});

describe('CoordinatorRepo absence window (a block this node does not hold)', () => {
	const blockId: BlockId = 'block-never-written';

	describe('cohort of one', () => {
		it('settles after one consult: nine reads of a never-written block inside one window consult once', async () => {
			// The gate. At HEAD before the fix this was 9 — `isMissing` bypassed the window entirely,
			// so every read re-ran the solo exit.
			const h = await buildHarness({ remoteCount: 0 });
			const results: GetBlockResults[] = [];

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 9; i++) {
					h.setClock(BASE_TIME + i * 1_000);	// reads 2..9 all land inside the 10s window
					results.push(await h.repo.get({ blockIds: [blockId] }));
				}
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
				'a settled absence skips its consult for the rest of the window').to.equal(1);
			results.forEach((r, i) => expectAuthoritativeAbsent(r[blockId], `read ${i + 1}`));
			// Not a stale-content decision, so it is not read-repair: the skip is silent, as the
			// held-block skip is — a per-read line would recreate the volume this removes.
			expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(0);
		});

		it('consults again once the window lapses', async () => {
			const h = await buildHarness({ remoteCount: 0 });

			const captured = await captureCoordinatorLog(async () => {
				await h.repo.get({ blockIds: [blockId] });		// consults, settles at BASE_TIME
				h.setClock(BASE_TIME + 1_000);
				await h.repo.get({ blockIds: [blockId] });		// inside the window — skipped
				h.setClock(BASE_TIME + WINDOW_MS + 1);
				await h.repo.get({ blockIds: [blockId] });		// lapsed — consults again
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(2);
		});

		it('the window runs from when the consult started, not when it finished', async () => {
			// The evidence is only as fresh as the consult's start, so a slow consult must not stretch
			// "confirmed within one window" by its own duration.
			const h = await buildHarness({ remoteCount: 0 });

			const captured = await captureCoordinatorLog(async () => {
				h.setLookupDuration(3_000);
				await h.repo.get({ blockIds: [blockId] });		// the consult's lookup is the read's last
				h.setLookupDuration(0);
				const consultStartedAt = h.clock() - 3_000;
				h.setClock(consultStartedAt + WINDOW_MS + 500);	// lapsed from the start, fresh from the end
				await h.repo.get({ blockIds: [blockId] });
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(2);
		});

		it('paranoid mode consults on every read', async () => {
			// "Verify every read" means every read, absences included.
			const h = await buildHarness({ remoteCount: 0, mode: 'paranoid' });

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 5; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					await h.repo.get({ blockIds: [blockId] });
				}
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(5);
		});

		it("'off' mode is windowed like 'lazy' — the absence consult is not stale-content repair", async () => {
			// `off` disables stale-content repair. Leaving the absence consult unbounded there would
			// make the mode meant to do LESS network work do more.
			const h = await buildHarness({ remoteCount: 0, mode: 'off' });

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 9; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					await h.repo.get({ blockIds: [blockId] });
				}
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);
		});

		it("'off' mode ignores the sample rate, as it does for held content", async () => {
			const h = await buildHarness({ remoteCount: 0, mode: 'off', sampleRate: 0.5 });
			h.setDraw(0.1);										// would force a check in 'lazy'

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 5; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					await h.repo.get({ blockIds: [blockId] });
				}
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);
		});

		it('a sample-rate draw inside the window still consults', async () => {
			const h = await buildHarness({ remoteCount: 0, sampleRate: 0.5 });

			const captured = await captureCoordinatorLog(async () => {
				await h.repo.get({ blockIds: [blockId] });		// settles
				h.setClock(BASE_TIME + 1_000);
				h.setDraw(0.1);									// below the sample rate: consult anyway
				await h.repo.get({ blockIds: [blockId] });
				h.setClock(BASE_TIME + 2_000);
				h.setDraw(0.9);									// above it: the window holds
				await h.repo.get({ blockIds: [blockId] });
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(2);
		});

		describe('a re-consult that does not settle forgets a memo that was still fresh', () => {
			// Only deleting the memo (not merely declining to re-stamp it) makes the next read consult,
			// because the original stamp is still inside its window.
			it('when it throws', async () => {
				const h = await buildHarness({ remoteCount: 0, sampleRate: 0.5 });

				const captured = await captureCoordinatorLog(async () => {
					await h.repo.get({ blockIds: [blockId] });	// settles at BASE_TIME
					h.setClock(BASE_TIME + 1_000);
					h.setDraw(0.1);								// sampled: consults despite the memo
					h.failFindCluster(true);
					const r = await h.repo.get({ blockIds: [blockId] });
					expect(r[blockId]?.unavailable).to.equal('peers-unreachable');
					h.failFindCluster(false);
					h.setClock(BASE_TIME + 2_000);
					h.setDraw(0.9);								// not sampled: only a live memo would skip
					await h.repo.get({ blockIds: [blockId] });
				});

				expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(2);
			});

			it('when it asked a cohort that had grown past this node', async () => {
				const h = await buildHarness({ remoteCount: 0, sampleRate: 0.5 });
				const newPeer = await makePeerId();

				const captured = await captureCoordinatorLog(async () => {
					await h.repo.get({ blockIds: [blockId] });	// settles at BASE_TIME
					Object.assign(h.cluster, makeClusterPeers([newPeer]));
					h.setClock(BASE_TIME + 1_000);
					h.setDraw(0.1);								// sampled: the two-member cohort answers "nothing"
					expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], 'grown cohort');
					delete h.cluster[newPeer.toString()];		// back to a cohort of one
					h.setClock(BASE_TIME + 2_000);
					h.setDraw(0.9);
					await h.repo.get({ blockIds: [blockId] });
				});

				expect(h.callsTo(newPeer), 'the sampled read asked the grown cohort').to.equal(1);
				expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
					'a multi-peer answer settles nothing, and deleted the memo').to.equal(2);
			});
		});

		describe('a local write of the block clears the memo, whatever its outcome', () => {
			// A pend refused because the block already exists somewhere is the strongest evidence
			// there is that the memo was wrong: the writer's retry re-reads, and that read must
			// consult rather than serve the memo's authoritative absent for the rest of the window.
			const writeThenRead = async (write: (h: Awaited<ReturnType<typeof buildHarness>>) => Promise<unknown>) => {
				const h = await buildHarness({ remoteCount: 0 });
				const captured = await captureCoordinatorLog(async () => {
					await h.repo.get({ blockIds: [blockId] });	// settles at BASE_TIME
					h.setClock(BASE_TIME + 1_000);
					await write(h).catch(() => undefined);
					h.setClock(BASE_TIME + 2_000);				// still well inside the original window
					await h.repo.get({ blockIds: [blockId] });
				});
				return countTag(captured, 'cluster-fetch:solo-self-skip');
			};

			it('a pend that succeeds', async () => {
				expect(await writeThenRead(h => h.repo.pend(pendInsert(blockId)))).to.equal(2);
			});

			it('a pend that is refused', async () => {
				expect(await writeThenRead(h => {
					h.storage.answerPendWith({ success: false, reason: 'block already exists' });
					return h.repo.pend(pendInsert(blockId));
				})).to.equal(2);
			});

			it('a pend that throws', async () => {
				expect(await writeThenRead(h => {
					h.storage.answerPendWith(new Error('storage fault'));
					return h.repo.pend(pendInsert(blockId));
				})).to.equal(2);
			});

			it('a commit that succeeds', async () => {
				expect(await writeThenRead(h => h.repo.commit(commitOf(blockId)))).to.equal(2);
			});

			it('a commit that is refused', async () => {
				expect(await writeThenRead(h => {
					h.storage.answerCommitWith({ success: false, reason: 'stale' });
					return h.repo.commit(commitOf(blockId));
				})).to.equal(2);
			});
		});

		it('a block that turns up locally retires the memo — the delete, not the timestamp', async () => {
			const h = await buildHarness({ remoteCount: 0 });
			let served: GetBlockResults = {};

			const captured = await captureCoordinatorLog(async () => {
				await h.repo.get({ blockIds: [blockId] });		// absent: settles at BASE_TIME
				h.storage.hold(blockId, { actionId: 'arrived', rev: 1 });
				h.setClock(BASE_TIME + 1_000);
				served = await h.repo.get({ blockIds: [blockId] });	// present: served locally, memo dropped
				h.storage.drop(blockId);
				h.setClock(BASE_TIME + 2_000);					// still inside the ORIGINAL window
				await h.repo.get({ blockIds: [blockId] });		// missing again: must consult
			});

			expect(served[blockId]?.state?.latest?.rev, 'the arrived block is served').to.equal(1);
			expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
				'seeing the block present deleted the memo, so the next absence consults').to.equal(2);
		});

		it('a cohort that grows inside a settled window is not asked until the window lapses (accepted tradeoff)', async () => {
			// Mirrors the held-block solo spec's growth case, pinned so it is not rediscovered as a bug:
			// the solo consult can only claim that re-asking sooner than one window learns nothing the
			// next `findCluster` would not. A cohort of one about to stop being one costs one window.
			const h = await buildHarness({ remoteCount: 0 });
			const newPeer = await makePeerId();

			await h.repo.get({ blockIds: [blockId] });			// settles
			Object.assign(h.cluster, makeClusterPeers([newPeer]));

			h.setClock(BASE_TIME + 1_000);
			await h.repo.get({ blockIds: [blockId] });
			expect(h.callsTo(newPeer), 'inside the window: not asked').to.equal(0);

			h.setClock(BASE_TIME + WINDOW_MS + 1);
			await h.repo.get({ blockIds: [blockId] });
			expect(h.callsTo(newPeer), 'past the window: the grown cohort is asked').to.equal(1);
		});

		it('a pending-only insert inside a settled window is served as content, unflagged, with no consult', async () => {
			const h = await buildHarness({ remoteCount: 0 });
			let served: GetBlockResults = {};

			const captured = await captureCoordinatorLog(async () => {
				await h.repo.get({ blockIds: [blockId] });		// settles
				h.storage.hold(blockId, 'pending-only');		// e.g. another coordinator's pend landed here
				h.setClock(BASE_TIME + 1_000);
				served = await h.repo.get({ blockIds: [blockId] });
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);
			expect(served[blockId]?.block?.header.id, 'the pending content is served').to.equal(blockId);
			expect('unavailable' in served[blockId]!, 'content is never an unconfirmed absence').to.equal(false);
		});

		it('skipClusterFetch reads never consult and never stamp', async () => {
			const h = await buildHarness({ remoteCount: 0 });

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 5; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					const r = await h.repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as MessageOptions);
					expectAuthoritativeAbsent(r[blockId], `sync read ${i + 1}`);
				}
				h.setClock(BASE_TIME + 5_000);
				await h.repo.get({ blockIds: [blockId] });		// the first plain read still consults
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
				'a sync read left no memo behind for the plain read to skip on').to.equal(1);
		});

		it('multi-block get: only the block whose absence is unsettled consults', async () => {
			const heldFresh: BlockId = 'block-held-fresh';
			const settledAbsent: BlockId = 'block-settled-absent';
			const unsettledAbsent: BlockId = 'block-unsettled-absent';
			const h = await buildHarness({ remoteCount: 0 });
			h.storage.hold(heldFresh, { actionId: 'local-action', rev: 1 });
			h.repo.setLastSeenForTest(heldFresh, BASE_TIME);
			let r: GetBlockResults = {};

			const captured = await captureCoordinatorLog(async () => {
				await h.repo.get({ blockIds: [settledAbsent] });	// settles that one alone
				h.setClock(BASE_TIME + 1_000);
				r = await h.repo.get({ blockIds: [heldFresh, settledAbsent, unsettledAbsent] });
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
				'the settling read, then the unsettled block alone').to.equal(2);
			expect(r[heldFresh]?.state?.latest?.rev).to.equal(1);
			expectAuthoritativeAbsent(r[settledAbsent], 'settled');
			expectAuthoritativeAbsent(r[unsettledAbsent], 'just settled by this read');
		});
	});

	describe('three-member cohort: an absence is never remembered', () => {
		it('the whole cohort answering "nothing" still consults on every read', async () => {
			// The regression gate for the multi-peer memo: this node takes part in other coordinators'
			// writes as a cohort member without passing through its own coordinator, and a commit
			// acknowledged at super-majority reaches the remaining members in the background. A memo
			// here served a writer's own create as absent (fresh-node-ddl-multi Scenario B, 5 of 20).
			const h = await buildHarness({ remoteCount: 2 });
			for (let i = 0; i < 9; i++) {
				h.setClock(BASE_TIME + i * 1_000);
				const r = await h.repo.get({ blockIds: [blockId] });
				expectAuthoritativeAbsent(r[blockId], `read ${i + 1}`);
			}
			expect(h.consultsOf(blockId)).to.equal(9);
		});

		it('a creation elsewhere is seen on the very next read', async () => {
			const h = await buildHarness({ remoteCount: 2, adoptFromContext: true });

			expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], 'before the create');
			for (const remote of h.remotes) h.answers.set(remote.toString(), { actionId: 'remote-action', rev: 2 });

			h.setClock(BASE_TIME + 1_000);
			const after = await h.repo.get({ blockIds: [blockId] });
			expect(h.consultsOf(blockId)).to.equal(2);
			expect(after[blockId]?.state?.latest?.rev, 'restored').to.equal(2);
			expect('unavailable' in after[blockId]!).to.equal(false);
		});

		// Everything below is a guess, or a positive "it exists": each read consults and is flagged,
		// exactly as before the memo existed.
		const everyReadFlagged = async (
			h: Awaited<ReturnType<typeof buildHarness>>,
			expectedFlag: string,
			reads = 5
		) => {
			for (let i = 0; i < reads; i++) {
				h.setClock(BASE_TIME + i * 1_000);
				const r = await h.repo.get({ blockIds: [blockId] });
				expect(r[blockId]?.unavailable, `read ${i + 1}`).to.equal(expectedFlag);
			}
		};

		it('partial silence: every read consults and is flagged peers-unreachable', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), 'reject');
			await everyReadFlagged(h, 'peers-unreachable');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('total silence: every read consults and is flagged cohort-unreachable', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), 'reject');
			h.answers.set(h.remotes[1]!.toString(), 'reject');
			await everyReadFlagged(h, 'cohort-unreachable');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a lone claim the quorum declines: claimed-elsewhere on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), { actionId: 'remote-action', rev: 2 });
			await everyReadFlagged(h, 'claimed-elsewhere');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a corroborated claim this node cannot acquire: claimed-elsewhere on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			for (const remote of h.remotes) h.answers.set(remote.toString(), { actionId: 'remote-action', rev: 2 });
			await everyReadFlagged(h, 'claimed-elsewhere');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a consult that throws: peers-unreachable on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.failFindCluster(true);
			const captured = await captureCoordinatorLog(() => everyReadFlagged(h, 'peers-unreachable'));
			expect(countTag(captured, 'cluster-fetch:error'), 'every read attempted its consult').to.equal(5);
		});

		it('an empty cohort: every read repeats its cohort lookup', async () => {
			// A routing failure, not an answer — same reasoning as the NOTE at that exit about not
			// arming the read-repair window.
			const h = await buildHarness({ remoteCount: 2 });
			for (const id of Object.keys(h.cluster)) delete h.cluster[id];

			const first = await h.repo.get({ blockIds: [blockId] });
			expectAuthoritativeAbsent(first[blockId], 'an empty cohort confirms by default');
			// The responsibility check caches its own lookup, so from here each read costs exactly
			// the consult's lookup — or nothing, if the absence had been remembered.
			const before = h.findClusterCalls();
			for (let i = 1; i <= 8; i++) {
				h.setClock(BASE_TIME + i * 1_000);
				await h.repo.get({ blockIds: [blockId] });
			}
			expect(h.findClusterCalls() - before, 'one consult lookup per read').to.equal(8);
		});
	});

	describe('through the real transactor on a 1-node mesh', () => {
		it('N reads of a never-written block inside one window consult once', async () => {
			// The gate at the layer shipped code runs: `createMesh` builds its coordinators through the
			// production `coordinatorRepo(...)` factory, so the memo is live here with no harness work.
			const mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
			const coordinator = mesh.nodes[0]!.coordinatorRepo;
			let clock = BASE_TIME;
			coordinator.now = () => clock;
			const transactor = buildNetworkTransactor(mesh, { timeoutMs: 3_000, abortOrCancelTimeoutMs: 3_000 });
			const results: GetBlockResults[] = [];
			const N = 9;

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < N; i++) {
					clock = BASE_TIME + i * 1_000;
					results.push(await transactor.get({ blockIds: [blockId] }));
				}
			});

			expect(countTag(captured, 'cluster-fetch:solo-self-skip'), `consults across ${N} absent reads`).to.equal(1);
			results.forEach((r, i) => expect(r[blockId], `read ${i + 1}`).to.deep.equal({ state: {} }));
		});
	});
});
