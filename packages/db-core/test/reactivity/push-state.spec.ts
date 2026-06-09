import { expect } from 'chai';
import {
	PushState,
	encodePushStateGossipV1,
	decodePushStateGossipV1,
	makeCohortRef,
	cohortRefCoordBytes,
	type NotificationV1,
} from '../../src/reactivity/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';

const b = (n: number): string => bytesToB64url(new Uint8Array([n]));

function makeNotification(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: b(1),
		tailId: b(2),
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [b(8)],
	};
}

function seed(state: PushState, revs: number[]): void {
	for (const rev of revs) {
		state.replayBuffer.append({ revision: rev, payload: makeNotification(rev), receivedAt: 1000 + rev });
		state.dedupe.observe(rev, `sig-${rev}`);
		if (rev > state.lastRevision) {
			state.lastRevision = rev;
		}
	}
}

const newState = (): PushState =>
	new PushState({
		collectionId: b(1),
		topicId: b(3),
		tailIdAtJoin: b(2),
		parentCohort: makeCohortRef(new Uint8Array([4]), new Uint8Array([5])),
		childCohorts: [makeCohortRef(new Uint8Array([6]))],
	});

describe('reactivity push state', () => {
	it('reserves the sibling-ticket fields (parentCheckpoint / perSubscriberQueue) without populating them', () => {
		const state = newState();
		expect(state.parentCheckpoint).to.equal(undefined);
		expect(state.perSubscriberQueue.size).to.equal(0);
	});

	describe('gossip codec', () => {
		it('round-trips a serialized push state losslessly', () => {
			const state = newState();
			seed(state, [10, 11, 12]);
			const gossip = state.serializeGossip();
			const decoded = decodePushStateGossipV1(encodePushStateGossipV1(gossip));
			expect(decoded).to.deep.equal(gossip);
		});

		it('round-trips a state with no parent cohort (tail/root)', () => {
			const state = new PushState({ collectionId: b(1), topicId: b(3), tailIdAtJoin: b(2) });
			seed(state, [1]);
			const gossip = state.serializeGossip();
			expect(gossip).to.not.have.property('parentCohort');
			expect(decodePushStateGossipV1(encodePushStateGossipV1(gossip))).to.deep.equal(gossip);
		});

		it('rejects a malformed gossip frame (non-base64url topicId)', () => {
			const state = newState();
			const gossip = { ...state.serializeGossip(), topicId: '!!bad!!' };
			expect(() => encodePushStateGossipV1(gossip)).to.throw(CohortWireError, /base64url/);
		});

		it('exposes cohort-ref coord byte helpers', () => {
			const ref = makeCohortRef(new Uint8Array([4, 5, 6]));
			expect([...cohortRefCoordBytes(ref)]).to.deep.equal([4, 5, 6]);
		});
	});

	describe('merge (cohort convergence so any member can serve)', () => {
		it('unions replay entries, dedupe keys, and advances lastRevision', () => {
			const a = newState();
			const b1 = newState();
			seed(a, [10, 11]);
			seed(b1, [12, 13]);
			b1.mergeGossip(a.serializeGossip());
			expect(b1.replayBuffer.range(10, 13).map((e) => e.revision)).to.deep.equal([10, 11, 12, 13]);
			expect(b1.lastRevision).to.equal(13);
			// dedupe converged: a's revision 10 is now seen at b1.
			expect(b1.dedupe.has(10, 'sig-10')).to.equal(true);
		});

		it('ignores gossip for a different collection/topic', () => {
			const a = newState();
			seed(a, [10]);
			const foreign = new PushState({ collectionId: b(9), topicId: b(9), tailIdAtJoin: b(2) });
			seed(foreign, [10]);
			const before = a.replayBuffer.size;
			a.mergeGossip(foreign.serializeGossip());
			expect(a.replayBuffer.size).to.equal(before);
		});

		it('is idempotent (re-merging the same gossip changes nothing)', () => {
			const a = newState();
			const b1 = newState();
			seed(a, [10, 11]);
			const g = a.serializeGossip();
			b1.mergeGossip(g);
			const sizeAfterFirst = b1.replayBuffer.size;
			b1.mergeGossip(g);
			expect(b1.replayBuffer.size).to.equal(sizeAfterFirst);
		});
	});
});
