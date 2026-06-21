/**
 * Reactivity **mock-tier e2e — mobile resume windows** (`docs/reactivity.md` §Resume, §Replay window —
 * stacked semantics, §Failure modes — subscriber wakes after long sleep / tail rotation during outage).
 *
 * Drives the **real** four-variant resume classification end-to-end over the reactivity mesh: a subscriber
 * wakes with a given lag against the tail cohort's **stacked** windows (the `W`-deep replay ring on top of
 * the `W_checkpoint`-span rolling checkpoint immediately below it) and its `ReactivitySubscriptionManager`
 * sends one `ResumeV1`, served by the real {@link serveResume}, applied by the real `applyResumeReply`:
 *
 *  - `lag < W` → exactly one `Backfill` resolves the gap (one round trip);
 *  - `W ≤ lag < W + W_checkpoint` → one `CheckpointWindow` resume (checkpoint endpoints verified, merged
 *    digest applied, recent entries replayed);
 *  - `lag ≥ W + W_checkpoint` → `OutOfWindow` → chain read;
 *  - a stale `latestKnownTailId` (slept across a rotation) → `TailRotated` → re-register.
 *
 * **Window magnitudes are the simulator's.** `W = 256` / `W_checkpoint = 4096` and the quantitative
 * coverage math are validated by the design simulator (`docs/reactivity.md` §Configuration). This suite
 * exercises the *classifier behavior at the stacked boundaries* with scaled-down `W`/`W_checkpoint` (so it
 * needs a few dozen commits, not thousands) — the variant each lag produces, not the production magnitudes.
 */

import { expect } from 'chai';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

// Scaled stacked windows: ring W = 4, checkpoint W_checkpoint = 12 → stacked recoverable range 16.
const W = 4;
const W_CHECKPOINT = 12;
const COLLECTION_OPTS = { w: W, wCheckpoint: W_CHECKPOINT } as const;

describe('reactivity / mesh — mobile resume windows (stacked W + W_checkpoint)', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound and run several seconds; give
	// generous headroom over the 10s default so machine load doesn't tip a passing test into a timeout.
	this.timeout(30_000);
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	// Bring a collection to revision 20: ring holds [17..20], checkpoint covers [5..16] (the 12 below the ring).
	const bringTo20 = async (name: string): Promise<void> => {
		rx = await buildReactivityMesh({ nodeCount: 10, wantK: 5 });
		await rx.registerCollection(name, COLLECTION_OPTS);
		await rx.commit(name, 20);
		const ps = rx.pushStateOf(name);
		expect(ps.replayBuffer.lowRevision, 'ring low edge after W eviction').to.equal(17);
		expect(ps.checkpoint.fromRevision, 'checkpoint covers the W_checkpoint below the ring').to.equal(5);
		expect(ps.checkpoint.toRevision).to.equal(16);
	};

	it('lag < W → exactly one Backfill resolves the gap (one round trip)', async () => {
		await bringTo20('a');
		// Wakes at lastRevision 18 (lag 2 < W = 4): from = 19 is inside the ring [17..20].
		const s = await rx.subscribe(1, 'a', { lastKnownRev: 18 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s)).to.equal('backfilled');
		expect(s.delivered.map((n) => n.revision), 'backfilled 19, 20').to.deep.equal([19, 20]);
		expect(s.manager.lastRevision).to.equal(20);
		expect(s.backfills, 'resume itself is one RPC — no separate backfill seam fired').to.equal(0);
	});

	it('W ≤ lag < W + W_checkpoint → one CheckpointWindow resume from the parent checkpoint', async () => {
		await bringTo20('b');
		// Wakes at lastRevision 8 (lag 12; W = 4 ≤ 12 < 16): from = 9 is below the ring but inside the checkpoint.
		const s = await rx.subscribe(1, 'b', { lastKnownRev: 8 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s)).to.equal('checkpoint_applied');
		// The checkpoint's merged digest (the hint) was applied, then the ring's recent entries replayed.
		expect(s.checkpointDigests, 'exactly one checkpoint summary applied').to.have.length(1);
		expect(s.checkpointDigests[0]!.fromRevision).to.equal(5);
		expect(s.checkpointDigests[0]!.toRevision).to.equal(16);
		expect(s.delivered.map((n) => n.revision), 'recent entries above the checkpoint replay gap-free').to.deep.equal([17, 18, 19, 20]);
		expect(s.manager.lastRevision).to.equal(20);
		expect(s.chainRead, 'a verified checkpoint never forces a chain read').to.equal(false);
	});

	it('lag ≥ W + W_checkpoint → OutOfWindow → chain read', async () => {
		await bringTo20('c');
		// Wakes at lastRevision 2 (lag 18 ≥ 16): from = 3 is below even the checkpoint's low edge (5).
		const s = await rx.subscribe(1, 'c', { lastKnownRev: 2 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s)).to.equal('out_of_window');
		expect(s.chainRead, 'escalated to a chain read + fresh subscribe').to.equal(true);
		expect(s.delivered, 'nothing replayed — out of every window').to.have.length(0);
	});

	it('stale latestKnownTailId (slept across a rotation) → TailRotated → re-register', async () => {
		await bringTo20('d');
		const s = await rx.subscribe(1, 'd', { lastKnownRev: 18 });
		rx.sleepSubscriber(s);
		// The tail rotates while the subscriber sleeps: its tailIdAtAttach is now stale.
		const rotation = await rx.rotateTail('d');
		expect(await rx.resume(s)).to.equal('tail_rotated');
		expect(s.tailRotated, 'resume reported the new tail to re-register under').to.not.equal(undefined);
		expect(s.tailRotated![0]).to.equal(rotation.newTailIdB64);
		// The sticky cohort-hint cache was invalidated (the cached primary is under the old tree).
		expect(s.manager.cohortHint.get(rotation.newTailIdB64), 'no stale hint retained').to.equal(undefined);
	});
});

