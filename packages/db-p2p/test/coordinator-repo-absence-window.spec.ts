/**
 * Tickets: a-block-we-do-not-hold-is-consulted-on-every-read (GitHub issue #8), revised by
 * drop-the-settled-absence-memo (GitHub issue #20)
 *
 * `CoordinatorRepo.get` consults a block's cohort for two reasons: the block is MISSING locally,
 * or it is held but the lazy read-repair window says it may be stale. The second trigger is bounded
 * to one consult per `readRepairWindowMs`; the first is deliberately not bounded at all.
 *
 * Issue #8 measured a never-written `Revocation` collection costing two consults per control-plane
 * call, and for a while a coordinator remembered a settled absence for one window — first on any
 * cohort, then only on a cohort of one. Both memos served a just-written block as never created:
 * the multi-peer one through a lagging cohort member (fresh-node-ddl-multi Scenario B), the solo one
 * through a node whose self-only view grew (issue #20; see
 * coordinator-repo-absence-write-bypass.spec.ts). So an absence is never remembered. On a cohort of
 * one a consult is a single cohort lookup that asks nobody, and what stays bounded is its log line,
 * `cluster-fetch:solo-self-skip`, written once per block per window for a block this node does not
 * hold. See backlog feat-a-cohort-member-remembers-a-settled-absence.
 *
 * Consults are counted by `findCluster` lookups on a cohort of one (the proximity check caches its
 * own lookup per block, so after a block's first read each consult costs exactly one; the log line
 * is rate-limited and no longer counts consults) and by the cluster-latest callback's invocations
 * addressed to THIS node on a multi-peer cohort (a real consult always asks every cohort member,
 * self included, so that is exactly one per consult even when the remotes reject).
 *
 * TRAP for anyone editing this file: take the repeated reads INSIDE the window. The log line is
 * supposed to repeat once a window lapses, so a probe that steps a full window between reads shows
 * one line per read with or without the rate limit.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, GetBlockResult,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev
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

/** A storage double whose holdings a spec can change between reads. Pends and commits succeed and
 *  change nothing — no case here writes through the coordinator. */
const makeControllableStorage = (opts: { adoptFromContext?: boolean } = {}) => {
	const held = new Map<BlockId, Holding>();
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
			return { success: true, pending: [], blockIds: [] };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			return { success: true };
		}
	};
	return {
		repo,
		hold: (id: BlockId, holding: Holding) => { held.set(id, holding); },
		latestOf: (id: BlockId): ActionRev | undefined => {
			const holding = held.get(id);
			return typeof holding === 'object' ? holding : undefined;
		}
	};
};

/** How a remote cohort peer answers the latest-revision consult. */
type RemoteAnswer = 'nothing' | 'reject' | ActionRev;

/**
 * A coordinator over a cohort of this node plus `remoteCount` remote peers (0 = a cohort of one).
 * Everything a spec varies is live: `cluster` is re-read on every `findCluster`, `answers` on every
 * consult, the clock on every read.
 */
const buildHarness = async (opts: {
	remoteCount: number;
	mode?: 'off' | 'lazy' | 'paranoid';
	adoptFromContext?: boolean;
}) => {
	const localPeer = await makePeerId();
	const remotes = await Promise.all(Array.from({ length: opts.remoteCount }, () => makePeerId()));
	const cluster = makeClusterPeers([localPeer, ...remotes]);
	const storage = makeControllableStorage({ adoptFromContext: opts.adoptFromContext });
	const answers = new Map<string, RemoteAnswer>();
	const calls: Array<{ peer: string; blockId: BlockId }> = [];
	let clock = BASE_TIME;
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
			readRepairSampleRate: 0
		},
		undefined,
		localPeer,
		undefined,
		callback
	);
	repo.now = () => clock;

	return {
		repo, localPeer, remotes, cluster, storage, answers,
		setClock: (t: number) => { clock = t; },
		failFindCluster: (fails: boolean) => { findClusterThrows = fails; },
		/** Every cohort lookup. `get`'s proximity check caches its own per block, so after a block's
		 *  first read each consult of it costs exactly one. */
		findClusterCalls: () => findClusterCalls,
		/** Cluster-latest callback invocations, any peer, any block. */
		callbackCalls: () => calls.length,
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

describe('CoordinatorRepo absence consults (a block this node does not hold)', () => {
	const blockId: BlockId = 'block-never-written';

	describe('cohort of one', () => {
		it('nine reads of a never-written block inside one window: nine consults, one log line, nine unflagged absents', async () => {
			// The cost model with nothing remembered: every read consults, and on a cohort of one a
			// consult is one cohort lookup and the solo-self exit, which asks nobody. What stays bounded
			// is the log line — issue #8's volume was lines, and the lookup measures 0.009 ms.
			const h = await buildHarness({ remoteCount: 0 });
			const results: GetBlockResults[] = [];

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i < 9; i++) {
					h.setClock(BASE_TIME + i * 1_000);	// reads 2..9 all land inside the 10s window
					results.push(await h.repo.get({ blockIds: [blockId] }));
				}
			});

			results.forEach((r, i) => expectAuthoritativeAbsent(r[blockId], `read ${i + 1}`));
			expect(h.findClusterCalls(), 'the proximity check (cached) plus one consult lookup per read').to.equal(1 + 9);
			expect(h.callbackCalls(), 'a cohort of one asks nobody').to.equal(0);
			expect(countTag(captured, 'cluster-fetch:solo-self-skip'), 'rate-limited to once per window').to.equal(1);
			// Not a stale-content decision, so it is not read-repair.
			expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(0);
		});

		it('a block read continuously is named once per window, not once per burst', async () => {
			// The rate limit runs off the stamp the solo-self exit sets only when it logs, so a node still
			// answering a hot block from a self-only view keeps saying so each time a window lapses.
			const h = await buildHarness({ remoteCount: 0 });

			const captured = await captureCoordinatorLog(async () => {
				for (let i = 0; i <= 25; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					await h.repo.get({ blockIds: [blockId] });
				}
			});

			// Named at 0 s, 11 s and 22 s: each the first read more than one window after the last line.
			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(3);
			expect(h.findClusterCalls(), 'every read still consulted').to.equal(1 + 26);
		});

		it('every read-repair mode consults on every read of a missing block', async () => {
			// The memo once made `off` and `lazy` skip here while `paranoid` did not. With nothing
			// remembered, the mode says nothing about absence.
			for (const mode of ['off', 'lazy', 'paranoid'] as const) {
				const h = await buildHarness({ remoteCount: 0, mode });
				for (let i = 0; i < 5; i++) {
					h.setClock(BASE_TIME + i * 1_000);
					expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], `${mode} read ${i + 1}`);
				}
				expect(h.findClusterCalls(), `${mode}: one consult lookup per read`).to.equal(1 + 5);
			}
		});

		it('a cohort that grows inside the window is asked on the very next read', async () => {
			// The inverse of the memo's accepted tradeoff ("not asked until the window lapses"), which is
			// how issue #20 served a block the grown cohort held as never created.
			const h = await buildHarness({ remoteCount: 0 });
			const newPeer = await makePeerId();

			expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], 'alone: nothing exists');
			Object.assign(h.cluster, makeClusterPeers([newPeer]));
			h.answers.set(newPeer.toString(), { actionId: 'remote-action', rev: 1 });

			h.setClock(BASE_TIME + 1_000);
			const after = await h.repo.get({ blockIds: [blockId] });
			expect(h.callsTo(newPeer), 'inside the window: asked').to.equal(1);
			expect(after[blockId]?.unavailable, 'its claim is surfaced, not hidden behind an absent').to.equal('claimed-elsewhere');
		});

		it('a pending-only insert is served as content, unflagged', async () => {
			const h = await buildHarness({ remoteCount: 0 });

			expectAuthoritativeAbsent((await h.repo.get({ blockIds: [blockId] }))[blockId], 'before the pend');
			h.storage.hold(blockId, 'pending-only');		// e.g. another coordinator's pend landed here
			h.setClock(BASE_TIME + 1_000);
			const lookupsBefore = h.findClusterCalls();
			const served = await h.repo.get({ blockIds: [blockId] });

			expect(h.findClusterCalls() - lookupsBefore, 'no committed revision, so it consults').to.equal(1);
			expect(served[blockId]?.block?.header.id, 'the pending content is served').to.equal(blockId);
			expect('unavailable' in served[blockId]!, 'content is never an unconfirmed absence').to.equal(false);
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
		it('N reads of a never-written block inside one window name it once and answer an unflagged absent each time', async () => {
			// The layer shipped code runs: `createMesh` builds its coordinators through the production
			// `coordinatorRepo(...)` factory. Every read consults; the solo-self line is what stays
			// bounded.
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

			expect(countTag(captured, 'cluster-fetch:solo-self-skip'), `solo-self lines across ${N} absent reads`).to.equal(1);
			results.forEach((r, i) => expect(r[blockId], `read ${i + 1}`).to.deep.equal({ state: {} }));
		});
	});
});
