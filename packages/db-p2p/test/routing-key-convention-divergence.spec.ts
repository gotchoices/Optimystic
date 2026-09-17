/**
 * Tickets: bug-writer-and-cohort-disagree-on-where-a-block-lives (the measurement) and
 * routing-key-single-encoding (the fix this now pins).
 *
 * A block id becomes a ring coordinate exactly one way. Every party that routes on a block hands
 * `findCluster` / `findCoordinator` the block's routing key, `routingKeyForBlock(id)` — the raw utf8 of the
 * id — and the key network hashes it once (`hashKey == sha256`), so every coordinate is `sha256(utf8(id))`:
 *
 *  - db-core's `NetworkTransactor` (the writer/reader);
 *  - every server-side consumer in db-p2p (`CoordinatorRepo.isResponsibleForBlock`,
 *    `fetchBlockFromCluster`, `ClusterCoordinator.getClusterForBlock`, `RepoService.checkRedirect`,
 *    the mesh harness's own `deriveExpectedCluster`).
 *
 * It used to be two ways: the transactor pre-hashed (`sha256(utf8(id))`, hashed again inside the key
 * network) while the servers did not, so the writer and the servers stood at unrelated ring positions.
 * Nothing in the suite noticed because every fixture had no more peers than its cohort width, and a cohort
 * that already contains every peer is the same set from any coordinate. These specs therefore build rings
 * and meshes WIDER than the cohort — first a pure coordinate comparison on FRET's real cohort assembly (no
 * I/O), then real writes through the mesh harness. The servers' coordinate below is derived from raw
 * `TextEncoder` bytes, independently of the helper, so a helper that drifts from raw utf8 fails here.
 */
import { expect } from 'chai';
import type { PeerId } from '@libp2p/interface';
import { DigitreeStore, assembleCohort, hashKey } from 'p2p-fret';
import { Diary, routingKeyForBlock, type IRepo, type BlockId, type CommitRequest, type PendRequest } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { ringOf, ringPeersOf, ringKeyNetworkOf } from './util/seeded-ring.js';

const utf8 = new TextEncoder();

/** The writer's coordinate: what `NetworkTransactor` routes on — its routing key, hashed once by the key network. */
const writerCoord = async (id: string): Promise<Uint8Array> => hashKey(routingKeyForBlock(id));
/** The servers' coordinate, derived without the helper: the raw utf8 of the id, hashed once. */
const serverCoord = async (id: string): Promise<Uint8Array> => hashKey(utf8.encode(id));

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
	const sa = new Set(a), sb = new Set(b);
	if (sa.size !== sb.size) return false;
	for (const x of sa) if (!sb.has(x)) return false;
	return true;
};

const blockIds = (n: number, prefix = 'block'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

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

describe('routing-key convention: the writer and the servers route a block on one coordinate, H(utf8(id))', function () {
	this.timeout(60_000);

	describe('on FRET\'s real cohort assembly (no I/O)', () => {
		it('the writer\'s coordinate equals the servers\' for every block id', async () => {
			for (const id of blockIds(20)) {
				expect(Buffer.from(await writerCoord(id)).equals(Buffer.from(await serverCoord(id))), id).to.equal(true);
			}
		});

		it('a 16-peer ring with a 4-peer cohort: the writer and the servers pick the same cohort for every id', async () => {
			const store = await ringOf(16);
			const stats = await measureRing(store, 4, blockIds(400));
			console.log('[convention] ring=16 k=4', stats);
			expect(stats.divergent, 'ids whose writer and server cohorts differ').to.equal(0);
			expect(stats.coordinatorOutsideCohort, 'ids whose writer coordinator is outside the responsible cohort').to.equal(0);
		});

		it('agreement holds at every ring width, including every width past the cohort size', async () => {
			const k = 4;
			const ids = blockIds(200);
			const rows: Array<{ n: number; divergent: number; coordinatorOutside: number; disjoint: number }> = [];
			for (const n of [1, 2, 3, 4, 5, 6, 8, 12, 16, 32]) {
				const stats = await measureRing(await ringOf(n), k, ids);
				rows.push({ n, divergent: stats.divergent, coordinatorOutside: stats.coordinatorOutsideCohort, disjoint: stats.disjoint });
			}
			console.log('[convention] ring-width sweep k=4 over 200 ids:');
			console.table(rows);
			for (const row of rows) {
				expect(row.divergent, `n=${row.n} k=${k}: ids whose cohorts differ`).to.equal(0);
				expect(row.coordinatorOutside, `n=${row.n} k=${k}: ids whose coordinator is outside the cohort`).to.equal(0);
			}
		});
	});

	/**
	 * Ticket: cohort-assembly-self-only-when-nearest. The production key network over the same seeded
	 * ring, from one member's point of view. Its cohort must be exactly FRET's nearest-`k` walk over that
	 * ring — with self in it only when self is one of those `k` — at every width and on both the
	 * membership-scoped path (production) and the unscoped one; and its coordinator pick, with self
	 * allowed, must be that cohort's first entry. Only libp2p itself is stubbed: every other member is
	 * connected and identified as serving, so the cohort tier always has a reachable candidate.
	 */
	describe('on the production key network over the same seeded ring (no I/O)', () => {
		const k = 4;

		/** `self`'s key network over `store` at width `k` (see `ringKeyNetworkOf`). */
		const keyNetworkOf = (self: PeerId, peers: PeerId[], store: DigitreeStore, options: { scoped: boolean; ownProtocols?: string[]; notServing?: Set<string> }): Libp2pKeyPeerNetwork =>
			ringKeyNetworkOf(self, peers, store, { clusterSize: k, ...options });

		const cohortOf = async (network: Libp2pKeyPeerNetwork, id: string): Promise<string[]> =>
			Object.keys(await network.findCluster(routingKeyForBlock(id)));

		it('at every width, the cohort is FRET\'s nearest-k walk, self is in it exactly when it is one of the k, and the coordinator is its first entry', async () => {
			const ids = blockIds(60);
			const rows: Array<{ n: number; scoped: boolean; selfInCohort: number; of: number }> = [];
			for (const n of [1, 2, 3, 4, 5, 6, 8, 12, 16, 32]) {
				const peers = await ringPeersOf(n);
				const store = await ringOf(n);
				const self = peers[0]!;
				for (const scoped of [true, false]) {
					const network = keyNetworkOf(self, peers, store, { scoped });
					let selfInCohort = 0;
					for (const id of ids) {
						const label = `n=${n} scoped=${scoped} ${id}`;
						const expected = assembleCohort(store, await serverCoord(id), k);
						const cohort = await cohortOf(network, id);
						expect(cohort, `${label}: cohort (ordered)`).to.deep.equal(expected);
						expect(cohort.length, `${label}: cohort width`).to.equal(Math.min(n, k));
						if (cohort.includes(self.toString())) selfInCohort++;
						const coordinator = (await network.findCoordinator(routingKeyForBlock(id))).toString();
						expect(coordinator, `${label}: coordinator is the cohort's first entry`).to.equal(expected[0]);
					}
					rows.push({ n, scoped, selfInCohort, of: ids.length });
				}
			}
			console.log('[convention] production key network vs FRET walk, k=4:');
			console.table(rows);
			// Sanity on the geometry: past k, self is in some cohorts and out of others.
			for (const row of rows.filter(r => r.n > k)) {
				expect(row.selfInCohort, `n=${row.n}: self in some cohorts`).to.be.greaterThan(0);
				expect(row.selfInCohort, `n=${row.n}: self out of some cohorts`).to.be.lessThan(row.of);
			}
		});

		it('small-network invariant: at every width from 1 to k, every serving node is in every cohort', async () => {
			for (let n = 1; n <= k; n++) {
				const peers = await ringPeersOf(n);
				const store = await ringOf(n);
				const everyone = peers.map(p => p.toString()).sort();
				for (const self of peers) {
					const network = keyNetworkOf(self, peers, store, { scoped: true });
					for (const id of blockIds(20)) {
						expect([...await cohortOf(network, id)].sort(), `n=${n} self=${self.toString().substring(0, 12)} ${id}`).to.deep.equal(everyone);
					}
				}
			}
		});

		it('past k, from every member\'s point of view, self is in a block\'s cohort iff it is among the nearest k', async () => {
			const n = 12;
			const peers = await ringPeersOf(n);
			const store = await ringOf(n);
			for (const self of peers) {
				const network = keyNetworkOf(self, peers, store, { scoped: true });
				for (const id of blockIds(30)) {
					const nearest = assembleCohort(store, await serverCoord(id), k);
					const cohort = await cohortOf(network, id);
					expect(cohort.includes(self.toString()), `self=${self.toString().substring(0, 12)} ${id}`).to.equal(nearest.includes(self.toString()));
				}
			}
		});

		it('a member that serves no storage is in no cohort, and its cohorts equal what a serving member computes for the same blocks', async () => {
			// FRET's ring still holds the client-only node (it routes), so a serving peer sees it in
			// the band and drops it as not serving; the client drops itself for the same reason.
			// Both must land on the same nearest-k SERVING set, or the client would route writes to
			// a set nobody else believes is responsible.
			for (const n of [1, 2, 4, 8, 16]) {
				const peers = await ringPeersOf(n);
				const store = await ringOf(n);
				const client = peers[0]!;
				const clientNetwork = keyNetworkOf(client, peers, store, { scoped: true, ownProtocols: ['/ipfs/id/1.0.0'] });
				const server = peers[1];
				const serverNetwork = server ? keyNetworkOf(server, peers, store, { scoped: true, notServing: new Set([client.toString()]) }) : undefined;
				for (const id of blockIds(30)) {
					const fromClient = await cohortOf(clientNetwork, id);
					expect(fromClient, `n=${n} ${id}: client never in its own cohort`).to.not.include(client.toString());
					expect(fromClient.length, `n=${n} ${id}: width`).to.equal(Math.min(n - 1, k));
					if (serverNetwork) {
						expect(fromClient, `n=${n} ${id}: client and server agree`).to.deep.equal(await cohortOf(serverNetwork, id));
					}
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
			new Set(Object.keys(await mesh.keyNetwork.findCluster(routingKeyForBlock(id))));

		const holdersOf = async (id: string): Promise<string[]> => {
			const out: string[] = [];
			for (const node of mesh.nodes) {
				const r = await node.storageRepo.get({ blockIds: [id as BlockId] }, { skipClusterFetch: true } as any);
				if (r[id as BlockId]?.state?.latest) out.push(node.peerId.toString());
			}
			return out;
		};

		before(async () => {
			// Seeded keys, for the same reason as `ringOf`: the placement below is then a property of one
			// reproducible mesh, not a random sample.
			mesh = await createMesh(16, { responsibilityK: 4, clusterSize: 4, keySeed: 16 });
			for (const node of mesh.nodes) byPeer.set(node.peerId.toString(), node);
		});

		it('the coordinator the writer picks is inside the responsible cohort for every block', async () => {
			let outside = 0;
			const ids = blockIds(200, 'mesh');
			for (const id of ids) {
				const coordinator = (await mesh.keyNetwork.findCoordinator(routingKeyForBlock(id))).toString();
				if (!(await serverCohort(id)).has(coordinator)) outside++;
			}
			console.log(`[convention] mesh: coordinator outside cohort for ${outside}/${ids.length} ids`);
			expect(outside).to.equal(0);
		});

		it('a direct pend+commit through the transactor lands on exactly the responsible cohort', async () => {
			calls.length = 0;
			const transactor = buildNetworkTransactor(mesh, { wrapRepo: recordingRepo });
			const id = 'direct-write-block' as BlockId;
			const pend: PendRequest = {
				actionId: 'act-direct-1',
				transforms: { inserts: { [id]: { header: { id, type: 'test', collectionId: 'col-direct' as BlockId } } }, updates: {}, deletes: [] },
				policy: 'c'
			};
			const pendResult = await transactor.pend(pend);
			expect(pendResult.success, 'pend').to.equal(true);

			const commit: CommitRequest = { actionId: 'act-direct-1', blockIds: [id], tailId: id, rev: 1 };
			const commitResult = await transactor.commit(commit);
			expect(commitResult.success, 'commit').to.equal(true);

			const cohort = await serverCohort(id);
			const holders = await holdersOf(id);
			const pendPeer = calls.find(c => c.op === 'pend')?.peer;
			const commitPeer = calls.find(c => c.op === 'commit')?.peer;
			console.log('[convention] direct write:', {
				coordinatorForPend: pendPeer?.substring(0, 12),
				coordinatorForCommit: commitPeer?.substring(0, 12),
				coordinatorInCohort: pendPeer ? cohort.has(pendPeer) : undefined,
				cohortSize: cohort.size,
				holders: holders.length
			});
			expect(pendPeer !== undefined && cohort.has(pendPeer), 'the pend coordinator is a responsible peer').to.equal(true);
			expect(holders.filter(h => !cohort.has(h)), 'holders outside the responsible cohort').to.deep.equal([]);
			expect([...cohort].filter(c => !holders.includes(c)), 'responsible peers missing the block').to.deep.equal([]);
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
			console.log('[convention] diary write placement:');
			console.table(rows);

			// Read back from a second, independent transactor (a different "client").
			const reader = await Diary.createOrOpen<{ content: string }>(buildNetworkTransactor(mesh), 'divergence-diary');
			await reader.update();
			const contents: string[] = [];
			for await (const e of reader.select()) contents.push(e.content);
			console.log('[convention] read back:', contents);
			expect(contents).to.have.members(['entry-0', 'entry-1', 'entry-2']);
		});
	});
});
