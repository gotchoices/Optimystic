import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { bytesEqual, bytesToB64url, registerSigningPayload, renewSigningPayload, type RegisterV1, type RenewV1 } from '@optimystic/db-core';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';
import { addressing, makeMember, PROTOCOLS, signedWillingness, slots, waitFor, type Member } from '../../src/testing/cohort-topic-mesh-harness.js';
import { createInboundHost, FRESH_AHEAD_MS, nobleOnlySignature, randomTopic, registerBody, renewBody, type FrameAnswer, type InboundHost } from './inbound-frame-helpers.js';

/** The signatures a live-signer host refuses, each signed over the frame it arrives on. */
const FORGERIES: readonly { readonly name: string; readonly sign: (participant: Member, payload: Uint8Array) => Promise<Uint8Array> | Uint8Array }[] = [
	// Fails if any path below verifies with `verifyPeerSig` rather than the platform verifier.
	{ name: 'a signature only noble accepts', sign: (participant, payload) => nobleOnlySignature(participant.key, payload) },
	{ name: "a different key's signature", sign: async (_participant, payload) => signPeer(await generateKeyPair('Ed25519'), payload) },
	{ name: 'no signature', sign: () => new Uint8Array(0) },
];

const signRegister = (body: Omit<RegisterV1, 'signature'>, signature: Uint8Array): RegisterV1 => ({ ...body, signature: bytesToB64url(signature) });
const signRenew = (body: Omit<RenewV1, 'signature'>, signature: Uint8Array): RenewV1 => ({ ...body, signature: bytesToB64url(signature) });

/** A host that is a computed backup of `participant`'s record, whose stored primary is the cohort's other member. */
async function backupHoldingARecord(): Promise<{ inbound: InboundHost; other: Member; participant: Member; topic: Uint8Array }> {
	const other = await makeMember();
	const inbound = await createInboundHost({ others: [other] });
	const topic = randomTopic();
	const coord = addressing.coord0(topic);
	const engine = inbound.host.registry.forCoord(coord, 0, other.bytes);
	const { members, cohortEpoch } = engine.cohort();
	// The admission quorum of a two-member cohort is both members.
	inbound.node.receive(PROTOCOLS.gossip, await signedWillingness(other, coord, cohortEpoch, Date.now()), other.peerId);
	await waitFor(() => engine.cohortView().all().size > 0);
	let participant = await makeMember();
	while (!bytesEqual(slots.assignSlots(participant.bytes, cohortEpoch, members).primary, other.bytes)) {
		participant = await makeMember();
	}
	const body = registerBody(participant, topic);
	const admitted = await inbound.overStream(signRegister(body, await signPeer(participant.key, registerSigningPayload(body))));
	expect(admitted.result, 'the record to act on is admitted').to.equal('accepted');
	return { inbound, other, participant, topic };
}

/**
 * Every inbound path a signature guards, driven through the real handlers on a keyed host. Each case ends with the
 * same frame correctly signed, on the same host, so a refusal above it can only have come from the signature.
 */
describe('cohort-topic: a frame from another machine is authenticated before the engine sees it', () => {
	const registerPaths: readonly { readonly name: string; readonly send: (inbound: InboundHost, frame: RegisterV1) => Promise<FrameAnswer> }[] = [
		{ name: 'over the stream', send: (inbound, frame) => inbound.overStream(frame) },
		{ name: 'through the activity handler', send: (inbound, frame) => inbound.overActivity(frame) },
	];

	for (const path of registerPaths) {
		it(`a register ${path.name} needs a valid signature: it holds no record and creates no engine without one`, async () => {
			const inbound = await createInboundHost();
			try {
				const participant = await makeMember();
				const topic = randomTopic();
				const body = registerBody(participant, topic);
				for (const forgery of FORGERIES) {
					const reply = await path.send(inbound, signRegister(body, await forgery.sign(participant, registerSigningPayload(body))));
					expect(reply.result, forgery.name).to.equal('no_state');
				}
				expect(inbound.host.registry.all(), 'no coord engine was created').to.have.length(0);
				const reply = await path.send(inbound, signRegister(body, await signPeer(participant.key, registerSigningPayload(body))));
				expect(reply.result, 'correctly signed').to.equal('accepted');
				expect(inbound.host.registry.findHolder(topic, participant.bytes), 'the record is held').to.not.equal(undefined);
			} finally {
				await inbound.host.stop();
			}
		});
	}

	it('a probe needs a valid signature: a served topic resolves only with one, and a cold topic gets no engine without one', async () => {
		const inbound = await createInboundHost();
		try {
			const seeded = await makeMember();
			const served = randomTopic();
			const seedBody = registerBody(seeded, served);
			await inbound.overStream(signRegister(seedBody, await signPeer(seeded.key, registerSigningPayload(seedBody))));

			const prober = await makeMember();
			const servedProbe = registerBody(prober, served, { probe: true });
			const cold = randomTopic();
			const coldProbe = registerBody(prober, cold, { probe: true });
			for (const forgery of FORGERIES) {
				const servedReply = await inbound.overStream(signRegister(servedProbe, await forgery.sign(prober, registerSigningPayload(servedProbe))));
				expect(servedReply.result, `${forgery.name}, served topic`).to.equal('no_state');
				const coldReply = await inbound.overStream(signRegister(coldProbe, await forgery.sign(prober, registerSigningPayload(coldProbe))));
				expect(coldReply.result, `${forgery.name}, cold topic`).to.equal('no_state');
			}
			expect(inbound.host.registry.findByCoord(addressing.coord0(cold)), 'no coord engine for the cold topic').to.equal(undefined);

			const accepted = await inbound.overStream(signRegister(servedProbe, await signPeer(prober.key, registerSigningPayload(servedProbe))));
			expect(accepted.result, 'correctly signed, served topic').to.equal('accepted');
			await inbound.overStream(signRegister(coldProbe, await signPeer(prober.key, registerSigningPayload(coldProbe))));
			expect(inbound.host.registry.findByCoord(addressing.coord0(cold)), 'correctly signed, cold topic reaches an engine').to.not.equal(undefined);
		} finally {
			await inbound.host.stop();
		}
	});

	it('a re-attach needs a valid signature: without one it is redirected and the stored primary stays', async () => {
		const { inbound, other, participant, topic } = await backupHoldingARecord();
		try {
			const body = { ...renewBody(participant, topic, Date.now() + FRESH_AHEAD_MS), reattach: true };
			const storedPrimary = (): Uint8Array => inbound.host.registry.findHolder(topic, participant.bytes)!.heldRecord(topic, participant.bytes)!.primary;
			for (const forgery of FORGERIES) {
				const reply = await inbound.overStream(signRenew(body, await forgery.sign(participant, renewSigningPayload(body))));
				expect(reply.result, forgery.name).to.equal('primary_moved');
				expect(bytesEqual(storedPrimary(), other.bytes), `${forgery.name} usurped no primary`).to.equal(true);
			}
			const reply = await inbound.overStream(signRenew(body, await signPeer(participant.key, renewSigningPayload(body))));
			expect(reply.result, 'correctly signed').to.equal('ok');
			expect(bytesEqual(storedPrimary(), inbound.self.bytes), 'the backup promoted itself').to.equal(true);
		} finally {
			await inbound.host.stop();
		}
	});

	it('a withdraw needs a valid signature: without one it reveals nothing and the record stays', async () => {
		const { inbound, participant, topic } = await backupHoldingARecord();
		try {
			const body = { ...renewBody(participant, topic, Date.now() + FRESH_AHEAD_MS), withdraw: true };
			for (const forgery of FORGERIES) {
				const reply = await inbound.overStream(signRenew(body, await forgery.sign(participant, renewSigningPayload(body))));
				expect(reply.result, forgery.name).to.equal('unknown_registration');
				expect(inbound.host.registry.findHolder(topic, participant.bytes), `${forgery.name} evicted nothing`).to.not.equal(undefined);
			}
			const reply = await inbound.overStream(signRenew(body, await signPeer(participant.key, renewSigningPayload(body))));
			expect(reply.result, 'correctly signed').to.equal('withdrawn');
			expect(inbound.host.registry.findHolder(topic, participant.bytes), 'the record is gone').to.equal(undefined);
		} finally {
			await inbound.host.stop();
		}
	});
});
