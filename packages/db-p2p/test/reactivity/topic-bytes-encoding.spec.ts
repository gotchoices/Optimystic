import { expect } from 'chai';
import { hashKey } from 'p2p-fret';
import {
	reactivityTopicId,
	createTierAddressing,
	createRingHash,
	routingKeyForBlock,
	type BlockId,
	type CollectionChangeEvent,
	type ActionId,
} from '@optimystic/db-core';
import {
	createReactivitySelfMembershipGate,
	reactivityTailBytes,
} from '../../src/cohort-topic/reactivity-membership-gate.js';
import { reactivityTailBytes as reactivityTailBytesFromSurface } from '../../src/reactivity/topic-bytes.js';

/**
 * **Load-bearing encoding spec** (`12.33-reactivity-notification-transport`). Origination derives the
 * reactivity coord from `coord_0(reactivityTopicId(reactivityTailBytes(tailId)))`; the subscriber side
 * (the production subscribe factory → `ReactivitySubscriptionManager.tailIdAtAttach`) MUST feed
 * `reactivityTopicId` the SAME bytes. If the two encodings diverge they resolve different coords and
 * origination silently never reaches subscribers (green tests, dead feature).
 *
 * This pins the contract BOTH ways: the subscriber-derived coord equals the origination gate's coord for
 * the same tail; and it does NOT equal the coord a pre-hashed digest of the tail would produce (the double
 * hash the gate's JSDoc warns against). It also pins that the tail bytes are the block's routing key, so
 * reactivity and cohort routing share one encoding of a block id.
 */
describe('reactivity / topic-bytes encoding (origination ↔ subscription coord equality)', () => {
	const addressing = createTierAddressing(createRingHash());
	const TAIL = 'optimystic/collection/tail-encoding-probe' as BlockId;

	const makeEvent = (tailId: BlockId): CollectionChangeEvent => ({
		collectionId: 'collection-1' as BlockId,
		blockIds: ['block-1' as BlockId],
		actionId: 'a1' as ActionId,
		rev: 1,
		tailId,
	});

	/** A stub FRET that records the coord(s) the gate queried (and returns a fixed cohort containing self). */
	const stubFret = (cohort: string[]): { coords: Uint8Array[]; assembleCohort: (coord: Uint8Array, wants: number) => string[] } => {
		const coords: Uint8Array[] = [];
		return {
			coords,
			assembleCohort: (coord: Uint8Array, _wants: number): string[] => { coords.push(coord); return cohort; },
		};
	};

	it('the surface export and the gate re-export are the SAME function (one source of truth)', () => {
		expect(reactivityTailBytesFromSurface, 'gate re-exports the surface reactivityTailBytes').to.equal(reactivityTailBytes);
	});

	it('the subscriber-derived coord equals the origination gate\'s coord for the same tail', () => {
		// Origination side: the membership gate assembles the cohort around exactly one coord — capture it.
		const fret = stubFret(['self']);
		const gate = createReactivitySelfMembershipGate({ fret, selfPeerId: 'self', wantK: 16 });
		gate(makeEvent(TAIL));
		expect(fret.coords.length, 'the gate queried exactly one coord').to.equal(1);
		const originationCoord = fret.coords[0]!;

		// Subscriber side: the production subscribe factory feeds reactivityTopicId(reactivityTailBytes(tail)),
		// and ReactivitySubscriptionManager applies reactivityTopicId to those bytes; coord_0 is what it
		// subscribes to (the forwarder cohort at tree tier 0).
		const subscriberCoord = addressing.coord0(reactivityTopicId(reactivityTailBytes(TAIL)));

		expect([...subscriberCoord], 'origination and subscription resolve the SAME coord_0').to.deep.equal([...originationCoord]);
	});

	it('the tail bytes are the raw routing key, and a pre-hashed digest resolves a DIFFERENT coord (pins the regression)', async () => {
		const fret = stubFret(['self']);
		const gate = createReactivitySelfMembershipGate({ fret, selfPeerId: 'self', wantK: 16 });
		gate(makeEvent(TAIL));
		const originationCoord = fret.coords[0]!;

		// One encoding of a block id: the reactivity tail bytes ARE the block's routing key — raw utf8 of the id.
		expect([...reactivityTailBytes(TAIL)], 'reactivityTailBytes is routingKeyForBlock(tail)').to.deep.equal([...routingKeyForBlock(TAIL)]);
		expect([...reactivityTailBytes(TAIL)], 'reactivityTailBytes is raw utf8(BlockId)').to.deep.equal([...new TextEncoder().encode(TAIL)]);

		// The WRONG encoding: a sha256 digest of the id fed to reactivityTopicId double-hashes relative to
		// H(tailId ‖ "reactivity") → a different coord, so delivery would be silently lost.
		const digestCoord = addressing.coord0(reactivityTopicId(await hashKey(new TextEncoder().encode(TAIL))));
		expect([...digestCoord], 'a pre-hashed encoding must NOT match origination (would silently lose delivery)').to.not.deep.equal([...originationCoord]);
	});
});
