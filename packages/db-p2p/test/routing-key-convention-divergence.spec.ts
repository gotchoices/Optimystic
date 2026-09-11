/**
 * Ticket: bug-writer-and-cohort-disagree-on-where-a-block-lives.
 *
 * A block id becomes a ring coordinate by two different routes in this repo:
 *
 *  - db-core's `NetworkTransactor` (the writer/reader) hands `blockIdToBytes(id)` — which is
 *    `sha256(utf8(id))` — to `findCluster` / `findCoordinator`. Both of those hash again
 *    (`hashKey == sha256`), so the writer's coordinate is `sha256(sha256(utf8(id)))`.
 *  - every server-side consumer in db-p2p (`CoordinatorRepo.isResponsibleForBlock`,
 *    `fetchBlockFromCluster`, `ClusterCoordinator.getClusterForBlock`, `RepoService.checkRedirect`,
 *    the mesh harness's own `deriveExpectedCluster`) hands the RAW utf8 bytes, so its coordinate
 *    is `sha256(utf8(id))`.
 *
 * Those are unrelated ring positions. Nothing in the suite noticed because every fixture has no
 * more peers than its cohort width, and a cohort that already contains every peer is the same set
 * from any coordinate. These specs build rings and meshes WIDER than the cohort and measure what
 * the mismatch actually does — first as a pure coordinate comparison on FRET's real cohort
 * assembly (no I/O), then as a real write through the mesh harness.
 *
 * The numbers these specs print are the ticket's evidence; the assertions pin only what was
 * observed, not what the ticket guessed.
 */
import { expect } from 'chai';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { DigitreeStore, assembleCohort, hashKey, hashPeerId } from 'p2p-fret';
import { Diary, blockIdToBytes, type IRepo, type BlockId, type CommitRequest, type PendRequest } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const utf8 = new TextEncoder();

/** The writer's coordinate: what `NetworkTransactor` ends up routing on. */
const writerCoord = async (id: string): Promise<Uint8Array> => hashKey(await blockIdToBytes(id as BlockId));
/** The server's coordinate: what every db-p2p responsibility check routes on. */
const serverCoord = async (id: string): Promise<Uint8Array> => hashKey(utf8.encode(id));

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
	const sa = new Set(a), sb = new Set(b);
	if (sa.size !== sb.size) return false;
	for (const x of sa) if (!sb.has(x)) return false;
	return true;
};

const blockIds = (n: number, prefix = 'block'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/**
 * A FRET ring store holding `n` peers at their real ring coordinates. Keys are derived from a fixed
 * seed per `(n, i)`, so every run measures the SAME ring: the statistics below are properties of one
 * reproducible geometry rather than a fresh random sample whose tail crosses the assertion's bound.
 */
async function ringOf(n: number): Promise<DigitreeStore> {
	const store = new DigitreeStore();
	for (let i = 0; i < n; i++) {
		const seed = new Uint8Array(32);
		const view = new DataView(seed.buffer);
		view.setUint32(0, n);
		view.setUint32(4, i);
		const pid = peerIdFromPrivateKey(await generateKeyPairFromSeed('Ed25519', seed));
		store.upsert(pid.toString(), await hashPeerId(pid));
	}
	return store;
}

interface DivergenceStats {
	/** Cohorts at the two coordinates are not the same set. */
	divergent: number;
	/** The writer's nearest peer (its coordinator pick) is not in the server-side cohort at all. */
	coordinatorOutsideCohort: number;
	/** The two cohorts share no member. */
	disjoint: number;
	total: number;
}

async function measureRing(store: DigitreeStore, k: number, ids: string[]): Promise<DivergenceStats> {
	const stats: DivergenceStats = { divergent: 0, coordinatorOutsideCohort: 0, disjoint: 0, total: ids.length };
	for (const id of ids) {
		const writer = assembleCohort(store, await writerCoord(id), k);
		const server = new Set(assembleCohort(store, await serverCoord(id), k));
		if (!sameSet(writer, server)) stats.divergent++;
		if (writer.length > 0 && !server.has(writer[0]!)) stats.coordinatorOutsideCohort++;
		if (!writer.some(p => server.has(p))) stats.disjoint++;
	}
	return stats;
}

describe('routing-key convention: writer H(H(id)) vs server H(id)', function () {
	this.timeout(60_000);

	describe('on FRET\'s real cohort assembly (no I/O)', () => {
		it('the two coordinates never coincide for the same block id', async () => {
			for (const id of blockIds(20)) {
				expect(Buffer.from(await writerCoord(id)).equals(Buffer.from(await serverCoord(id))), id).to.equal(false);
			}
		});

		it('a 16-peer ring with a 4-peer cohort: the writer and the servers pick different cohorts', async () => {
			const store = await ringOf(16);
			const stats = await measureRing(store, 4, blockIds(400));
			console.log('[divergence] ring=16 k=4', stats);
			// Fewer than 1 in 20 ids agree; the writer's coordinator pick is OUTSIDE the responsible
			// cohort for the large majority of ids. Bounds are loose because peer ids are random per run.
			expect(stats.divergent / stats.total).to.be.greaterThan(0.85);
			expect(stats.coordinatorOutsideCohort / stats.total).to.be.greaterThan(0.6);
		});

		it('threshold: agreement is exact while ring size <= cohort width, and breaks the moment it exceeds it', async () => {
			const k = 4;
			const ids = blockIds(200);
			const rows: Array<{ n: number; divergent: number; coordinatorOutside: number; disjoint: number }> = [];
			for (const n of [1, 2, 3, 4, 5, 6, 8, 12, 16, 32]) {
				const stats = await measureRing(await ringOf(n), k, ids);
				rows.push({ n, divergent: stats.divergent, coordinatorOutside: stats.coordinatorOutsideCohort, disjoint: stats.disjoint });
			}
			console.log('[divergence] threshold sweep k=4 over 200 ids:');
			console.table(rows);
			for (const row of rows) {
				if (row.n <= k) {
					expect(row.divergent, `n=${row.n} <= k=${k} must agree on every id`).to.equal(0);
				} else {
					expect(row.divergent, `n=${row.n} > k=${k} must diverge on some id`).to.be.greaterThan(0);
				}
			}
		});
	});

	describe('on the mesh harness (16 nodes, responsibilityK 4, clusterSize 4)', () => {
		let mesh: Mesh;
		const byPeer = new Map<string, MeshNode>();
		/** Every repo call the transactor made: which node received which op for which blocks. */
		const calls: Array<{ peer: string; op: 'pend' | 'commit' | 'get'; blockIds: string[] }> = [];

		const recordingRepo = (repo: IRepo, node: MeshNode): IRepo => {
			const peer = node.peerId.toString();
			const wrapped: IRepo = {
				get: (req, opts) => { calls.push({ peer, op: 'get', blockIds: [...req.blockIds] }); return repo.get(req, opts); },
				pend: (req, opts) => {
					const ids = [...Object.keys(req.transforms.inserts ?? {}), ...Object.keys(req.transforms.updates ?? {}), ...(req.transforms.deletes ?? [])];
					calls.push({ peer, op: 'pend', blockIds: ids });
					return repo.pend(req, opts);
				},
				cancel: (ref, opts) => repo.cancel(ref, opts),
				commit: (req, opts) => { calls.push({ peer, op: 'commit', blockIds: [...req.blockIds] }); return repo.commit(req, opts); }
			};
			return wrapped;
		};

		const serverCohort = async (id: string): Promise<Set<string>> =>
			new Set(Object.keys(await mesh.keyNetwork.findCluster(utf8.encode(id))));

		const holdersOf = async (id: string): Promise<string[]> => {
			const out: string[] = [];
			for (const node of mesh.nodes) {
				const r = await node.storageRepo.get({ blockIds: [id as BlockId] }, { skipClusterFetch: true } as any);
				if (r[id as BlockId]?.state?.latest) out.push(node.peerId.toString());
			}
			return out;
		};

		before(async () => {
			mesh = await createMesh(16, { responsibilityK: 4, clusterSize: 4 });
			for (const node of mesh.nodes) byPeer.set(node.peerId.toString(), node);
		});

		it('the coordinator the writer picks is outside the responsible cohort for most blocks', async () => {
			let outside = 0;
			const ids = blockIds(200, 'mesh');
			for (const id of ids) {
				const coordinator = (await mesh.keyNetwork.findCoordinator(await blockIdToBytes(id as BlockId))).toString();
				if (!(await serverCohort(id)).has(coordinator)) outside++;
			}
			console.log(`[divergence] mesh: coordinator outside cohort for ${outside}/${ids.length} ids`);
			expect(outside / ids.length).to.be.greaterThan(0.6);
		});

		it('a direct pend+commit through the transactor: what actually happens', async () => {
			calls.length = 0;
			const transactor = buildNetworkTransactor(mesh, { wrapRepo: recordingRepo });
			const id = 'direct-write-block' as BlockId;
			const pend: PendRequest = {
				actionId: 'act-direct-1',
				transforms: { inserts: { [id]: { header: { id, type: 'test', collectionId: 'col-direct' as BlockId } } }, updates: {}, deletes: [] },
				policy: 'c'
			};
			const pendResult = await transactor.pend(pend);
			console.log('[divergence] direct pend result:', JSON.stringify(pendResult));
			expect(pendResult.success, 'pend').to.equal(true);

			const commit: CommitRequest = { actionId: 'act-direct-1', blockIds: [id], tailId: id, rev: 1 };
			const commitResult = await transactor.commit(commit);
			console.log('[divergence] direct commit result:', JSON.stringify(commitResult));

			const cohort = await serverCohort(id);
			const holders = await holdersOf(id);
			const pendPeer = calls.find(c => c.op === 'pend')?.peer;
			const commitPeer = calls.find(c => c.op === 'commit')?.peer;
			console.log('[divergence] direct write:', {
				coordinatorForPend: pendPeer?.substring(0, 12),
				coordinatorForCommit: commitPeer?.substring(0, 12),
				coordinatorInCohort: pendPeer ? cohort.has(pendPeer) : undefined,
				cohortSize: cohort.size,
				holders: holders.length,
				holdersOutsideCohort: holders.filter(h => !cohort.has(h)).length,
				cohortMembersMissingBlock: [...cohort].filter(c => !holders.includes(c)).length
			});
			expect(commitResult.success, 'commit').to.equal(true);
		});

		it('a Diary written through the transactor: replica placement per committed block', async () => {
			calls.length = 0;
			const transactor = buildNetworkTransactor(mesh, { wrapRepo: recordingRepo });
			const diary = await Diary.createOrOpen<{ content: string }>(transactor, 'divergence-diary');
			for (let i = 0; i < 3; i++) await diary.append({ content: `entry-${i}` });

			const committed = new Set<string>();
			for (const c of calls) if (c.op === 'commit') for (const b of c.blockIds) committed.add(b);
			expect(committed.size).to.be.greaterThan(0);

			const rows: Array<Record<string, unknown>> = [];
			for (const id of committed) {
				const cohort = await serverCohort(id);
				const holders = await holdersOf(id);
				const coordinators = new Set(calls.filter(c => c.op !== 'get' && c.blockIds.includes(id)).map(c => c.peer));
				rows.push({
					block: id.substring(0, 16),
					cohort: cohort.size,
					holders: holders.length,
					holdersOutsideCohort: holders.filter(h => !cohort.has(h)).length,
					cohortMissing: [...cohort].filter(c => !holders.includes(c)).length,
					coordinatorsInCohort: [...coordinators].filter(c => cohort.has(c)).length,
					coordinatorsOutside: [...coordinators].filter(c => !cohort.has(c)).length
				});
			}
			console.log('[divergence] diary write placement:');
			console.table(rows);

			// Read back from a second, independent transactor (a different "client").
			const reader = await Diary.createOrOpen<{ content: string }>(buildNetworkTransactor(mesh), 'divergence-diary');
			await reader.update();
			const contents: string[] = [];
			for await (const e of reader.select()) contents.push(e.content);
			console.log('[divergence] read back:', contents);
			expect(contents).to.have.members(['entry-0', 'entry-1', 'entry-2']);
		});
	});
});
