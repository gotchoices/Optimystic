/**
 * Matchmaking **mock-tier e2e — arrival push** (`docs/matchmaking.md` §Arrival push on provider arrival).
 *
 * Drives the real cohort-side {@link import("../../src/matchmaking/arrival-push-driver.js").ArrivalPushDriver}
 * on every member, fed by each real host's `onRecordAdded` over real registrations and real cohort gossip, and
 * the real seeker walk on the push path, listening on its member's real
 * {@link import("../../src/matchmaking/arrival-push-receiver.js").ArrivalPushReceiver}. Delivery between them
 * is in process. The walks run on the mesh's shared virtual time, so a test places each arrival inside a hang-out
 * and moves the coalescing window and the polls with `advance`.
 *
 * The selection rules and the coalescing arithmetic are pinned at the unit tier (`arrival-push.spec.ts` in
 * db-core, `arrival-push-driver.spec.ts` here); these cases show the pieces composing over a real cohort.
 */

import { expect } from 'chai';
import { DEFAULT_ARRIVAL_PUSH_CONFIG, DEFAULT_HANG_OUT_CONFIG } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { addressing, slots } from '../../src/testing/cohort-topic-mesh-harness.js';
import { buildMatchmakingMesh, type MatchmakingMesh } from '../../src/testing/matchmaking-mesh-harness.js';

describe('matchmaking / mesh — arrival push', function () {
	// Same ceiling as the rest of the real-Ed25519 mesh e2e class (see mesh-walk.spec.ts).
	this.timeout(120_000);
	let mm: MatchmakingMesh;
	afterEach(async () => {
		await mm?.stop();
	});

	it('fresh arrival pushes to the waiting seeker: it returns the provider after one coalescing window with no query past its immediate one, while a poll-path seeker finds it only by polling (docs §Test expectations — fresh arrival pushes to longest waiters)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('task', 'render-farm');
		// One provider before the seekers arrive: fewer than either seeker's wantCount of 2.
		await mm.provide(0, 'task', 'render-farm', ['render'], 4);
		await mm.gossipReplicate('task', 'render-farm');

		const pushSeeker = mm.members[4]!.idStr;
		const pollSeeker = mm.members[5]!.idStr;
		const pushed = mm.startSeek(4, 'task', 'render-farm', 2, { pushOnArrival: true });
		const polled = mm.startSeek(5, 'task', 'render-farm', 2);
		await waitFor(() => pushed.parked() && polled.parked(), { timeoutMs: 20_000, description: 'both seekers are hanging out at the root' });
		// Both seekers registered with the routed primary; one gossip round gives every member their records.
		await mm.gossipReplicate('task', 'render-farm');

		const arrival = await mm.provide(1, 'task', 'render-farm', ['render'], 4);
		await mm.gossipReplicate('task', 'render-farm');
		await mm.advance(DEFAULT_ARRIVAL_PUSH_CONFIG.coalesceMs);
		await waitFor(() => mm.pushSends.length > 0, { timeoutMs: 10_000, description: 'the slot primary pushed the arrival' });

		const viaPush = await pushed.done;
		expect(viaPush.metWantCount, 'the push met the seeker\'s wantCount').to.equal(true);
		expect(viaPush.providers.map((p) => p.participantId), 'the pushed provider is matched').to.include(arrival.member.idStr);
		expect(viaPush.queries, 'no query beyond the immediate one at the root').to.equal(1);
		expect(viaPush.hungOutMs, 'answered within one coalescing window').to.be.at.most(DEFAULT_ARRIVAL_PUSH_CONFIG.coalesceMs);
		expect(mm.pushSends.filter((s) => s.to === pushSeeker), 'one push, from one member').to.have.length(1);
		expect(mm.pushSends.some((s) => s.to === pollSeeker), 'a poll-path seeker is never pushed').to.equal(false);

		// The contrast: the poll-path seeker sees the same arrival only at its next requery.
		await mm.advance(DEFAULT_HANG_OUT_CONFIG.requeryIntervalMs);
		const viaPoll = await polled.done;
		expect(viaPoll.metWantCount, 'the poll found the provider').to.equal(true);
		expect(viaPoll.providers.map((p) => p.participantId)).to.include(arrival.member.idStr);
		expect(viaPoll.queries, 'found by a hang-out poll, not the immediate query').to.be.greaterThan(1);
	});

	it('each selected seeker is pushed by exactly one cohort member — its slot primary (docs §Fairness — who computes the set, and who sends)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('task', 'gpu-batch');
		const seekerIndices = [3, 4, 5];
		const walks = seekerIndices.map((i) => mm.startSeek(i, 'task', 'gpu-batch', 1, { pushOnArrival: true }));
		await waitFor(() => walks.every((w) => w.parked()), { timeoutMs: 20_000, description: 'every seeker is hanging out at the root' });
		await mm.gossipReplicate('task', 'gpu-batch');

		// capacityBudget 3 selects all three seekers. Each wants one provider, so each push goes out at once.
		const arrival = await mm.provide(0, 'task', 'gpu-batch', ['gpu'], 3);
		await mm.gossipReplicate('task', 'gpu-batch');
		await waitFor(() => mm.pushSends.length >= seekerIndices.length, { timeoutMs: 10_000, description: 'every selected seeker was pushed' });

		const results = await Promise.all(walks.map((w) => w.done));
		for (const r of results) {
			expect(r.providers.map((p) => p.participantId), 'every seeker returned the pushed provider').to.include(arrival.member.idStr);
			expect(r.queries, 'no query beyond the immediate one').to.equal(1);
		}
		// Every member holds the same records and the same cohort view, so every member selects all three seekers;
		// each seeker is pushed only by the member the slot rule names, so once in total.
		const engine = mm.mesh.nodes[0]!.host.registry.findByCoord(addressing.coord0(mm.topicId('task', 'gpu-batch')))!;
		const { members, cohortEpoch } = engine.cohort();
		const expected = seekerIndices.map((i) => ({
			from: bytesToPeerIdString(slots.assignSlots(mm.members[i]!.bytes, cohortEpoch, members).primary),
			to: mm.members[i]!.idStr,
		}));
		const byTo = (a: { to: string }, b: { to: string }): number => a.to.localeCompare(b.to);
		expect([...mm.pushSends].sort(byTo), 'one push per seeker, each from its slot primary').to.deep.equal(expected.sort(byTo));
	});
});
