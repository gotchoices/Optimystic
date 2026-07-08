/**
 * Reactivity **mock-tier e2e — slow-subscriber isolation** (`docs/reactivity.md` §Slow-subscriber
 * backpressure, §Failure modes — slow subscriber on satellite link, §Per-cohort policy — Edge nodes never
 * serve as reactivity forwarders).
 *
 * One subscriber with injected jitter (it does not drain its bounded queue) fills the real per-subscriber
 * `BoundedQueue` to `queue_max`, drop-oldest under pressure (incrementing the monotone `dropped` counter),
 * then on wake detects the revision gap and **backfills** — all **without stalling** the fast subscribers in
 * the same fan-out (each subscriber has its own queue, so a slow peer's drops never touch a fast peer's). An
 * Edge-profile subscriber is a pure T3 *consumer*: it receives notifications but `mayServeAsReactivityForwarder`
 * is `false` for it (T3 producer willingness off).
 */

import { expect } from 'chai';
import { waitFor } from '@optimystic/db-core/test';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i);

describe('reactivity / mesh — slow-subscriber isolation', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound. The suite runs serially in a single
	// ~7-minute Node process, so tests near the back face large GC-pressured heaps and wall-clock variance
	// stacks on top of the isolation cost — machine load, not a defect, threatens the clock. 120s is the
	// uniform ceiling across the full real-Ed25519 mesh e2e class so no member becomes the next timeout victim.
	this.timeout(120_000);
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	it('a slow subscriber drops-oldest and backfills the gap without stalling fast subscribers', async () => {
		// queue_max = 4 forces drop-oldest under sustained backlog; the replay ring (default W) covers the gap.
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 5 });
		await rx.registerCollection('q', { queueMax: 4 });
		const fast1 = await rx.subscribe(1, 'q');
		const fast2 = await rx.subscribe(2, 'q');
		const slow = await rx.subscribe(3, 'q', { autoDrain: false });

		// Establish a baseline on the slow subscriber (revision 1), then let it lag.
		await rx.commit('q', 1);
		await rx.wakeSubscriber(slow);
		expect(slow.delivered.map((n) => n.revision)).to.deep.equal([1]);

		// 19 more commits (revisions 2..20) while the slow subscriber never drains: its queue (cap 4) holds
		// the freshest 4 and drops the rest. The fast subscribers drain every revision in order — not stalled.
		await rx.commit('q', 19);
		expect(rx.droppedFor(slow), '19 enqueues into a cap-4 queue drop the 15 oldest').to.equal(15);
		expect(fast1.delivered.map((n) => n.revision), 'fast subscriber 1 is never stalled by the slow peer').to.deep.equal(range(1, 20));
		expect(fast2.delivered.map((n) => n.revision), 'fast subscriber 2 is never stalled by the slow peer').to.deep.equal(range(1, 20));

		// Wake the slow subscriber: it delivers its freshest queued revisions, detects the gap, and backfills.
		await rx.wakeSubscriber(slow);
		// The gap-detection backfill is fire-and-forget off `onNotification`, so `wakeSubscriber` resolves before
		// the missed window lands. Poll the observable delivery state (healed to the full 1..20) rather than
		// sleeping a fixed span and hoping the RPC settled.
		await waitFor(() => slow.delivered.length >= 20, { description: 'the slow subscriber backfilled its gap to a complete 1..20' });

		const got = [...new Set(slow.delivered.map((n) => n.revision))].sort((a, b) => a - b);
		expect(got, 'the slow subscriber healed to a complete 1..20 (no loss)').to.deep.equal(range(1, 20));
		expect(slow.delivered.length, 'each revision delivered exactly once (no double-delivery)').to.equal(20);
		expect(slow.backfills, 'the gap drove at least one backfill RPC against the replay ring').to.be.greaterThan(0);
	});

	it('an Edge subscriber receives notifications but never serves as a forwarder (T3 consumer, not producer)', async () => {
		// Node 3 is an Edge profile: a T3 *consumer* (subscriber) is fine; a T3 *producer* (forwarder) is off.
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 5, profiles: ['core', 'core', 'core', 'edge', 'core', 'core', 'core', 'core'] });
		await rx.registerCollection('edge');
		expect(rx.mayForward(3), 'an Edge node never serves as a reactivity forwarder').to.equal(false);
		expect(rx.mayForward(0), 'a Core node may forward T3').to.equal(true);

		const edge = await rx.subscribe(3, 'edge');
		await rx.commit('edge', 3);
		expect(edge.delivered.map((n) => n.revision), 'the Edge subscriber still receives notifications').to.deep.equal(range(1, 3));
	});
});

