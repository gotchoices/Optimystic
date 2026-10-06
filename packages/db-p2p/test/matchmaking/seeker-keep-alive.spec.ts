import { expect } from 'chai';
import { bytesToB64url, type RenewReplyV1, type RenewV1 } from '@optimystic/db-core';
import { SeekerKeepAlive } from '../../src/matchmaking/seeker-keep-alive.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

/** A keep-alive whose `send` answers from `replies` by member and records every member it was sent to. */
function keepAliveAnswering(replies: Record<string, RenewReplyV1['result']>): { keepAlive: SeekerKeepAlive; sentTo: string[] } {
	const sentTo: string[] = [];
	const keepAlive = new SeekerKeepAlive({
		topicId: new Uint8Array(32).fill(1),
		participantId: peerIdToBytes('seeker'),
		ttlMs: 10_000,
		sign: async () => 'AA',
		send: async (member: string, renew: RenewV1): Promise<RenewReplyV1> => {
			expect(renew.withdraw).to.equal(true);
			sentTo.push(member);
			return { v: 1, result: replies[member]! };
		},
		log: () => {},
	});
	return { keepAlive, sentTo };
}

describe('matchmaking / seeker keep-alive', () => {
	// A walk that escalates right after `accepted` withdraws before admission gossip reaches the slot primary,
	// so only the member that admitted the register is sure to hold the record.
	it('withdraws at the admitting member, and at the slot primary only when the admitting member did not withdraw it', async () => {
		const slotPrimary = bytesToB64url(peerIdToBytes('slot-primary'));

		const held = keepAliveAnswering({ 'admitting': 'withdrawn', 'slot-primary': 'unknown_registration' });
		held.keepAlive.accepted(1, 'reg-1', slotPrimary, 'admitting');
		await held.keepAlive.withdraw();

		const handedOff = keepAliveAnswering({ 'admitting': 'unknown_registration', 'slot-primary': 'withdrawn' });
		handedOff.keepAlive.accepted(1, 'reg-1', slotPrimary, 'admitting');
		await handedOff.keepAlive.withdraw();
		await handedOff.keepAlive.withdraw();

		expect(held.sentTo).to.deep.equal(['admitting']);
		expect(handedOff.sentTo, 'falls back once, and a second withdraw sends nothing').to.deep.equal(['admitting', 'slot-primary']);
	});
});
