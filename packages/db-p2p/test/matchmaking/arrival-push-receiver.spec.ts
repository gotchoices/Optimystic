import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	arrivalPushSigningPayload,
	bytesToB64url,
	decodeArrivalPushAckV1,
	encodeArrivalPushV1,
	matchTopicId,
	type ArrivalPushV1,
} from '@optimystic/db-core';
import { ArrivalPushReceiver } from '../../src/matchmaking/arrival-push-receiver.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';

const topicId = matchTopicId('capability', 'pdf-render');
const correlationId = bytesToB64url(new Uint8Array(16).fill(3));

/** A push for `correlationId` signed with `key` (the pushing member's peer key). */
async function signedPush(key: PrivateKey, binding = correlationId): Promise<Uint8Array> {
	const unsigned: Omit<ArrivalPushV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topicId),
		cohortEpoch: bytesToB64url(new Uint8Array(32).fill(9)),
		correlationId: binding,
		providers: [{ participantId: 'provider-a', capabilities: ['pdf-render'], capacityBudget: 2, contactHint: 'provider-a', attachedAt: 5, registrationSig: 'AA' }],
		topicTraffic: { windowSeconds: 30, arrivalsPerMin: 1, queriesPerMin: 0, directParticipants: 2, childCohortCount: 0 },
	};
	return encodeArrivalPushV1({ ...unsigned, signature: bytesToB64url(await signPeer(key, arrivalPushSigningPayload(unsigned))) });
}

async function member(): Promise<{ key: PrivateKey; id: string }> {
	const key = await generateKeyPair('Ed25519');
	return { key, id: peerIdFromPrivateKey(key).toString() };
}

describe('matchmaking / arrival push receiver', () => {
	it('acks a push for a listening walk ok, queues it, and wakes the pending wait', async () => {
		const receiver = new ArrivalPushReceiver();
		const { channel } = receiver.subscribe(topicId, correlationId);
		const pusher = await member();

		const waited = channel.wait(60_000).then(() => 'woken' as const);
		const ack = await receiver.receive(await signedPush(pusher.key), pusher.id);
		const outcome = await Promise.race([waited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000))]);

		expect(decodeArrivalPushAckV1(ack!).result).to.equal('ok');
		expect(outcome, 'the push woke the pending wait before its timer').to.equal('woken');
		const taken = channel.take();
		expect(taken.map((p) => p.providers[0]!.participantId)).to.deep.equal(['provider-a']);
		expect(channel.take(), 'take drains the queue').to.deep.equal([]);
	});

	// docs/matchmaking.md §Edge cases: a stale push (the seeker re-registered or finished) is acked unknown_seeker.
	it('acks a push for a binding no walk listens on unknown_seeker', async () => {
		const receiver = new ArrivalPushReceiver();
		const pusher = await member();
		const subscription = receiver.subscribe(topicId, correlationId);
		subscription.unsubscribe();

		const finished = await receiver.receive(await signedPush(pusher.key), pusher.id);
		const neverHeld = await receiver.receive(await signedPush(pusher.key, bytesToB64url(new Uint8Array(16).fill(4))), pusher.id);

		expect(decodeArrivalPushAckV1(finished!).result, 'a finished walk').to.equal('unknown_seeker');
		expect(decodeArrivalPushAckV1(neverHeld!).result, 'a binding never subscribed').to.equal('unknown_seeker');
	});

	it('gives no reply to a push whose signature does not verify against the sending peer, and queues nothing', async () => {
		const receiver = new ArrivalPushReceiver();
		const { channel } = receiver.subscribe(topicId, correlationId);
		const [signer, connected] = await Promise.all([member(), member()]);

		const reply = await receiver.receive(await signedPush(signer.key), connected.id);

		expect(reply, 'no ack for a frame not provably from its sender').to.equal(undefined);
		expect(channel.take()).to.deep.equal([]);
	});
});
