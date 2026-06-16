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
import { TailDrainGate, reactivityTopicId, b64urlToBytes, bytesToB64url, DEFAULT_CAP_PROMOTE_FAST } from '@optimystic/db-core';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i);

describe('reactivity / mesh — tail rotation continuity', () => {
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
		const rotation = rx.rotateTail('stream');
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
		const rotation = rx.rotateTail('wave');

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
		const rotation = rx.rotateTail('drain');

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
});

