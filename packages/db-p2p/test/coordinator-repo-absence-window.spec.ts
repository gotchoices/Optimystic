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
 * The fix gives an absence the same freshness window content already gets, with the same
 * guarantee: a missing block skips its consult only when an earlier consult, within the last
 * window, SETTLED its absence — reached every cohort member it could ask, heard no claim, and
 * rested on a real cohort view. Anything weaker (silence, a claim, a thrown consult, an empty
 * cohort) is never remembered, so those reads keep consulting and keep carrying their
 * `unavailable` flag exactly as before.
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
	let findClusterCalls = 0;
	let findClusterThrows = false;

	const keyNetwork: IKeyNetwork = {
		async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
			throw new Error('not implemented');
		},
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			findClusterCalls++;
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
	let clock = BASE_TIME;
	let draw = 0.99;
	repo.now = () => clock;
	repo.rand = () => draw;

	return {
		repo, localPeer, remotes, cluster, storage, answers,
		setClock: (t: number) => { clock = t; },
		setDraw: (r: number) => { draw = r; },
		failFindCluster: (fails: boolean) => { findClusterThrows = fails; },
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

		it('a cohort that grows inside a settled window is not asked until the window lapses', async () => {
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
	});

	describe('three-member cohort', () => {
		it('the whole cohort answering "nothing" settles for one window (the new-collection probe, windowed)', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			for (let i = 0; i < 9; i++) {
				h.setClock(BASE_TIME + i * 1_000);
				const r = await h.repo.get({ blockIds: [blockId] });
				expectAuthoritativeAbsent(r[blockId], `read ${i + 1}`);
			}
			expect(h.consultsOf(blockId)).to.equal(1);
		});

		// Everything below must NEVER settle: each is a guess, or a positive "it exists", and
		// remembering it would let NetworkTransactor take the guess as final for a whole window.
		const neverSettles = async (
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

		it('partial silence never settles: every read consults and is flagged peers-unreachable', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), 'reject');
			await neverSettles(h, 'peers-unreachable');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('total silence never settles: every read consults and is flagged cohort-unreachable', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), 'reject');
			h.answers.set(h.remotes[1]!.toString(), 'reject');
			await neverSettles(h, 'cohort-unreachable');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a lone claim the quorum declines never settles: claimed-elsewhere on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.answers.set(h.remotes[0]!.toString(), { actionId: 'remote-action', rev: 2 });
			await neverSettles(h, 'claimed-elsewhere');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a corroborated claim this node cannot acquire never settles: claimed-elsewhere on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			for (const remote of h.remotes) h.answers.set(remote.toString(), { actionId: 'remote-action', rev: 2 });
			await neverSettles(h, 'claimed-elsewhere');
			expect(h.consultsOf(blockId)).to.equal(5);
		});

		it('a consult that throws never settles: peers-unreachable on every read', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			h.failFindCluster(true);
			const captured = await captureCoordinatorLog(() => neverSettles(h, 'peers-unreachable'));
			expect(countTag(captured, 'cluster-fetch:error'), 'every read attempted its consult').to.equal(5);
		});

		it('an empty cohort never settles: every read repeats its cohort lookup', async () => {
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

		it('a settled absence whose next consult (after the lapse) is unconfirmed leaves no memo', async () => {
			const h = await buildHarness({ remoteCount: 2 });
			const peerA = h.remotes[0]!.toString();

			await h.repo.get({ blockIds: [blockId] });			// settles at BASE_TIME

			h.setClock(BASE_TIME + WINDOW_MS + 1);
			h.answers.set(peerA, 'reject');
			const unsettled = await h.repo.get({ blockIds: [blockId] });
			expect(unsettled[blockId]?.unavailable).to.equal('peers-unreachable');

			h.answers.set(peerA, 'nothing');
			h.setClock(BASE_TIME + WINDOW_MS + 2);				// inside the lapse-read's window
			await h.repo.get({ blockIds: [blockId] });
			expect(h.consultsOf(blockId), 'an unconfirmed consult stamps nothing').to.equal(3);
		});

		it('a settled absence whose sampled re-consult is unconfirmed is forgotten, not left fresh', async () => {
			// The sharper form: here the memo from BASE_TIME would still be inside its window, so only
			// deleting it (not merely declining to re-stamp it) makes the next read consult.
			const h = await buildHarness({ remoteCount: 2, sampleRate: 0.5 });
			const peerA = h.remotes[0]!.toString();

			await h.repo.get({ blockIds: [blockId] });			// settles at BASE_TIME

			h.setClock(BASE_TIME + 1_000);
			h.setDraw(0.1);										// sampled: consults despite the memo
			h.answers.set(peerA, 'reject');
			expect((await h.repo.get({ blockIds: [blockId] }))[blockId]?.unavailable).to.equal('peers-unreachable');

			h.setClock(BASE_TIME + 2_000);
			h.setDraw(0.9);										// not sampled: only a live memo would skip
			h.answers.set(peerA, 'nothing');
			await h.repo.get({ blockIds: [blockId] });
			expect(h.consultsOf(blockId), 'the unconfirmed consult deleted the memo').to.equal(3);
		});

		it('a creation elsewhere inside the window reads as absent until the window lapses (accepted tradeoff)', async () => {
			// Pinned out loud, the way the held-block spec pins "costs at most one window when the
			// cohort later grows": a block created by a writer whose commit did not involve this node
			// is reported absent for up to one window after this node settled its absence. The same
			// bound a held block's content already has.
			const h = await buildHarness({ remoteCount: 2, adoptFromContext: true });

			await h.repo.get({ blockIds: [blockId] });			// settles at BASE_TIME
			for (const remote of h.remotes) h.answers.set(remote.toString(), { actionId: 'remote-action', rev: 2 });

			h.setClock(BASE_TIME + 1_000);
			expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], 'inside the window');
			expect(h.consultsOf(blockId)).to.equal(1);

			h.setClock(BASE_TIME + WINDOW_MS + 1);
			const after = await h.repo.get({ blockIds: [blockId] });
			expect(h.consultsOf(blockId), 'past the window: consulted').to.equal(2);
			expect(after[blockId]?.state?.latest?.rev, 'and restored').to.equal(2);
			expect('unavailable' in after[blockId]!).to.equal(false);
		});

		it('multi-block get: only the block whose absence is unsettled consults', async () => {
			const heldFresh: BlockId = 'block-held-fresh';
			const settledAbsent: BlockId = 'block-settled-absent';
			const unsettledAbsent: BlockId = 'block-unsettled-absent';
			const h = await buildHarness({ remoteCount: 2 });
			h.storage.hold(heldFresh, { actionId: 'local-action', rev: 1 });
			h.repo.setLastSeenForTest(heldFresh, BASE_TIME);

			await h.repo.get({ blockIds: [settledAbsent] });	// settles that one alone
			h.setClock(BASE_TIME + 1_000);
			const r = await h.repo.get({ blockIds: [heldFresh, settledAbsent, unsettledAbsent] });

			expect(h.consultsOf(heldFresh), 'held and checked recently').to.equal(0);
			expect(h.consultsOf(settledAbsent), 'only the settling read').to.equal(1);
			expect(h.consultsOf(unsettledAbsent), 'never settled').to.equal(1);
			expect(r[heldFresh]?.state?.latest?.rev).to.equal(1);
			expectAuthoritativeAbsent(r[settledAbsent], 'settled');
			expectAuthoritativeAbsent(r[unsettledAbsent], 'just settled by this read');
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
