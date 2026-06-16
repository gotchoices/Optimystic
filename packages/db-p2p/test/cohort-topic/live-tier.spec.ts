/**
 * Cohort-topic **live-tier** end-to-end milestone (`tickets/.../cohort-topic-live-tier-e2e`).
 *
 * Stands up an `N ≥ minSigs` in-process multi-node cohort over **real Ed25519 keys** (one
 * `generateKeyPair('Ed25519')` per node) and a **mock transport** that routes the five cohort-topic
 * protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) plus FRET's
 * `routeAct` / `assembleCohort` directly between the in-process node engines — no real libp2p sockets.
 * It proves the prereq machinery *composes*:
 *
 *  1. **Real cohort** — the cohort serving a topic at tier 0 is `assembleCohort(coord_0(topicId))` =
 *     all N nodes, computed identically (member set + epoch) on every node (per-coord scoping +
 *     deterministic assembly).
 *  2. **Register through the walk** — `service.register` resolves an `accepted` handle whose `primary`
 *     is a cohort member and whose `cohortMembers` is the N-node set, after a real walk-toward-root.
 *  3. **Real threshold signature** — the cohort publishes a `MembershipCertV1` whose collected `k − x`
 *     multisig a participant's `verifier().verifyMessage(...)` accepts (`"verified"`); a forged
 *     single-signer cert (the interim shape) is rejected (`"untrusted"`).
 *  4. **Promotion end-to-end** — past `cap_promote`, the tier-0 cohort threshold-signs a
 *     `PromotionNoticeV1`, broadcasts it over `promote`, a node that did **not** originate it
 *     verify-applies it, and a later registration walk gets `Promoted(1)`, recomputes `coord_1`, gets
 *     `no_state`, walks back to 0, and terminates within `maxSteps` (single-cohort termination).
 *  5. **Gossip replication** — a record accepted on the routed primary replicates into a sibling's
 *     store in one gossip round; an eviction converges.
 *
 * Plus the negative: with one node dropped below quorum, the cohort signature is **not** produced (no
 * single-signer fallback — assembly throws).
 *
 * The mock-transport mesh machinery (`CohortMesh`, `MockNode`, signed-frame builders, `setupTopic`) is
 * the shared {@link import("../../src/testing/cohort-topic-mesh-harness.js")} harness — extracted from
 * this milestone so the at-scale suites (`cohort-topic-scale-*.spec.ts`) reuse it. The mock-tier unit
 * coverage (`service.spec.ts`, per-coord scoping with a fret returning a different set per coord) stays;
 * this is the real-multi-node composition on top of it.
 */

import { expect } from 'chai';
import {
	bytesEqual,
	bytesToB64url,
	b64urlToBytes,
	membershipCertSigningPayload,
	CohortBackoffError,
	type Tier,
} from '@optimystic/db-core';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';
import {
	addressing,
	buildMesh,
	delay,
	makeMember,
	makeMembers,
	participantPrimaryAt,
	setupTopic,
	signedRegister,
	signedReattach,
	waitFor,
} from '../../src/testing/cohort-topic-mesh-harness.js';

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
const N = 5;
const WANT_K = N;
const MIN_SIGS = N - 1; // 4-of-5 quorum (the production minSigs = 14 path is identical, just larger)

describe('cohort-topic: live-tier end-to-end milestone', () => {
	it('1. the cohort serving the topic at tier 0 is assembleCohort(coord_0(topic)) = all N nodes, computed identically everywhere', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0, engines } = await setupTopic(mesh, TOPIC, addressing);

			const expected = new Set(mesh.assembleCohort(coord0, WANT_K));
			expect(expected.size, 'wantK = N → the tier-0 cohort is the whole network').to.equal(N);
			expect(expected, 'cohort = every node').to.deep.equal(new Set(members.map((m) => m.idStr)));

			// Every node independently computes the SAME cohort member set AND the same epoch for coord_0 —
			// the determinism the threshold-signature collection depends on (a fragmented cohort can't quorum).
			const epochs = new Set<string>();
			for (const node of mesh.nodes) {
				const engine = engines.get(node.member.idStr)!;
				const members0 = new Set(engine.cohort().members.map(bytesToPeerIdString));
				expect(members0, `node ${node.member.idStr} assembles the whole-network cohort around coord_0`).to.deep.equal(expected);
				expect(engine.treeTier, 'instantiated at tier 0').to.equal(0);
				epochs.add(bytesToB64url(engine.cohort().cohortEpoch));
			}
			expect(epochs.size, 'all N nodes derive one identical cohort epoch for coord_0').to.equal(1);
		} finally {
			await mesh.stop();
		}
	});

	it('2. a participant registers through the walk → accepted handle (primary ∈ cohort, cohortMembers = the N-node set)', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0 } = await setupTopic(mesh, TOPIC, addressing);

			// nodes[0] is the participant; its service drives the real walk-toward-root over the mock router.
			const handle = await mesh.nodes[0]!.host.service.register({ topicId: TOPIC, tier: 0 as Tier });

			const cohortIds = new Set(handle.cohortMembers.map(bytesToPeerIdString));
			expect(cohortIds, 'the accepted reply carries the full N-node cohort').to.deep.equal(new Set(members.map((m) => m.idStr)));
			expect(cohortIds.has(bytesToPeerIdString(handle.primary)), 'the assigned primary is a cohort member').to.equal(true);
			expect(bytesToB64url(handle.cohortEpoch), 'the handle epoch is the deterministic coord_0 epoch').to.equal(bytesToB64url(mesh.nodeNearest(coord0).host.registry.forCoord(coord0, 0 as Tier, members[0]!.bytes).cohort().cohortEpoch));
		} finally {
			await mesh.stop();
		}
	});

	it('3. the cohort publishes a real k − x threshold-signed cert a participant verifier accepts; a forged single-signer cert is untrusted', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0, decidingEngine, deciding } = await setupTopic(mesh, TOPIC, addressing);

			// The routed-primary cohort assembles a genuine collected k − x multisig over its membership and
			// serves it on the `membership` protocol.
			const cert = await decidingEngine.onStabilized(Date.now());
			expect(cert, 'the cohort published a membership cert').to.not.equal(undefined);
			expect(cert!.signers.length, 'at least minSigs distinct signers').to.be.at.least(MIN_SIGS);
			expect(new Set(cert!.signers).size, 'signers are distinct').to.equal(cert!.signers.length);
			const certMembers = new Set(cert!.members);
			expect(cert!.signers.every((s) => certMembers.has(s)), 'every signer is a cohort member').to.equal(true);

			// A *different* node's participant verifier fetches the cert over the `membership` protocol and
			// verifies the real multisig for real.
			const participant = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const verifier = participant.host.service.verifier();
			const certPayload = membershipCertSigningPayload(cert!);
			expect(
				await verifier.verifyMessage(cert!.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert!.thresholdSig)),
				'a participant verifies the real threshold-signed cert end-to-end',
			).to.equal('verified');

			// The interim shape — a single-signer "threshold" sig — must be rejected at minSigs = 4.
			const forgedSig = await signPeer(members[0]!.key, certPayload);
			expect(
				await verifier.verifyMessage([members[0]!.bytes], coord0, 0, certPayload, forgedSig),
				'a forged single-signer cert is untrusted',
			).to.equal('untrusted');
		} finally {
			await mesh.stop();
		}
	});

	it('4. promotion end-to-end: the cohort threshold-signs + broadcasts a notice, a non-originator verify-applies it, and a later walk gets Promoted(1) and terminates', async function () {
		this.timeout(15_000);
		const capPromote = 4;
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
		try {
			const { coord0, decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC, addressing);

			// Publish the coord-0 cert on the routed primary so a sibling can fetch it to verify the notice.
			await decidingEngine.onStabilized(Date.now());

			// Seed one replicated record into every sibling (register + reattach to force a gossip touch, then
			// one round broadcasts it), so a sibling *serves the topic* and can apply an inbound promotion.
			const now = Date.now();
			const seedP = await participantPrimaryAt(deciding, decidingEngine);
			expect((await decidingEngine.engine.handleRegister(await signedRegister(seedP, TOPIC, now, 'seed'), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');
			expect(decidingEngine.engine.handleRenew(await signedReattach(seedP, TOPIC, now), now).result).to.equal('ok');
			await decidingEngine.gossipRound(now);
			await delay(30);
			const sibling = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const siblingEngine = engines.get(sibling.member.idStr)!;
			expect(siblingEngine.servesTopic(TOPIC), 'a sibling replicated the seed record and now serves the topic').to.equal(true);
			expect(siblingEngine.isPromoted(TOPIC), 'not promoted yet').to.equal(false);

			// Drive direct participants up to cap_promote on the routed primary (the seed already counts as 1,
			// so `cap_promote − 1` more cross the threshold). The cap-crossing arrival still replies `accepted`
			// (promotion fires fire-and-forget after the record lands) and asynchronously threshold-signs a
			// real PromotionNoticeV1 the host broadcasts over `promote` to the cohort.
			for (let i = 0; i < capPromote - 1; i++) {
				const p = await makeMember();
				const reply = await decidingEngine.engine.handleRegister(await signedRegister(p, TOPIC, now, `promote-${i}`), { followOn: false, treeTier: 0 }, now);
				expect(reply.result, `bulk register ${i} admitted`).to.equal('accepted');
			}

			// The originator adopts promoted mode once the threshold-sign round completes; a node that did NOT
			// originate the notice verify-applies it (over the `promote` + `membership` protocols).
			expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'the originating cohort is promoted').to.equal(true);
			expect(await waitFor(() => siblingEngine.isPromoted(TOPIC), 8_000), 'a non-originating cohort node verify-applied the promotion notice').to.equal(true);

			// One more registration past cap_promote now gets the cheap Promoted(d+1) redirect, not an accept.
			const past = await makeMember();
			const redirect = await decidingEngine.engine.handleRegister(await signedRegister(past, TOPIC, now, 'past-cap'), { followOn: false, treeTier: 0 }, now);
			expect(redirect.result, 'a registration past cap_promote is redirected onward').to.equal('promoted');
			expect(redirect.targetTier, 'redirected to the next tier').to.equal(1);

			// A subsequent registration walk now gets Promoted(1) at coord_0, recomputes coord_1, gets no_state
			// (no tier-1 cohort), walks back to 0, and terminates within maxSteps (single-cohort termination).
			mesh.clearRouteLog();
			const walker = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			let backoff: unknown;
			try {
				await walker.host.service.register({ topicId: TOPIC, tier: 0 as Tier });
			} catch (err) {
				backoff = err;
			}
			expect(backoff, 'the post-promotion walk terminates with a temporal back-off, not a hang').to.be.instanceOf(CohortBackoffError);
			const coord1 = addressing.coord(1, walker.member.bytes, TOPIC);
			expect(mesh.routeKeys.includes(bytesToB64url(coord1)), 'the walk recomputed coord_1 and probed it').to.equal(true);
			expect(mesh.routeKeys.includes(bytesToB64url(coord0)), 'the walk also (re)probed coord_0 (the promoted redirect)').to.equal(true);
		} finally {
			await mesh.stop();
		}
	});

	it('5. gossip replication: a record accepted on the routed primary replicates into a sibling store; an eviction converges', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC, addressing);
			const sibling = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const siblingEngine = engines.get(sibling.member.idStr)!;

			const participant = await participantPrimaryAt(deciding, decidingEngine);
			const now = Date.now();
			expect((await decidingEngine.engine.handleRegister(await signedRegister(participant, TOPIC, now, 'repl'), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');
			expect(decidingEngine.engine.handleRenew(await signedReattach(participant, TOPIC, now), now).result, 'reattach touches the record').to.equal('ok');

			// One gossip round broadcasts the touched record to the cohort over the `cohort-gossip` protocol.
			const g = await decidingEngine.gossipRound(now);
			expect(g?.records?.length, 'the round carries the touched record').to.equal(1);
			await delay(30);
			expect(siblingEngine.holds(TOPIC, participant.bytes), 'the sibling replicated the record in one round').to.equal(true);

			// Let the record go stale, sweep it on the primary, and gossip the eviction — the sibling converges.
			const later = now + 90_000 + 1;
			const gEvict = await decidingEngine.gossipRound(later);
			expect(gEvict?.evicted?.length, 'the stale record was swept and queued as an eviction').to.equal(1);
			await delay(30);
			expect(siblingEngine.holds(TOPIC, participant.bytes), 'the sibling converged on the eviction').to.equal(false);
		} finally {
			await mesh.stop();
		}
	});

	it('6. (negative) with one node dropped below quorum the cohort signature is NOT produced — no single-signer fallback', async () => {
		const members = await makeMembers(N);
		// minSigs = N: every member must endorse, so one unreachable node makes the quorum unreachable.
		const downMember = members[N - 1]!;
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: N, downNodes: [downMember.idStr] });
		try {
			const coord0 = addressing.coord0(TOPIC);
			// Assemble from a reachable node (it can dial out; only dials TO the down node fail).
			const assembler = mesh.nodes.find((n) => n.member.idStr !== downMember.idStr)!;
			const engine = assembler.host.registry.forCoord(coord0, 0 as Tier, assembler.member.bytes);

			let threw = false;
			try {
				await engine.onStabilized(Date.now());
			} catch {
				threw = true;
			}
			expect(threw, 'sub-quorum assembly throws rather than fabricating a single-signer cert').to.equal(true);
		} finally {
			await mesh.stop();
		}
	});
});
