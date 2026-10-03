import { expect } from 'chai';
import { hashKey } from 'p2p-fret';
import {
	reactivityRootCoord,
	routingKeyForBlock,
	coreProfile,
	decodeSubscribeAppPayload,
	validateNotificationV1,
	type BlockId,
	type CollectionChangeEvent,
	type ActionId,
	type CohortTopicService,
	type NotificationV1,
	type RegisterRequest,
	type RegistrationHandle,
} from '@optimystic/db-core';
import { reactivityTailBytes } from '../../src/reactivity/topic-bytes.js';
import { ReactivityOriginationManager, liveOriginationContext } from '../../src/reactivity/origination-manager.js';
import { ReactivityCollectionWatch } from '../../src/reactivity/collection-watch.js';
import { ReactivitySubscriberRegistry } from '../../src/reactivity/subscriber-registry.js';

/**
 * **Load-bearing encoding spec.** A collection's reactivity tree is rooted at its log tail block's storage
 * group (`docs/reactivity.md` §Origination point): the root coordinate db-core derives for a tail,
 * `reactivityRootCoord(reactivityTailBytes(tail))`, must be the ring position the key network stores that
 * block at, `hashKey(routingKeyForBlock(tail))`. The two are computed by different implementations
 * (db-core's own SHA-256 ring hash, FRET's `hashKey`) from the same bytes; every party that derives the
 * root group — the origination side's host, the notification verifier, the subscriber's register walk and
 * the forwarder's reads — leans on this one equality. db-core cannot import FRET, so it is pinned here.
 */
describe('reactivity / topic-bytes encoding (root coordinate = the tail block\'s storage position)', () => {
	const TAIL = 'optimystic/collection/tail-encoding-probe' as BlockId;

	const makeEvent = (tailId: BlockId): CollectionChangeEvent => ({
		collectionId: 'collection-1' as BlockId,
		blockIds: ['block-1' as BlockId],
		actionId: 'a1' as ActionId,
		rev: 1,
		tailId,
	});

	it('the root coordinate db-core derives for a tail equals hashKey(routingKeyForBlock(tail)) — one placement rule', async () => {
		// One encoding of a block id: the reactivity tail bytes ARE the block's routing key — raw utf8 of the id.
		expect([...reactivityTailBytes(TAIL)], 'reactivityTailBytes is routingKeyForBlock(tail)').to.deep.equal([...routingKeyForBlock(TAIL)]);
		expect([...reactivityTailBytes(TAIL)], 'reactivityTailBytes is raw utf8(BlockId)').to.deep.equal([...new TextEncoder().encode(TAIL)]);

		const rootCoord = reactivityRootCoord(reactivityTailBytes(TAIL));
		const storagePosition = await hashKey(routingKeyForBlock(TAIL));
		expect([...rootCoord], 'the reactivity root sits exactly where the key network places the tail block').to.deep.equal([...storagePosition]);
	});

	it('a notification names a path-shaped collection id by the bytes the watch service registers under, and passes wire validation', async () => {
		// A real collection id: `/` is not a base64url character, so it cannot go on the wire as-is.
		const COLLECTION = 'app/users';
		const registered: RegisterRequest[] = [];
		const service: CohortTopicService = {
			register: (req) => { registered.push(req); return new Promise<RegistrationHandle>(() => { /* never answers: only the request is read */ }); },
			renew: () => Promise.resolve(),
			withdraw: () => Promise.resolve(),
			moveRoot: () => { throw new Error('moveRoot is not used here'); },
			lookup: () => Promise.reject(new Error('lookup is not used here')),
			cohortGossip: () => { throw new Error('cohortGossip is not used here'); },
			verifier: () => ({ cache: () => {}, forget: () => {}, verifyMessage: () => Promise.resolve('verified') }),
		};

		// Origination side: what a live node puts on the notification for a commit to the collection.
		const emitted: NotificationV1[] = [];
		new ReactivityOriginationManager({
			service,
			resolveContext: (event) => liveOriginationContext(event, 0),
			emit: (n) => emitted.push(n),
		}).install();
		service.onLocalCommit!(
			{ ...makeEvent(TAIL), collectionId: COLLECTION as BlockId },
			{ thresholdSig: new Uint8Array([1, 2, 3]), signers: ['12D3KooWAlice'], minSigs: 1, signedPayload: new TextEncoder().encode('commit:approve') },
		);
		expect(emitted, 'the commit originated a notification').to.have.length(1);

		// Subscriber side: what the watch service registers the same collection under.
		const watch = new ReactivityCollectionWatch({
			service,
			profile: coreProfile(),
			quorumRatio: 0.75,
			subscribers: new ReactivitySubscriberRegistry(),
			scheduleRotation: () => {},
			setTimer: () => () => {},
		});
		watch.watch({ collectionId: COLLECTION, readTail: () => Promise.resolve({ tailId: TAIL, revision: 1 }), onChange: () => {} });
		await new Promise((resolve) => setImmediate(resolve));
		expect(registered, 'the watch service registered a subscriber').to.have.length(1);
		const subscribedAs = decodeSubscribeAppPayload(registered[0]!.appPayload!).collectionId;

		expect(emitted[0]!.collectionId, 'origination and the subscriber name the collection identically').to.equal(subscribedAs);
		// The register names the tail as the topic's root key: the walk's root step goes to the storage group.
		expect([...registered[0]!.rootKey!], 'the registration is root-placed at the tail').to.deep.equal([...reactivityTailBytes(TAIL)]);
		expect(() => validateNotificationV1(emitted[0]), 'the notification decodes on the receiving node').to.not.throw();
		await watch.stop();
	});
});
