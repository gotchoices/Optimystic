/**
 * Matchmaking **mock-tier e2e — provider lifecycle + query round-trip** (`docs/matchmaking.md`
 * §Provider registration / §Seeker query / §Capability filter).
 *
 * Drives the **real** {@link import("../../src/matchmaking/provider-manager.js").MatchmakingProviderManager}
 * → `CohortTopicService.register` walk and the **real** cohort-side `QueryV1` handler over the in-process
 * matchmaking mesh ({@link import("../../src/testing/matchmaking-mesh-harness.js").MatchmakingMesh}): a
 * provider's signed registration lands in the real tier-0 cohort store, a seeker's `QueryV1` returns it,
 * and the seeker re-validates the forwarded `registrationSig` against the provider's real Ed25519 peer
 * key. Capacity self-throttling (`setCapacity` / `signalFull` re-register) and withdrawal (record ages
 * out by TTL) are exercised against that real store — the manager-tier unit specs pin the wrapper
 * branching; this pins the substrate round-trip.
 */

import { expect } from 'chai';
import { buildMatchmakingMesh, type MatchmakingMesh } from '../../src/testing/matchmaking-mesh-harness.js';

describe('matchmaking / mesh — provider registration + query round-trip', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound and individual tests baseline at
	// 18-24s even in isolation, so a 30s budget left near-zero margin and tipped to timeout under the
	// accumulated load of the full db-p2p suite. Match the identical-profile sibling suite
	// (reactivity/mesh-tail-rotation, also 60s) so machine load does not tip a passing test into a timeout.
	this.timeout(60_000);
	let mm: MatchmakingMesh;
	afterEach(async () => {
		await mm?.stop();
	});

	it('a provider registered through the real manager lands in the cohort and a seeker query returns + re-validates it', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 8 });
		await mm.registerTopic('capability', 'pdf-render');
		const p = await mm.provide(0, 'capability', 'pdf-render', ['pdf-render', 'gpu'], 4);

		const reply = await mm.query(1, 'capability', 'pdf-render');
		const entry = reply.providers?.find((e) => e.participantId === p.member.idStr);
		expect(entry, 'the cohort returned the provider it accepted').to.not.equal(undefined);
		expect(entry!.capacityBudget).to.equal(4);
		expect(entry!.capabilities).to.deep.equal(['pdf-render', 'gpu']);
		// The advisory trust model: the seeker re-validates the forwarded registrationSig against the
		// provider's real peer key (the cohort vouches only for "the set I held").
		expect(mm.verifyEntryFor(p.topicId, entry!), 'forwarded registrationSig re-validates for real').to.equal(true);
		expect(reply.signature.length, 'reply carries the cohort primary single-member signature').to.be.greaterThan(0);
	});

	it('the cohort query applies the capability filter (must / mustNot / minBudget) over real records', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 8 });
		await mm.registerTopic('capability', 'pdf-render');
		await mm.provide(0, 'capability', 'pdf-render', ['pdf-render', 'gpu'], 4);
		await mm.provide(1, 'capability', 'pdf-render', ['pdf-render'], 1);
		await mm.provide(2, 'capability', 'pdf-render', ['gpu'], 4); // fails must:[pdf-render]

		const must = await mm.query(3, 'capability', 'pdf-render', { must: ['pdf-render'], mustNot: [] });
		expect(new Set(must.providers?.map((e) => e.participantId))).to.deep.equal(new Set([mm.members[0]!.idStr, mm.members[1]!.idStr]));

		const minBudget = await mm.query(3, 'capability', 'pdf-render', { must: ['pdf-render'], mustNot: [], minBudget: 2 });
		expect(new Set(minBudget.providers?.map((e) => e.participantId)), 'minBudget excludes the budget-1 provider').to.deep.equal(new Set([mm.members[0]!.idStr]));

		const mustNot = await mm.query(3, 'capability', 'pdf-render', { must: [], mustNot: ['gpu'] });
		expect(new Set(mustNot.providers?.map((e) => e.participantId)), 'mustNot:[gpu] excludes the gpu providers').to.deep.equal(new Set([mm.members[1]!.idStr]));
	});

	it('a pathological filter (a tag no provider holds) matches nothing', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('capability', 'pdf-render');
		await mm.provide(0, 'capability', 'pdf-render', ['pdf-render'], 4);
		await mm.provide(1, 'capability', 'pdf-render', ['gpu'], 4);
		const reply = await mm.query(2, 'capability', 'pdf-render', { must: ['nonexistent-tag'], mustNot: [] });
		expect(reply.providers ?? []).to.deep.equal([]);
	});
});

describe('matchmaking / mesh — provider self-throttling + withdrawal', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound and individual tests baseline at
	// 18-24s even in isolation, so a 30s budget left near-zero margin and tipped to timeout under the
	// accumulated load of the full db-p2p suite. Match the identical-profile sibling suite
	// (reactivity/mesh-tail-rotation, also 60s) so machine load does not tip a passing test into a timeout.
	this.timeout(60_000);
	let mm: MatchmakingMesh;
	afterEach(async () => {
		await mm?.stop();
	});

	it('signalFull re-registers with capacityBudget 0; a minBudget seeker stops matching it', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('task', 'cluster-validate');
		const p = await mm.provide(0, 'task', 'cluster-validate', ['validate'], 4);

		let entry = (await mm.query(1, 'task', 'cluster-validate')).providers?.find((e) => e.participantId === p.member.idStr);
		expect(entry!.capacityBudget).to.equal(4);

		await p.manager.signalFull();
		entry = (await mm.query(1, 'task', 'cluster-validate')).providers?.find((e) => e.participantId === p.member.idStr);
		expect(entry, 'the provider is still listed (available but full)').to.not.equal(undefined);
		expect(entry!.capacityBudget, 'capacityBudget signalled to 0 via re-registration (RenewV1 cannot carry payload)').to.equal(0);
		expect(mm.verifyEntryFor(p.topicId, entry!), 'the re-signed budget-0 entry still re-validates').to.equal(true);

		const stillWant = (await mm.query(1, 'task', 'cluster-validate', { must: [], mustNot: [], minBudget: 1 })).providers ?? [];
		expect(stillWant, 'a minBudget>=1 seeker no longer matches the full provider').to.deep.equal([]);
	});

	it('setCapacity re-registers with the new budget', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('task', 'cluster-validate');
		const p = await mm.provide(0, 'task', 'cluster-validate', ['validate'], 4);
		await p.manager.setCapacity(2);
		const entry = (await mm.query(1, 'task', 'cluster-validate')).providers?.find((e) => e.participantId === p.member.idStr);
		expect(entry!.capacityBudget).to.equal(2);
	});

	it('withdraw stops renewing; the record ages out by TTL and the seeker stops matching it', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 6 });
		await mm.registerTopic('capability', 'zk-prover');
		const p = await mm.provide(0, 'capability', 'zk-prover', ['zk'], 2);

		await p.manager.withdraw();
		// Withdrawal is an optimization, not a wire tombstone: the record lingers until TTL eviction.
		let present = (await mm.query(1, 'capability', 'zk-prover')).providers?.some((e) => e.participantId === p.member.idStr);
		expect(present, 'right after withdraw the record still lingers (ages out by TTL)').to.equal(true);

		// Advance past the provider TTL and sweep — the cohort drops it and the seeker stops matching.
		mm.sweepTopic('capability', 'zk-prover', Date.now() + mm.providerTtlMs(0) + 1);
		present = (await mm.query(1, 'capability', 'zk-prover')).providers?.some((e) => e.participantId === p.member.idStr);
		expect(present, 'after TTL sweep the withdrawn provider is gone').to.equal(false);
	});
});
