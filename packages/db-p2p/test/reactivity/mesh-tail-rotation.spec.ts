/**
 * Reactivity **mock-tier e2e — tail-rotation continuity** (`docs/reactivity.md` §Tail rotation,
 * §Anchor — rotating with the tail block, §Worked scenarios — tail rotation during steady-state load).
 *
 * Drives the **real** rotation lifecycle over the reactivity mesh: a tail block fills under steady commit
 * load, the filling commit carries the real `rotationHint` pre-announce (built by `buildRotationHint`,
 * detected subscriber-side by the real manager's `detectRotation` → a jittered re-registration plan), the
 * tail rotates (new `tailId` → new `topicId`/coord/cohort), the outgoing replay ring is folded into a final
 * handoff checkpoint onto the new tail (`buildRotationHandoffCheckpoint` / `applyRotationHandoff`), and the
 * delivered revision stream stays **continuous with no gap across the handoff**. The old tail's drain
 * lifecycle (serve renewals/replays for `T_drain`, bounce new subscriptions with a `Promoted`-shaped
 * redirect) is exercised against the real `TailDrainGate` over the harness virtual clock.
 *
 * **At-scale burst is the simulator's.** The 10 000-subscriber re-registration wave staying within
 * `cap_promote_fast = 32` inside `T_drain = 60 s` is validated quantitatively by the design simulator
 * (`docs/reactivity.md` §Worked scenarios). Here the wave is planned via the real `planReRegistrationWave`
 * with `capPromote = cap_promote_fast`; the mock tier asserts the bound holds and the wiring composes.
 */

import { expect } from 'chai';
import { TailDrainGate, reactivityTopicId, b64urlToBytes, bytesToB64url, DEFAULT_CAP_PROMOTE_FAST, T_REJOIN_JITTER_MS } from '@optimystic/db-core';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i);

describe('reactivity / mesh — tail rotation continuity', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound. The first registration against a
	// freshly-built mesh carries a large one-time cost (single-digit seconds in isolation) that grows as a
	// full suite run accumulates load, so a single test can spend 10s+ in its opening subscribe alone. Give
	// generous headroom over the 10s default so machine load doesn't tip a passing test into a timeout.
	this.timeout(60_000);
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	it('the filling commit pre-announces the rotation; subscribers surface a jittered re-registration plan carrying lastRevision', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('books', { blockFillSize: 8 });
		const s = await rx.subscribe(1, 'books');

		await rx.commit('books', 7); // no rotation hint yet
		expect(s.rotationNotices, 'no pre-announce before the block fills').to.have.length(0);

		await rx.commit('books', 1); // the 8th commit fills the block → carries the rotationHint
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 8));
		expect(s.rotationNotices, 'exactly one pre-announce surfaced').to.have.length(1);
		const notice = s.rotationNotices[0]!;
		expect(notice.preAnnounced, 'a pre-announce, not a hard rotation').to.equal(true);
		expect(notice.newTailId).to.equal(bytesToB64url(new TextEncoder().encode('books:tail-8')));
		expect(notice.plan.lastRevision, 'the re-registration carries lastRevision (continuous across the rotation)').to.equal(8);
		expect([...notice.plan.newTopicId], 'plan targets the new tree topic').to.deep.equal([...reactivityTopicId(b64urlToBytes(notice.newTailId))]);
	});

	it('the delivered revision stream is continuous with no gap across the handoff', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('stream', { blockFillSize: 8 });
		const a = await rx.subscribe(1, 'stream');
		const b = await rx.subscribe(2, 'stream');

		await rx.commit('stream', 8); // fills the block at revision 8 (pre-announce rides revision 8)
		const rotation = await rx.rotateTail('stream');
		expect(rotation.rotationRevision).to.equal(8);

		// The outgoing replay ring folded into a final handoff checkpoint, landed on the new tail.
		expect(rotation.handoff, 'buffer-to-checkpoint handoff produced').to.not.equal(undefined);
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('stream').inheritedCheckpoint?.toRevision, 'new tail holds the old checkpoint (resume-across-rotation seam)').to.equal(8);

		// Commit on the NEW tail; the re-attached subscribers continue with no gap.
		await rx.commit('stream', 4); // revisions 9..12 on the new tree
		expect(a.delivered.map((n) => n.revision), 'continuous 1..12 across the rotation boundary').to.deep.equal(range(1, 12));
		expect(b.delivered.map((n) => n.revision)).to.deep.equal(range(1, 12));
		// Continuity is by revision monotonicity, not tail identity: revisions 1..8 rode the old tail, 9..12 the new.
		expect(a.delivered[7]!.tailId).to.not.equal(a.delivered[8]!.tailId);
	});

	it('the re-registration wave stays within cap_promote_fast (the fast-promote bound)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 10, wantK: 4 });
		await rx.registerCollection('wave', { blockFillSize: 16 });
		const subs = await Promise.all(range(1, 6).map((n) => rx.subscribe(n, 'wave')));
		await rx.commit('wave', 5);
		const rotation = await rx.rotateTail('wave');

		expect(rotation.plans, 'one re-registration plan per live subscriber').to.have.length(subs.length);
		expect(rotation.peakWindowArrivals, 'peak arrivals per T_rejoin_jitter window stays within cap_promote_fast').to.be.at.most(DEFAULT_CAP_PROMOTE_FAST);
		for (const plan of rotation.plans) {
			expect(plan.lastRevision, 'every plan carries the subscriber lastRevision (continuity)').to.equal(5);
		}
		// NOTE [unimplemented:mock-tier]: the at-scale 10k-subscriber burst peaking at exactly 32 within
		// T_drain is the design simulator's quantitative claim (docs/reactivity.md §Worked scenarios).
	});

	it('the outgoing tail drain gate serves renewals/replays and bounces new subscriptions for T_drain (Promoted-shaped redirect)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('drain', { blockFillSize: 8 });
		await rx.subscribe(1, 'drain');
		await rx.commit('drain', 8);
		const rotation = await rx.rotateTail('drain');

		// The real drain gate over the harness virtual clock (T_drain default 60 s).
		const gate = new TailDrainGate({ rotatedAt: rx.now, newTailId: rotation.newTailIdB64, effectiveAtRevision: rotation.rotationRevision + 1 });
		const redirect = gate.classify('new_subscribe', rx.now);
		expect(redirect.kind, 'a new subscription is bounced to the new tree').to.equal('redirect');
		if (redirect.kind === 'redirect') {
			expect(redirect.redirect.result).to.equal('rotated');
			expect([...b64urlToBytes(redirect.redirect.newTopicId)], 'redirect targets the new tree topic').to.deep.equal([...reactivityTopicId(rotation.newTailId)]);
		}
		expect(gate.classify('renew', rx.now).kind, 'renewals served through the drain').to.equal('serve');
		expect(gate.classify('replay', rx.now).kind, 'replays served through the drain').to.equal('serve');

		// After T_drain elapses the old tail holds nothing — every op is `drained` (re-register from d_max).
		rx.advanceTime(60_001);
		expect(gate.classify('new_subscribe', rx.now).kind).to.equal('drained');
		expect(gate.classify('replay', rx.now).kind).to.equal('drained');
	});

	it('a recover redirect drives re-registration end-to-end with no gap (markRotated → rotated reply → onRotation → scheduler → reRegister)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Default block fill (64) → no pre-announce in this short run, so the rotation is driven purely through
		// the recover redirect path (preAnnounced: false), not a notification-driven pre-announce.
		await rx.registerCollection('redir');
		const s = await rx.subscribe(1, 'redir');
		await rx.commit('redir', 8);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 8));
		expect(s.rotationNotices, 'no pre-announce before the block fills').to.have.length(0);

		// Rotate WITHOUT auto-migrating: the live recover serve models markRotated, so a stale resume is bounced.
		await rx.rotateTail('redir', { autoReattach: false });

		// The subscriber slept across the rotation; resuming against the OLD tail returns the kind:"rotated"
		// redirect, which the manager honors through the SAME onRotation seam a pre-announce uses.
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'the redirect resolves resume() as a tail rotation (never throws out)').to.equal('tail_rotated');
		expect(s.rotationNotices, 'the recover redirect surfaced a rotation once').to.have.length(1);
		expect(s.rotationNotices[0]!.preAnnounced, 'recover-driven, not a pre-announce').to.equal(false);
		expect(s.rotationNotices[0]!.newTailId).to.equal(bytesToB64url(new TextEncoder().encode('redir:tail-8')));
		expect(s.scheduler.pendingCount, 'the host scheduler armed the jittered re-registration timer').to.equal(1);

		// Until the jittered timer fires the subscriber is still on the old tail. Advance the virtual clock past
		// the jitter window → the scheduler fires reRegister → the subscriber re-attaches under the new tail.
		rx.advanceTime(T_REJOIN_JITTER_MS + 1);
		expect(s.scheduler.pendingCount, 'the re-registration timer fired over the virtual clock').to.equal(0);

		// Commit on the NEW tail; the re-attached subscriber continues with NO gap across the rotation seam.
		await rx.commit('redir', 4); // revisions 9..12 on the new tree
		expect(s.delivered.map((n) => n.revision), 'continuous 1..12 across the redirect-driven re-registration').to.deep.equal(range(1, 12));
		expect(s.manager.lastRevision).to.equal(12);
	});

	it('a cross-rotation resume is served from the inherited checkpoint (checkpoint_window, not out_of_window)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Scaled stacked windows (ring W = 4) and default block fill (64 → no pre-announce in this short run).
		await rx.registerCollection('inherit', { w: 4, wCheckpoint: 12 });
		await rx.commit('inherit', 8); // old ring holds [5..8], rolling checkpoint [1..4]

		const rotation = await rx.rotateTail('inherit');
		// The outgoing replay ring folded into a final handoff checkpoint, landed on the new tail.
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('inherit').inheritedCheckpoint?.toRevision, 'new tail holds the inherited checkpoint').to.equal(8);

		await rx.commit('inherit', 4); // new ring holds [9..12], low edge 9 abuts the inherited window's high edge 8

		// A subscriber under the NEW tail whose resume `fromRevision` (7) is below the new ring's low edge (9) but
		// within the inherited checkpoint [5..8]: served checkpoint_window from the inherited summary, then the
		// ring's recent entries — NOT out_of_window.
		const s = await rx.subscribe(2, 'inherit', { lastKnownRev: 6 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'cross-rotation resume served from the inherited checkpoint').to.equal('checkpoint_applied');
		expect(s.checkpointDigests, 'exactly one (inherited) checkpoint summary applied').to.have.length(1);
		expect(s.checkpointDigests[0]!.toRevision).to.equal(8);
		expect(s.delivered.map((n) => n.revision), 'the new ring entries replay gap-free above the inherited window').to.deep.equal([9, 10, 11, 12]);
		expect(s.manager.lastRevision).to.equal(12);
		expect(s.chainRead, 'a covered inherited checkpoint never forces a chain read').to.equal(false);
	});

	it('a cross-rotation resume bridges the inherited + new-rolling windows when the new tail evicted past the handoff (two-link chain, one round trip)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Scaled stacked windows (ring W = 4, generous W_checkpoint) and default block fill (64 → no second rotation).
		await rx.registerCollection('bridge', { w: 4, wCheckpoint: 12 });
		await rx.commit('bridge', 8); // old tail: ring [5..8], rolling checkpoint [1..4]

		const rotation = await rx.rotateTail('bridge');
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('bridge').inheritedCheckpoint?.toRevision, 'new tail holds the inherited handoff [5,8]').to.equal(8);

		// Commit ENOUGH on the new tail that its OWN rolling checkpoint forms BETWEEN the inherited window and the
		// ring: revisions 9..16 into a W=4 ring leave the ring holding [13..16] and the new rolling checkpoint
		// holding [9..12]. The three windows now stack inherited [5,8] → rolling [9,12] → ring [13,16] with no gap.
		await rx.commit('bridge', 8);
		expect(rx.pushStateOf('bridge').checkpoint.toRevision, 'new tail rolling checkpoint sits between the inherited window and the ring').to.equal(12);

		// A subscriber under the NEW tail whose resume `fromRevision` (7) is inside the inherited window [5,8] —
		// below BOTH the new rolling checkpoint [9,12] and the ring [13,16]. Pre-bridge this was out_of_window (a
		// single-checkpoint reply could not carry all three windows); now it is answered with the two-link chain.
		const s = await rx.subscribe(2, 'bridge', { lastKnownRev: 6 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'the bridge recovers the full cross-rotation span in one round trip').to.equal('checkpoint_applied');
		expect(s.checkpointDigests.map((d) => d.toRevision), 'both links applied in order: inherited [.,8] then rolling [.,12]').to.deep.equal([8, 12]);
		expect(s.delivered.map((n) => n.revision), 'the ring entries replay gap-free above the bridged chain').to.deep.equal([13, 14, 15, 16]);
		expect(s.manager.lastRevision).to.equal(16);
		expect(s.chainRead, 'the bridge never forces a chain read').to.equal(false);
	});
});

