/**
 * Reactivity **mock-tier e2e — partition healing** (`docs/reactivity.md` §Failure modes — fan-out
 * interrupted by primary failure / subscriber wakes after long sleep; §Interaction — partition healing;
 * cross-checked against `docs/partition-healing.md`).
 *
 * A forwarder cohort is partitioned away from a subscriber while commits continue; on heal the real
 * recovery path merges cleanly with **no notification lost or double-delivered**:
 *
 *  - the gossiped replay ring covers the gap so any cohort member can serve it (the any-member-serves
 *    property), and the subscriber's `resume()` backfills the missed revisions;
 *  - the forwarder's sliding `(revision, sigDigest)` dedupe window drops an exact retransmit (the duplicate
 *    a partition merge re-delivers from a second parent) without re-buffering it;
 *  - the subscriber's `(collectionId, revision)` dedupe discards a duplicate re-delivery on heal.
 *
 * **Two-tier `cohortEpoch` / bracketing-sig re-verification** (the cohort-topic membership-drift refresh
 * `docs/partition-healing.md` models) is the cohort-topic layer's mechanism — reactivity *reacts* by
 * re-verifying notifications against the refreshed tail cert (always real Ed25519 here). This suite pins the
 * reactivity-specific dedupe/replay convergence; the epoch-refresh rule model is the cohort-topic tier's.
 */

import { expect } from 'chai';
import { bytesToB64url } from '@optimystic/db-core';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i);

describe('reactivity / mesh — partition healing (no loss, no double-delivery)', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound. The suite runs serially in a single
	// ~7-minute Node process, so tests near the back face large GC-pressured heaps and wall-clock variance
	// stacks on top of the isolation cost — machine load, not a defect, threatens the clock. 120s is the
	// uniform ceiling across the full real-Ed25519 mesh e2e class so no member becomes the next timeout victim.
	this.timeout(120_000);
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	it('a subscriber partitioned away from the fan-out heals via backfill with no loss', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 5 });
		await rx.registerCollection('split');
		const s = await rx.subscribe(1, 'split');

		await rx.commit('split', 4);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 4));

		// Partition: the subscriber is cut off from fan-out while commits continue. The gossiped replay ring
		// still fills (any cohort member can serve it), so the gap is recoverable.
		rx.sleepSubscriber(s);
		await rx.commit('split', 4); // revisions 5..8 missed by the subscriber
		expect(rx.pushStateOf('split').replayBuffer.range(5, 8), 'the replay ring covers the partition gap').to.have.length(4);

		// Heal: resume backfills the missed window. No revision is lost.
		expect(await rx.resume(s)).to.equal('backfilled');
		expect(s.delivered.map((n) => n.revision), 'healed to a contiguous 1..8').to.deep.equal(range(1, 8));
	});

	it('a duplicate re-delivery on heal (the same revision from a second parent) is deduped — no double-delivery', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 5 });
		await rx.registerCollection('merge');
		const s = await rx.subscribe(1, 'merge');
		await rx.commit('merge', 5);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 5));

		// A partition merge re-delivers revisions 3 and 4 from a second parent: the subscriber dedupes both.
		expect(await s.manager.onNotification(s.delivered[2]!)).to.equal('duplicate');
		expect(await s.manager.onNotification(s.delivered[3]!)).to.equal('duplicate');
		expect(s.delivered.map((n) => n.revision), 'no double-delivery after the merge').to.deep.equal(range(1, 5));
	});

	it('the forwarder sliding dedupe window drops an exact retransmit without re-buffering it', async () => {
		rx = await buildReactivityMesh({ nodeCount: 6, wantK: 4 });
		await rx.registerCollection('dedupe');
		const s = await rx.subscribe(1, 'dedupe');
		await rx.commit('dedupe', 2); // forwarder received revisions 1, 2 (verify → forward → buffer)
		const ps = rx.pushStateOf('dedupe');
		expect(ps.replayBuffer.size, 'two distinct revisions buffered').to.equal(2);

		// Re-feed revision 1 (an exact retransmit arriving from a second parent during partition merge).
		expect(await rx.forwarderReceive('dedupe', s.delivered[0]!), 'already in the sliding dedupe window').to.equal('duplicate');
		expect(ps.replayBuffer.size, 'the duplicate did not occupy a second ring slot').to.equal(2);
	});

	it('a forged retransmit during a merge is rejected by the forwarder before it can poison dedupe or the ring', async () => {
		rx = await buildReactivityMesh({ nodeCount: 6, wantK: 4 });
		await rx.registerCollection('forge');
		const s = await rx.subscribe(1, 'forge');
		await rx.commit('forge', 1);
		const ps = rx.pushStateOf('forge');

		const forged = { ...s.delivered[0]!, revision: 2, sig: bytesToB64url(new Uint8Array(64).fill(3)) };
		expect(await rx.forwarderReceive('forge', forged), 'real verify rejects the forged sig').to.equal('untrusted');
		expect(ps.replayBuffer.size, 'a forged notification never occupies a ring slot').to.equal(1);
	});
});

