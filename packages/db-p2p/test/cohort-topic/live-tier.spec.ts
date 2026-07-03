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
	compareBytes,
	encodeCohortMessage,
	membershipCertSigningPayload,
	promotionNoticeSigningPayload,
	createMembershipVerifier,
	createMembershipSourceRouter,
	createCohortSigner,
	CohortBackoffError,
	type IMembershipSource,
	type MembershipCertV1,
	type PromotionNoticeV1,
	type Tier,
} from '@optimystic/db-core';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';
import { FretTrustAnchor, type FretRingView } from '../../src/cohort-topic/fret-trust-anchor.js';
import { createVerifyOnlyThresholdCrypto } from '../../src/cohort-topic/threshold-crypto.js';
import { verifyAndApplyNotice, type NoticeApplyTarget } from '../../src/cohort-topic/host.js';
import {
	addressing,
	buildMesh,
	delay,
	makeMember,
	makeMembers,
	participantPrimaryAt,
	pumpMeshGossip,
	setupTopic,
	signedRegister,
	signedReattach,
	waitFor,
	type Member,
} from '../../src/testing/cohort-topic-mesh-harness.js';

/**
 * A collected Ed25519 multisig over `payload` by `quorum`, plus the aligned `signers` (sorted ascending so
 * `signers[i]` lines up with chunk `i`, exactly as {@link FretCohortThresholdCrypto} assembles and the db-core
 * verifier checks). Models a self-consistent threshold signature an adversary cohort can produce over its own
 * keyset.
 */
async function collectedMultisig(quorum: readonly Member[], payload: Uint8Array): Promise<{ sig: Uint8Array; signers: Uint8Array[] }> {
	const ordered = [...quorum].sort((a, b) => compareBytes(a.bytes, b.bytes));
	const sig = new Uint8Array(ordered.length * 64);
	for (let i = 0; i < ordered.length; i++) {
		sig.set(await signPeer(ordered[i]!.key, payload), i * 64);
	}
	return { sig, signers: ordered.map((m) => m.bytes) };
}

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
			// Stamp the reattach after the register's `lastPing` (= now) so the freshness gate accepts it.
			expect(decidingEngine.engine.handleRenew(await signedReattach(seedP, TOPIC, now + 1), now).result).to.equal('ok');
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
			// Stamp the reattach after the register's `lastPing` (= now) so the freshness gate accepts it.
			expect(decidingEngine.engine.handleRenew(await signedReattach(participant, TOPIC, now + 1), now).result, 'reattach touches the record').to.equal('ok');

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

	it('5b. (cold bootstrap) a brand-new cohort with NO willingness pre-seed admits its first registration after heartbeats propagate, and a sibling instantiates + replicates the record', async function () {
		this.timeout(15_000);
		const members = await makeMembers(N);
		// d_max = 0 (sizeEstimate < F²) so the walk goes straight to coord_0, keeping the repro off tier 1.
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, sizeEstimate: 16 });
		try {
			const coord0 = addressing.coord0(TOPIC);
			const deciding = mesh.nodeNearest(coord0);
			const sibling = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;

			// --- the cold-start deadlock (repro) ---
			// No `setupTopic`: every node is idle and holds no engine. FRET lands the first bootstrap register on
			// the ONE nearest member, which instantiates its engine but — with an empty willingness view — cannot
			// meet the quorum, so it declines. That is the deadlock the heartbeat + cold-sibling instantiation break.
			let firstErr: unknown;
			try {
				await mesh.nodes[0]!.host.service.register({ topicId: TOPIC, tier: 0 as Tier });
			} catch (err) {
				firstErr = err;
			}
			expect(firstErr, 'a cold cohort declines its first registration (unwilling_cohort → temporal back-off)').to.be.instanceOf(CohortBackoffError);
			const decidingEngine = deciding.host.registry.findByCoord(coord0);
			expect(decidingEngine, 'the routed member instantiated its engine on the first register').to.not.equal(undefined);
			expect(sibling.host.registry.findByCoord(coord0), 'a sibling holds no engine yet (never routed to)').to.equal(undefined);

			// --- willingness heartbeat + cold-sibling instantiation bootstrap the cohort ---
			// Wave 1: the deciding engine's first idle round emits a willingness heartbeat; every sibling
			// instantiates its own coord-0 engine off that verified co-member frame and merges its willingness.
			const now = Date.now();
			await pumpMeshGossip(mesh, now);
			expect(sibling.host.registry.findByCoord(coord0), 'a sibling instantiated its engine off the willingness heartbeat (change B)').to.not.equal(undefined);

			// Wave 2: the freshly-instantiated siblings heartbeat their own willingness back, filling the deciding
			// member's view to a quorum (self + ≥ ⌊k/2⌋ siblings). No admission-policy relaxation — the existing
			// quorum gate is now satisfied honestly.
			await pumpMeshGossip(mesh, now);
			expect(
				await waitFor(() => decidingEngine!.cohortView().all().size >= 2, 5_000),
				'the deciding member now sees enough willing siblings for the quorum',
			).to.equal(true);

			// --- register-once → accepted (the deadlock is broken) ---
			const handle = await mesh.nodes[1]!.host.service.register({ topicId: TOPIC, tier: 0 as Tier });
			expect(new Set(handle.cohortMembers.map(bytesToPeerIdString)), 'the accepted reply carries the whole cohort').to.deep.equal(new Set(members.map((m) => m.idStr)));

			// --- a sibling replicates the admitted record (the real failover path, not the harness seed) ---
			await pumpMeshGossip(mesh, Date.now());
			const siblingEngine = sibling.host.registry.findByCoord(coord0)!;
			expect(siblingEngine.holds(TOPIC, mesh.nodes[1]!.member.bytes), 'a sibling replicated the admitted record within a couple of rounds').to.equal(true);
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

	it('7. (trust anchor) a forged unrelated-keyset cert for a coord the node serves is rejected by verifyAndApplyNotice — the FRET anchor, on the promote path', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			// The verifying node serves the topic's tier-0 coord (wantK = N → every node is in every cohort), so its
			// FRET ring has authority over `coord` — the amplification-exposed `promote`-handler shape. A FRET tier
			// (T2) so the membership-source router + this anchor (not the tx-log) own the binding.
			const verifying = mesh.nodes[0]!;
			const coord = addressing.coord0(TOPIC);
			const FRET_TIER = 2;
			const now = Date.now();
			const epoch = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) & 0xff);

			// An adversary cohort of fresh keys — none of them are mesh nodes, so the ring says a wholly different
			// keyset owns `coord`. The forged cert is internally self-consistent (a real k − x multisig over the
			// adversary keyset) so ONLY the trust anchor — not self-consistency — can stop it.
			const advs = await makeMembers(N);
			const quorum = [...advs].sort((a, b) => compareBytes(a.bytes, b.bytes)).slice(0, MIN_SIGS);

			const certSignable = {
				cohortCoord: bytesToB64url(coord),
				cohortEpoch: bytesToB64url(epoch),
				members: advs.map((a) => bytesToB64url(a.bytes)),
				stabilizedAt: now,
			};
			const certMulti = await collectedMultisig(quorum, membershipCertSigningPayload(certSignable));
			const forgedCert: MembershipCertV1 = { v: 1, ...certSignable, thresholdSig: bytesToB64url(certMulti.sig), signers: certMulti.signers.map(bytesToB64url) };

			// A forged T2 promotion notice the adversary cohort genuinely threshold-signed (self-consistent against
			// the forged cert): it would verify-and-apply were the cert believed.
			const noticeSignable = { topicId: bytesToB64url(TOPIC), fromTier: FRET_TIER, toTier: FRET_TIER + 1, effectiveAt: now, cohortEpoch: bytesToB64url(epoch), cohortCoord: bytesToB64url(coord) };
			const noticeMulti = await collectedMultisig(quorum, promotionNoticeSigningPayload(noticeSignable));
			const notice: PromotionNoticeV1 = { v: 1, ...noticeSignable, thresholdSig: bytesToB64url(noticeMulti.sig), signers: noticeMulti.signers.map(bytesToB64url) };

			// Wire a verifier exactly as the host does: the FRET-ring anchor over the verifying node's ring view +
			// the verify-only collected-multisig signer + a membership source serving the forged cert (the attack:
			// a forged cert returned over `/membership`).
			const fret = mesh.fretFor(verifying.member.idStr) as unknown as FretRingView;
			const anchor = new FretTrustAnchor(fret, { k: WANT_K, selfPeerId: verifying.member.idStr });
			const encoded = encodeCohortMessage(forgedCert);
			const forgedSource: IMembershipSource = { current: () => Promise.resolve(encoded), fetch: () => Promise.resolve(encoded) };
			const router = createMembershipSourceRouter({ committed: forgedSource, fret: forgedSource });
			const signer = createCohortSigner(createVerifyOnlyThresholdCrypto(), MIN_SIGS);
			const anchoredVerifier = createMembershipVerifier({ signer, router, minSigs: MIN_SIGS, anchor });

			// Headline: the forged notice is dropped — the anchor `"rejected"`s the cert, so verifyMessage is
			// `"untrusted"` and the promotion is never applied.
			let applied = false;
			const target: NoticeApplyTarget = { servedCoord: coord, applyPromotionNotice: () => { applied = true; }, applyDemotionNotice: () => undefined, unrecordChild: () => undefined };
			const outcome = await verifyAndApplyNotice({ kind: 'promotion', notice }, target, anchoredVerifier, now);
			expect(outcome, 'the FRET anchor rejects the forged cert → the promote notice is untrusted').to.equal('untrusted');
			expect(applied, 'the forged promotion was not applied to local state').to.equal(false);

			// Control: the SAME forged cert + notice through a verifier with NO direct anchor (db-core default
			// `noAuthorityTrustAnchor`) is trust-on-first-use ACCEPTED — proving the rejection above is the FRET
			// anchor's doing, not a generic signature failure.
			const tofuVerifier = createMembershipVerifier({ signer, router, minSigs: MIN_SIGS });
			let tofuApplied = false;
			const tofuTarget: NoticeApplyTarget = { servedCoord: coord, applyPromotionNotice: () => { tofuApplied = true; }, applyDemotionNotice: () => undefined, unrecordChild: () => undefined };
			const tofuOutcome = await verifyAndApplyNotice({ kind: 'promotion', notice }, tofuTarget, tofuVerifier, now);
			expect(tofuOutcome, 'without the FRET anchor the self-consistent forgery is TOFU-accepted (no regression baseline)').to.equal('applied');
			expect(tofuApplied, 'the control verifier applied the forged promotion — the gap the anchor closes').to.equal(true);
		} finally {
			await mesh.stop();
		}
	});

	// --- rotation attestation production (cohort-topic-trust-anchor-rotation-production) ---
	// These use wantK = 4 over N = 5, so the cohort is a strict subset of the network and any single
	// membership swap changes the member set → a new epoch → a guaranteed rotation (the host attests on any
	// epoch change). The outgoing cohort co-signs the successor cert; the db-core verifier accepts it as a
	// chain extension.
	const ROT_N = 5;
	const ROT_WANT_K = 4;
	const ROT_MIN_SIGS = 4; // any member swap changes the member set → a new epoch → a rotation
	const ROT_FRET_TIER = 2; // a FRET tier → the membership-source router owns the binding (no tx-log)

	/** A no-direct-anchor verifier (chain is the only trust path beyond TOFU) over a fixed cert source. */
	function chainVerifier(serve: MembershipCertV1) {
		const encoded = encodeCohortMessage(serve);
		const source: IMembershipSource = { current: () => Promise.resolve(encoded), fetch: () => Promise.resolve(encoded) };
		const router = createMembershipSourceRouter({ committed: source, fret: source });
		const signer = createCohortSigner(createVerifyOnlyThresholdCrypto(), ROT_MIN_SIGS);
		return createMembershipVerifier({ signer, router, minSigs: ROT_MIN_SIGS });
	}

	/** Resolve the {@link Member} for a base64url-encoded dialable member id (a cert member / signer). */
	function memberOf(members: readonly Member[], b64: string): Member {
		const m = members.find((x) => bytesToB64url(x.bytes) === b64);
		if (m === undefined) {
			throw new Error(`no member for ${b64}`);
		}
		return m;
	}

	it('8. (rotation) an epoch rotation carries a predecessor-cohort rotationSig the db-core verifier accepts as a chain extension', async () => {
		const members = await makeMembers(ROT_N);
		const mesh = await buildMesh(members, { wantK: ROT_WANT_K, minSigs: ROT_MIN_SIGS });
		try {
			const { coord0, decidingEngine, deciding, cohortIds } = await setupTopic(mesh, TOPIC, addressing);
			const now = Date.now();

			// Epoch N: the first publish carries no rotation attestation (its trust is the direct anchor / root).
			const certN = await decidingEngine.onStabilized(now);
			expect(certN, 'epoch-N cert published').to.not.equal(undefined);
			expect(certN!.prevEpoch, 'a first publish carries no rotation attestation').to.equal(undefined);

			// Membership change: drop one OLD member (not the routed primary) from FRET assembly → epoch N+1.
			const victim = cohortIds.find((id) => id !== deciding.member.idStr)!;
			mesh.excludeFromAssembly(victim);

			// Epoch N+1: the first k − x changed, so the cohort threshold-signs a rotation attestation over the
			// new cert under the PRIOR cohort identity — the outgoing members co-sign the hand-off.
			const certN1 = await decidingEngine.onStabilized(now);
			expect(certN1, 'epoch-(N+1) cert published').to.not.equal(undefined);
			expect(certN1!.prevEpoch, 'the rotation cert names the predecessor epoch').to.equal(certN!.cohortEpoch);
			expect(certN1!.rotationSig, 'carries a rotation signature').to.be.a('string');
			expect(certN1!.rotationSigners!.length, 'a >= minSigs predecessor quorum signed').to.be.at.least(ROT_MIN_SIGS);
			const priorMembers = new Set(certN!.members);
			expect(certN1!.rotationSigners!.every((s) => priorMembers.has(s)), 'every rotation signer is a PRIOR-cohort member').to.equal(true);
			expect(certN1!.members.some((m) => !priorMembers.has(m)), 'the new cohort genuinely has a fresh member').to.equal(true);

			// A participant trusting cert N now trusts cert N+1 via the chain — no fresh direct anchor needed.
			const verifier = chainVerifier(certN1!);
			verifier.cache(certN!); // the trusted predecessor (blocks TOFU, so only the chain can admit N+1)
			const verdict = await verifier.verifyMessage(
				certN1!.signers.map(b64urlToBytes), coord0, ROT_FRET_TIER,
				membershipCertSigningPayload(certN1!), b64urlToBytes(certN1!.thresholdSig),
			);
			expect(verdict, 'the rotation cert is accepted as a chain extension from the trusted predecessor').to.equal('verified');
		} finally {
			await mesh.stop();
		}
	});

	it('9. (rotation) a forged rotation signed by non-prior members is rejected end-to-end', async () => {
		const members = await makeMembers(ROT_N);
		const mesh = await buildMesh(members, { wantK: ROT_WANT_K, minSigs: ROT_MIN_SIGS });
		try {
			const { coord0, decidingEngine, deciding, cohortIds } = await setupTopic(mesh, TOPIC, addressing);
			const now = Date.now();
			const certN = await decidingEngine.onStabilized(now);
			const victim = cohortIds.find((id) => id !== deciding.member.idStr)!;
			mesh.excludeFromAssembly(victim);
			const certN1 = await decidingEngine.onStabilized(now);
			expect(certN1!.rotationSig, 'a legit rotation was produced (baseline)').to.be.a('string');

			// Forge: keep the self-consistent cert, but replace the attestation with one signed by the NEW
			// cohort — which includes a member NOT in the predecessor cert (the swapped-in node). A single
			// non-prior signer must break the chain (signers ⊄ predecessor.members).
			const newCohort = certN1!.members.map((b) => memberOf(members, b));
			const forgedSig = await collectedMultisig(newCohort, membershipCertSigningPayload(certN1!));
			const forged: MembershipCertV1 = {
				...certN1!,
				rotationSig: bytesToB64url(forgedSig.sig),
				rotationSigners: forgedSig.signers.map(bytesToB64url),
			};
			expect(forged.rotationSigners!.some((s) => !certN!.members.includes(s)), 'the forged signers include a non-prior member').to.equal(true);

			const verifier = chainVerifier(forged);
			verifier.cache(certN!); // already-trusted predecessor → a failed rotation is rejected, not TOFU'd
			const verdict = await verifier.verifyMessage(
				forged.signers.map(b64urlToBytes), coord0, ROT_FRET_TIER,
				membershipCertSigningPayload(forged), b64urlToBytes(forged.thresholdSig),
			);
			expect(verdict, 'a rotation whose signers are not a prior-cohort quorum is untrusted').to.equal('untrusted');
		} finally {
			await mesh.stop();
		}
	});

	it('10. (rotation) when the predecessor quorum is unreachable the cert publishes WITHOUT an attestation (clean fallback)', async () => {
		const members = await makeMembers(ROT_N);
		const mesh = await buildMesh(members, { wantK: ROT_WANT_K, minSigs: ROT_MIN_SIGS });
		try {
			const { decidingEngine, deciding, cohortIds } = await setupTopic(mesh, TOPIC, addressing);
			const now = Date.now();
			const certN = await decidingEngine.onStabilized(now);
			expect(certN, 'epoch-N cert published').to.not.equal(undefined);

			// Drop the victim from assembly AND crash it: the new cohort (with the 5th node) still reaches its
			// own minSigs, but the OUTGOING cohort can no longer (the victim is unreachable for the /sign round).
			const victim = cohortIds.find((id) => id !== deciding.member.idStr)!;
			mesh.excludeFromAssembly(victim);
			mesh.crashNode(victim);

			const certN1 = await decidingEngine.onStabilized(now);
			expect(certN1, 'the rotation cert still publishes (its own quorum is intact)').to.not.equal(undefined);
			expect(certN1!.prevEpoch, 'but with NO rotation attestation (predecessor quorum unreachable)').to.equal(undefined);
			expect(certN1!.rotationSig, 'and no rotation signature').to.equal(undefined);
			expect(certN1!.rotationSigners, 'and no rotation signers').to.equal(undefined);
		} finally {
			await mesh.stop();
		}
	});

	it('11. (rotation) a non-rotation republish (periodic refresh, unchanged membership) emits no rotation fields', async () => {
		const members = await makeMembers(ROT_N);
		const mesh = await buildMesh(members, { wantK: ROT_WANT_K, minSigs: ROT_MIN_SIGS });
		try {
			const { decidingEngine } = await setupTopic(mesh, TOPIC, addressing);
			const now = Date.now();
			const certN = await decidingEngine.onStabilized(now);
			expect(certN, 'first publish').to.not.equal(undefined);

			// A periodic refresh past T_membership_refresh with NO membership change → a republish, but not a
			// rotation (the epoch did not change), so it must carry no rotation fields.
			const refreshed = await decidingEngine.pumpMembership(now + 5 * 60_000 + 1);
			expect(refreshed, 'the refresh republished the cert').to.not.equal(undefined);
			expect(refreshed!.cohortEpoch, 'same membership → same epoch').to.equal(certN!.cohortEpoch);
			expect(refreshed!.prevEpoch, 'a non-rotation refresh emits no rotation attestation').to.equal(undefined);
			expect(refreshed!.rotationSig, 'and no rotation signature').to.equal(undefined);
		} finally {
			await mesh.stop();
		}
	});
});
