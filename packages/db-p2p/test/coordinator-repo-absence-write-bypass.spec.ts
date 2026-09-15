/**
 * Tickets: a-node-reads-a-block-it-just-wrote-as-never-created (the reproduction) and
 * drop-the-settled-absence-memo (the fix) — GitHub issue #20
 *
 * Beta.3 let `CoordinatorRepo.get` remember a SETTLED absence for one `readRepairWindowMs`, armed
 * only at the solo-self exit of `fetchBlockFromCluster`, on the reasoning that when this node is the
 * block's whole cohort every acknowledged commit lands in its storage and the block reads present.
 * The memo was cleared by a pend or commit that THIS coordinator handled, and by `get` seeing the
 * block present.
 *
 * Issue #20: a node wrote a record through a remote coordinator and, 158 ms later, read the same
 * collection's header block as an unflagged absent through its own coordinator. Its cohort view
 * was self-only at times (peers connected but unidentified, `self-coord-allowed: extended-isolation`
 * throughout). These specs drive every write path that reaches this node's storage WITHOUT passing
 * through `CoordinatorRepo.pend/commit`, and every way the cohort view can change after this node
 * answered a read of the block from a self-only view.
 *
 * Each `it` asserts the INVARIANT: a node never serves an unflagged absent (a) after any write of
 * that block reached its storage, pending included, nor (b) on the strength of a cohort view that
 * is no longer the current one. Seven of these cases failed at beta.3 — four unit cases and all
 * three mesh cases, deterministic over three runs — and all seven passed with the memo disabled on
 * the reading node, so the memo was the cause and was removed. They stay as the gate any future
 * absence memo must pass (backlog feat-a-cohort-member-remembers-a-settled-absence). The cases
 * marked "self-heals" passed at beta.3 too and pin the paths that never needed a change.
 *
 * Storage is REAL (`StorageRepo` over `MemoryRawStorage`), so a member pend lands as a genuine
 * pending-only record and `StorageRepo.get` reports it exactly as production does (`{ state: {} }`
 * with no context). The cluster-member write path (`ClusterRepo.applyConsensusOperation`) calls
 * `storageRepo.pend` / `storageRepo.commit` directly, which is what the unit tier does here; the
 * mesh tier at the bottom drives the real member through a real coordinator.
 *
 * Consults are counted by cohort lookups (`findCluster`), not by `cluster-fetch:solo-self-skip`
 * lines: that line is rate-limited to once per block per window for a block this node does not
 * hold, so it no longer appears once per consult.
 *
 * TRAP (same as the sibling absence specs): keep every read INSIDE ten seconds of the first probe,
 * the window a memo would use. A memo that has lapsed passes every case here, which proves nothing.
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IKeyNetwork, ClusterPeers, GetBlockResult, BlockId, ActionId, ActionRev, Transforms, IBlock, ITransactor
} from '@optimystic/db-core';
import { Tree } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type AcquireBlockCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog } from './support/capture-log.js';

const WINDOW_MS = 10_000;
const BASE_TIME = 1_000_000;

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

const blockOf = (id: BlockId): IBlock => ({ header: { id, type: 'T', collectionId: 'c' as BlockId } });

const insertOf = (blockId: BlockId): Transforms =>
	({ inserts: { [blockId]: blockOf(blockId) }, updates: {}, deletes: [] } as unknown as Transforms);

const makeStorage = () => {
	const raw = new MemoryRawStorage();
	return new StorageRepo((id: BlockId) => new BlockStorage(id, raw));
};

/** Pend + commit `blockId` at rev 1 straight into `storage` — what a cohort member does for a
 *  write coordinated elsewhere, in two steps so a spec can stop between them. */
const memberPend = (storage: StorageRepo, blockId: BlockId, actionId = 'remote-action' as ActionId) =>
	storage.pend({ actionId, policy: 'c', transforms: insertOf(blockId) });
const memberCommit = (storage: StorageRepo, blockId: BlockId, actionId = 'remote-action' as ActionId) =>
	storage.commit({ actionId, blockIds: [blockId], tailId: blockId, rev: 1 });
const commitElsewhere = async (storage: StorageRepo, blockId: BlockId): Promise<void> => {
	expect((await memberPend(storage, blockId)).success).to.equal(true);
	expect((await memberCommit(storage, blockId)).success).to.equal(true);
};

/** An unflagged absent — the answer `NetworkTransactor.get` treats as final. */
const isUnflaggedAbsent = (entry: GetBlockResult | undefined): boolean =>
	entry !== undefined && entry.state?.latest === undefined && entry.block === undefined && !('unavailable' in entry);

const expectNotStaleAbsent = (entry: GetBlockResult | undefined, why: string): void => {
	expect(isUnflaggedAbsent(entry), `${why}: served an unflagged absent (${JSON.stringify(entry)})`).to.equal(false);
};

/**
 * This node's coordinator over REAL storage, with remote cohort members that are also real
 * storages. The cohort view (`cluster`) is live: every `findCluster` re-reads it.
 */
const buildHarness = async (remoteCount: number) => {
	const localPeer = await makePeerId();
	const remotes = await Promise.all(Array.from({ length: remoteCount }, () => makePeerId()));
	const storage = makeStorage();
	const remoteStorage = new Map<string, StorageRepo>(remotes.map(p => [p.toString(), makeStorage()]));
	const cluster: ClusterPeers = { [localPeer.toString()]: peerEntry(localPeer) };
	const calls: Array<{ peer: string; blockId: BlockId }> = [];
	let clock = BASE_TIME;
	let lookupGate: { gate: Promise<void>; onCall: number } | undefined;
	let findClusterCalls = 0;

	const keyNetwork: IKeyNetwork = {
		async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
			throw new Error('not implemented');
		},
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			findClusterCalls++;
			if (lookupGate && findClusterCalls === lookupGate.onCall) {
				const { gate } = lookupGate;
				lookupGate = undefined;
				await gate;
			}
			return { ...cluster };
		}
	};

	const latestIn = async (repo: StorageRepo, blockId: BlockId): Promise<ActionRev | undefined> =>
		(await repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any))[blockId]?.state?.latest;

	const callback: ClusterLatestCallback = async (peerId, blockId) => {
		calls.push({ peer: peerId.toString(), blockId });
		const repo = peerId.equals(localPeer) ? storage : remoteStorage.get(peerId.toString());
		return repo ? latestIn(repo, blockId) : undefined;
	};

	// The read path's transfer: copy the corroborated revision's bytes from any remote that holds it.
	const acquire: AcquireBlockCallback = async (blockId, committed, cohortPeerIds) => {
		for (const id of cohortPeerIds) {
			const repo = remoteStorage.get(id);
			if (!repo) continue;
			const entry = (await repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as any))[blockId];
			if (entry?.block && entry.state?.latest?.rev === committed.rev) {
				await storage.saveReplicatedBlock(blockId, entry.block, committed);
				return;
			}
		}
		throw new Error('no remote holds the corroborated revision');
	};

	const repo = new CoordinatorRepo(
		keyNetwork,
		((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient,
		storage,
		{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
		undefined,
		localPeer,
		undefined,
		callback,
		undefined,
		undefined,
		acquire
	);
	repo.now = () => clock;

	return {
		repo, localPeer, remotes, storage, remoteStorage, cluster,
		setClock: (t: number) => { clock = t; },
		/** The `onCall`-th `findCluster` (1-based, counted from harness creation) blocks until `gate`
		 *  resolves — a slow cohort lookup at one chosen point; every other lookup is instant. */
		gateLookups: (gate: Promise<void>, onCall: number) => { lookupGate = { gate, onCall }; },
		growCohort: () => { for (const p of remotes) cluster[p.toString()] = peerEntry(p); },
		shrinkToSelf: () => { for (const p of remotes) delete cluster[p.toString()]; },
		callsTo: (peer: PeerId) => calls.filter(c => c.peer === peer.toString()).length,
		/** Every cohort lookup since the harness was built. `get`'s proximity check caches its own
		 *  lookup per block, so a read of a block already read once costs exactly one lookup when it
		 *  consults and none when it does not. */
		findClusterCalls: () => findClusterCalls,
		read: (blockId: BlockId) => repo.get({ blockIds: [blockId] })
	};
};

type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** The read that armed beta.3's memo: one read of a missing block on a self-only cohort view, at
 *  BASE_TIME. It consults (the solo-self exit, which names the block) and answers an authoritative
 *  absent. */
const probeAlone = async (h: Harness, blockId: BlockId): Promise<void> => {
	h.setClock(BASE_TIME);
	const captured = await captureCoordinatorLog(async () => {
		expect(isUnflaggedAbsent((await h.read(blockId))[blockId]), 'the probe is an authoritative absent').to.equal(true);
	});
	expect(countTag(captured, 'cluster-fetch:solo-self-skip'), 'answered at the solo-self exit').to.equal(1);
};

/** Cohort lookups made while `fn` runs. */
const lookupsDuring = async (h: Harness, fn: () => Promise<unknown>): Promise<number> => {
	const before = h.findClusterCalls();
	await fn();
	return h.findClusterCalls() - before;
};

describe('CoordinatorRepo never serves a stale absent after a write that bypassed it (issue #20)', () => {
	const blockId: BlockId = 'block-created-elsewhere';

	describe('unit: the cohort view stays self-only', () => {
		it('a cohort-member pend lands inside the window and the next read consults', async () => {
			// `ClusterRepo.applyConsensusOperation` calls `storageRepo.pend` directly, so no clearing hook
			// in `CoordinatorRepo` could see it, and at beta.3 the next read served the memo. On a
			// self-only view the ANSWER is the same absent either way; what this pins is that the read
			// consulted, which is what lets the cases below see a grown cohort.
			const h = await buildHarness(0);
			await probeAlone(h, blockId);
			h.setClock(BASE_TIME + 1_000);
			expect((await memberPend(h.storage, blockId)).success).to.equal(true);
			h.setClock(BASE_TIME + 2_000);

			let lookups = 0;
			const captured = await captureCoordinatorLog(async () => {
				lookups = await lookupsDuring(h, () => h.read(blockId));
			});
			expect(lookups, 'a write that reached this storage must not stop the next read consulting').to.equal(1);
			// The solo-self line is rate-limited to once per block per window, so across the probe and
			// this read there is ONE line — the probe's.
			expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
				'rate-limited: the probe already named this block inside the window').to.equal(0);
		});

		it('self-heals: a member pend followed by a member commit reads present', async () => {
			const h = await buildHarness(0);
			await probeAlone(h, blockId);
			h.setClock(BASE_TIME + 1_000);
			await commitElsewhere(h.storage, blockId);
			h.setClock(BASE_TIME + 2_000);
			const r = await h.read(blockId);
			expect(r[blockId]?.state?.latest?.rev, 'present: served locally').to.equal(1);
		});

		it('self-heals: a certified push (saveReplicatedBlock) inside the window reads present', async () => {
			// Block-transfer push and read-driven restoration both land through `saveReplicatedBlock`.
			const h = await buildHarness(0);
			await probeAlone(h, blockId);
			h.setClock(BASE_TIME + 1_000);
			await h.storage.saveReplicatedBlock(blockId, blockOf(blockId), { actionId: 'pushed' as ActionId, rev: 1 });
			h.setClock(BASE_TIME + 2_000);
			const r = await h.read(blockId);
			expect(r[blockId]?.state?.latest?.rev, 'present: served locally').to.equal(1);
		});
	});

	describe('unit: the cohort view grows past this node inside the window', () => {
		it('(#20, item 1): this node holds a member pend, the coordinator committed it elsewhere, and the read does not serve absent', async () => {
			// The write's coordinator was a remote peer this node's view did not include when it probed.
			// It enrolled this node (pend landed here) and committed at a quorum of the members it could
			// see. By the time this node reads, its view includes those members.
			const h = await buildHarness(2);
			await probeAlone(h, blockId);
			h.setClock(BASE_TIME + 1_000);
			expect((await memberPend(h.storage, blockId)).success).to.equal(true);
			for (const remote of h.remoteStorage.values()) await commitElsewhere(remote, blockId);
			h.growCohort();
			h.setClock(BASE_TIME + 2_000);

			const r = await h.read(blockId);
			expect(h.callsTo(h.remotes[0]!), 'the grown cohort was asked').to.be.greaterThan(0);
			expectNotStaleAbsent(r[blockId], 'read inside the window after the view grew');
		});

		it('(#20, item 2): the write never reached this node, the view grows, and the read acquires it', async () => {
			// The coordinator saw a cohort that did not include this node at all (its own view was
			// self-only too, or this node was still unidentified to it). Nothing local happened, so
			// nothing local could have cleared a memo; only the current cohort can say the block exists.
			const h = await buildHarness(2);
			await probeAlone(h, blockId);
			h.setClock(BASE_TIME + 1_000);
			for (const remote of h.remoteStorage.values()) await commitElsewhere(remote, blockId);
			h.growCohort();
			h.setClock(BASE_TIME + 2_000);

			const r = await h.read(blockId);
			expect(h.callsTo(h.remotes[0]!), 'the grown cohort was asked').to.be.greaterThan(0);
			expectNotStaleAbsent(r[blockId], 'read inside the window after the view grew');
			expect(r[blockId]?.state?.latest?.rev, 'the corroborated revision was acquired').to.equal(1);
		});

		it('a view that grows and shrinks back to self-only asks no remote while it is self-only again', async () => {
			// Cost bound, stated in the currency that costs network work: a flapping view must not turn
			// reads on a self-only cohort into remote queries. Grown → one consult that asks the remotes;
			// back to self-only → nobody remote is asked, however many reads follow.
			const h = await buildHarness(2);
			await probeAlone(h, blockId);
			h.growCohort();
			h.setClock(BASE_TIME + 1_000);
			await h.read(blockId);
			const askedWhileGrown = h.callsTo(h.remotes[0]!);
			h.shrinkToSelf();
			for (let i = 2; i < 8; i++) {
				h.setClock(BASE_TIME + i * 1_000);
				await h.read(blockId);
			}
			expect(h.callsTo(h.remotes[0]!), 'no remote asked on a self-only view').to.equal(askedWhileGrown);
		});
	});

	describe('unit: a local write while the probing consult is in flight', () => {
		it('the next read still consults', async () => {
			// At beta.3 this was a bounded race named at the memo's stamp site: a `CoordinatorRepo.pend`
			// cleared the memo while a consult of the same block was mid-lookup, the consult's stamp then
			// re-armed it, and the writer's next read — the retry after a refused pend, say — skipped its
			// consult. With nothing remembered there is no stamp to race.
			const h = await buildHarness(0);
			let release!: () => void;
			// `get` looks the cohort up twice: the proximity check (1st call, then cached), and the
			// consult (2nd). Park the consult's lookup only, so the pend below can route.
			h.gateLookups(new Promise<void>(resolve => { release = resolve; }), 2);
			h.setClock(BASE_TIME);
			const inFlight = h.read(blockId);							// consult starts, parked in findCluster
			await new Promise(resolve => setImmediate(resolve));
			await h.repo.pend({ actionId: 'local-action' as ActionId, policy: 'c', transforms: insertOf(blockId) })
				.catch(() => undefined);								// a local write lands mid-consult (routing aside)
			release();
			await inFlight;												// the consult completes
			h.setClock(BASE_TIME + 1_000);

			expect(await lookupsDuring(h, () => h.read(blockId)),
				'a write that landed after the consult started must not stop the next read consulting').to.equal(1);
		});
	});

	describe('mesh: a real cohort member and a real remote coordinator', function () {
		this.timeout(15_000);
		const treeId = 'issue-20-tree';
		let mesh: Mesh;
		let nodeA: MeshNode;
		let nodeB: MeshNode;
		let coordinatorOverride: PeerId | undefined;
		let clock: number;

		const readThroughA = (id: BlockId) => nodeA.coordinatorRepo.get({ blockIds: [id] });

		beforeEach(async () => {
			clock = BASE_TIME;
			coordinatorOverride = undefined;
			mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3, superMajorityThreshold: 0.51 });
			nodeA = mesh.nodes[0]!;
			nodeB = mesh.nodes[1]!;
			nodeA.coordinatorRepo.now = () => clock;
			// The TRANSACTOR's routing view only (reassigned after `createMesh`, so every node's own
			// coordinator and member keep the real per-node view): the write is steered to a remote
			// coordinator (issue #20's `findCoordinator:done … source=cache`), the read to self. The
			// transactor routes a pend by `findCluster` (greedy cover over the cohort) and a read by
			// `findCoordinator`, so both are steered.
			const shared = mesh.keyNetwork;
			mesh.keyNetwork = {
				findCluster: async key => coordinatorOverride
					? { [coordinatorOverride.toString()]: (await shared.findCluster(key))[coordinatorOverride.toString()]! }
					: shared.findCluster(key),
				findCoordinator: (key, opts) => coordinatorOverride
					? Promise.resolve(coordinatorOverride)
					: shared.findCoordinator(key, opts)
			};
			// Node A sees itself alone: the harness analogue of `Libp2pKeyPeerNetwork.findCluster`
			// returning self-only while same-network peers are still unidentified or refused.
			mesh.failures.partitionSides = [new Set([nodeA.peerId.toString()])];
		});

		it('(#20): a tree written through B and read through A inside the window opens, with its row', async () => {
			const transactor: ITransactor = buildNetworkTransactor(mesh, { timeoutMs: 3_000, abortOrCancelTimeoutMs: 3_000 });
			const keyFn = (e: { key: number }) => e.key;

			// 1. A probe through A while its view is self-only — the read that armed beta.3's memo for
			//    the header block.
			coordinatorOverride = nodeA.peerId;
			const captured = await captureCoordinatorLog(async () => {
				expect(await Tree.open<number, { key: number }>(transactor, treeId, keyFn), 'nothing exists yet').to.equal(undefined);
			});
			expect(countTag(captured, 'cluster-fetch:solo-self-skip'), 'A answered from its self-only view').to.be.greaterThan(0);

			// 2. The create + write goes through B, which sees the full cohort {A, B, C} but cannot
			//    reach A (issue #19 on the same deployment: A's authorization gate refused the peers'
			//    traffic). B and C are a super-majority of three, so the write is acknowledged.
			coordinatorOverride = nodeB.peerId;
			mesh.failures.failingPeers = new Set([nodeA.peerId.toString()]);
			clock = BASE_TIME + 1_000;
			const tree = await Tree.createOrOpen<number, { key: number }>(transactor, treeId, keyFn);
			await tree.replace([[1, { key: 1 }]]);

			// 3. A's peers finish identifying and A accepts their traffic: its view now includes B and C.
			mesh.failures.partitionSides = undefined;
			mesh.failures.failingPeers = undefined;

			// 4. 158 ms later (well inside the window), a QUERY through A — `Tree.open`, which answers
			//    "no such tree" on an absent header, the way the reporter's query did. (Not
			//    `createOrOpen`: that would try to create through A, and at beta.3 that pend cleared A's
			//    memo and hid the defect. A query has no such write.)
			coordinatorOverride = nodeA.peerId;
			clock = BASE_TIME + 2_000;
			const readBack = await Tree.open<number, { key: number }>(transactor, treeId, keyFn);
			expect(readBack, 'the tree created through B opens through A').to.not.equal(undefined);
			expect(await readBack!.get(1), 'the row written through B is visible through A').to.deep.equal({ key: 1 });
		});

		it('(#20, item 2): a block committed on B and C while A saw itself alone reads present through A once A sees them', async () => {
			const headerId: BlockId = 'issue-20-header';
			// A probes while it sees itself alone.
			const captured = await captureCoordinatorLog(async () => {
				expect(isUnflaggedAbsent((await readThroughA(headerId))[headerId])).to.equal(true);
			});
			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);

			// B coordinates a create declaring {A, B, C} and cannot reach A; B and C are a
			// super-majority, so the write is acknowledged. A's storage never sees it.
			// (Without the unreachability, A's admission gate ADMITS B's three-member record against its
			// own one-member view — measured here: A pended and committed as a member and read present.
			// The harness commits every reachable member before the acknowledgement, so the residual
			// "commit still on its way" window the backlog ticket describes is not reachable this way.)
			clock = BASE_TIME + 1_000;
			const transactor = buildNetworkTransactor(mesh, { timeoutMs: 3_000, abortOrCancelTimeoutMs: 3_000 });
			coordinatorOverride = nodeB.peerId;
			mesh.failures.failingPeers = new Set([nodeA.peerId.toString()]);
			const pend = await transactor.pend({ actionId: 'issue-20-action' as ActionId, policy: 'c', transforms: insertOf(headerId) });
			expect(pend.success, `pend through B: ${JSON.stringify(pend)}`).to.equal(true);
			const commit = await transactor.commit({ actionId: 'issue-20-action' as ActionId, blockIds: [headerId], tailId: headerId, rev: 1 });
			expect(commit.success, `commit through B: ${JSON.stringify(commit)}`).to.equal(true);
			const onA = (await nodeA.storageRepo.get({ blockIds: [headerId] }))[headerId];
			expect(isUnflaggedAbsent(onA), `precondition: the write never reached A (A holds ${JSON.stringify(onA)})`).to.equal(true);
			expect((await nodeB.storageRepo.get({ blockIds: [headerId] }))[headerId]?.state?.latest?.rev, 'precondition: B committed it').to.equal(1);

			mesh.failures.partitionSides = undefined;
			mesh.failures.failingPeers = undefined;
			clock = BASE_TIME + 2_000;
			const r = await readThroughA(headerId);
			expectNotStaleAbsent(r[headerId], 'read through A after its view grew');
			expect(r[headerId]?.state?.latest?.rev, 'B and C corroborate rev 1 and A acquires it').to.equal(1);
		});

		it('(#20, item 1): the pend reached A as a cohort member, the commit did not, and A promotes it once it sees the cohort', async () => {
			// The shape backlog `feat-a-cohort-member-remembers-a-settled-absence` measured on the
			// multi-peer memo (Scenario B, 5 of 20): a member holds a pending-only record — which
			// `StorageRepo.get` reports as `{ state: {} }` — while the commit reaches it later.
			const headerId: BlockId = 'issue-20-header-pended';
			const captured = await captureCoordinatorLog(async () => {
				expect(isUnflaggedAbsent((await readThroughA(headerId))[headerId])).to.equal(true);
			});
			expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);

			clock = BASE_TIME + 1_000;
			const transactor = buildNetworkTransactor(mesh, { timeoutMs: 3_000, abortOrCancelTimeoutMs: 3_000 });
			coordinatorOverride = nodeB.peerId;
			const pend = await transactor.pend({ actionId: 'issue-20-action' as ActionId, policy: 'c', transforms: insertOf(headerId) });
			expect(pend.success, `pend through B: ${JSON.stringify(pend)}`).to.equal(true);
			mesh.failures.failingPeers = new Set([nodeA.peerId.toString()]);
			const commit = await transactor.commit({ actionId: 'issue-20-action' as ActionId, blockIds: [headerId], tailId: headerId, rev: 1 });
			expect(commit.success, `commit through B: ${JSON.stringify(commit)}`).to.equal(true);
			const onA = (await nodeA.storageRepo.get({ blockIds: [headerId] }))[headerId];
			expect(isUnflaggedAbsent(onA), 'precondition: A holds the pend only, which reads as absent').to.equal(true);

			mesh.failures.partitionSides = undefined;
			mesh.failures.failingPeers = undefined;
			clock = BASE_TIME + 2_000;
			const r = await readThroughA(headerId);
			expectNotStaleAbsent(r[headerId], 'read through A after its view grew');
			expect(r[headerId]?.state?.latest?.rev, 'A promotes its pending against the corroborated rev').to.equal(1);
		});
	});
});
