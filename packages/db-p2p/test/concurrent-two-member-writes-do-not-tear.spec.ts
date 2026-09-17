/**
 * Mesh-tier regression for concurrent writes that tore because a cancel was treated as a rival write.
 *
 * Two nodes of a two-member cohort write different rows into the same tree at the same moment. One
 * writer's pend is refused (the other holds the leaf), and it cancels that refused pend — a cluster
 * transaction of its own, naming the same blocks. Before the fix the conflict scan
 * (`operationsConflict`) counted that cancel as a competing write: it shares a block with the
 * winner's commit and names a different action. On a two-member cohort one conflict vote already
 * makes the super-majority unreachable, so the winner's leaf commit lost the race after its log tail
 * had already landed, every re-send collided with the loser's next cancel the same way, and the
 * winner eventually reported `TornActionError` for a half-saved write.
 *
 * The plain mesh delivers cluster messages synchronously and never interleaves them tightly enough to
 * reach this; a few milliseconds of latency on each remote delivery does.
 *
 * Reproducer strength, measured against a build with the cancel escape removed from
 * `operationsConflict`: at {@link PairsPerRun} = 4 only one of the three runs tore, and at 8 all
 * three tore (8 `TornActionError`s over three runs). 4 is nonetheless what ships, because the same
 * contention that sharpens this reproducer also makes a SEPARATE defect reachable: at 8, the FIXED
 * build fails 2 executions in 3 with `ValidatorRejectionError` — "pending conflict: block … held by
 * unresolved action(s)" — which is a transient optimistic-concurrency condition being answered as a
 * permanent validator rejection, filed as `a-contended-pend-refusal-is-permanent-on-a-small-cohort`.
 * A guard that flakes on an unrelated defect is worth less than a weaker guard that does not, so this
 * spec stays at the contention where it is stable. Raise it to 8 to reproduce either defect by hand.
 *
 * 4 reduces that exposure but does not remove it: a second review pass measured the same
 * `ValidatorRejectionError` once in 15 executions at 4, on runs verified to be against an unmodified
 * `operationsConflict`. So a red here is one of three things, in descending likelihood: that filed
 * defect (the message says `pending conflict: block … held by unresolved action(s)`), a genuine
 * regression of this ticket (the message says `TornActionError`), or a row unreadable from the other
 * node. Read the message before assuming the escape broke.
 *
 * The delays are random, not seeded, so the spec samples interleavings rather than pinning three of
 * them. That asymmetry is deliberate and safe in one direction only: a random schedule can never
 * FAIL this spec spuriously (it fails only when a write genuinely tears or a row is unreadable from
 * the other node), it can only miss a regression. If it ever does go red, the failure message names
 * the torn action but the schedule that produced it is gone — re-run rather than trying to replay.
 */

import { expect } from 'chai';
import { Tree, type ITransactor } from '@optimystic/db-core';
import type { ClusterRecord } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '../src/testing/mesh-harness.js';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;

const Runs = 3;
const PairsPerRun = 4;

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const deliveryLatencyMs = (): number => 2 + Math.floor(Math.random() * 15);

/**
 * Delays every REMOTE cluster delivery, on the way in and on the way back. The mesh's cluster client
 * resolves `target.clusterMember` per call, while each coordinator holds the member it was built with
 * and calls its own member directly — so a node's in-process traffic stays synchronous, as in
 * production.
 *
 * NOTE: the wrapper delegates by prototype, which is only safe because `update` is the one method the
 * mesh routes through it (the mesh's other call is `restart`'s `dispose`, and this spec never
 * restarts). Every other method reached on the wrapper would run with `this` bound to the WRAPPER, so
 * any `this.field = …` inside it would land on the wrapper and the real member would never see the
 * write. `update` is exempt because it is delegated explicitly, with `inner` as the receiver.
 *
 * NOTE: spec-local on purpose — it is the only latency injection in the suite today. If a second spec
 * needs one, promote it to a `MeshFailureConfig` knob (beside `onClusterDelivery`) rather than copying
 * this, so a restarted node keeps its latency too (a restart rebuilds `clusterMember` and drops this
 * wrapper outright) and so the delegation hazard above stops being a thing a reader has to re-derive.
 */
const addDeliveryLatency = (mesh: Mesh): void => {
	for (const node of mesh.nodes) {
		const inner = node.clusterMember;
		const delayed = Object.create(inner) as typeof inner;
		delayed.update = async (record: ClusterRecord): Promise<ClusterRecord> => {
			await pause(deliveryLatencyMs());
			const answer = await inner.update(record);
			await pause(deliveryLatencyMs());
			return answer;
		};
		node.clusterMember = delayed;
	}
};

describe('Concurrent writes on a two-member cohort do not tear (mesh, delivery latency)', function () {
	this.timeout(120_000);

	for (let run = 0; run < Runs; run++) {
		it(`run ${run + 1}: every concurrent replace() resolves and each row is readable on the other node`, async () => {
			const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2, superMajorityThreshold: 0.67 });
			addDeliveryLatency(mesh);
			const transactors = buildNetworkTransactors(mesh);
			const peerA = mesh.nodes[0]!.peerId.toString();
			const peerB = mesh.nodes[1]!.peerId.toString();
			const treeId = `concurrent-two-member-${run}`;

			const treeA = await Tree.createOrOpen<string, Row>(transactorFor(transactors, peerA), treeId, keyOf);
			await treeA.replace([['seed', { key: 'seed', value: 'Seed' }]]);
			const treeB = await Tree.createOrOpen<string, Row>(transactorFor(transactors, peerB), treeId, keyOf);
			await treeB.update();

			const written: { key: string; readOn: string }[] = [];
			const failures: string[] = [];
			for (let pair = 0; pair < PairsPerRun; pair++) {
				const keyA = `a-${pair}`;
				const keyB = `b-${pair}`;
				const [resultA, resultB] = await Promise.allSettled([
					treeA.replace([[keyA, { key: keyA, value: `A${pair}` }]]),
					treeB.replace([[keyB, { key: keyB, value: `B${pair}` }]])
				]);
				if (resultA.status === 'rejected') failures.push(`pair ${pair} A: ${String(resultA.reason)}`);
				if (resultB.status === 'rejected') failures.push(`pair ${pair} B: ${String(resultB.reason)}`);
				written.push({ key: keyA, readOn: peerB }, { key: keyB, readOn: peerA });
			}

			expect(failures, 'every concurrent replace() resolved').to.deep.equal([]);

			// A fresh tree per reader: the row must be genuinely stored, not an artifact of the writer's tracker.
			const readers = new Map<string, Tree<string, Row>>();
			for (const peer of [peerA, peerB]) {
				readers.set(peer, await Tree.createOrOpen<string, Row>(transactorFor(transactors, peer), treeId, keyOf));
			}
			for (const { key, readOn } of written) {
				expect(await readers.get(readOn)!.get(key), `${key} read from the other node`).to.have.property('key', key);
			}
		});
	}
});
