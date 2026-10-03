import { expect } from 'chai';
import {
	bytesToB64url,
	coreProfile,
	reactivityTopicId,
	type BlockId,
	type CohortTopicService,
	type CollectionChangeEvent,
	type CommitCert,
	type MembershipVerifier,
	type NotificationV1,
	type RegisterRequest,
	type RegistrationHandle,
	type VerifyResult,
} from '@optimystic/db-core';
import { ReactivityCollectionWatch, type CollectionTail } from '../../src/reactivity/collection-watch.js';
import { ReactivitySubscriberRegistry } from '../../src/reactivity/subscriber-registry.js';
import { reactivityCollectionIdBytes, reactivityTailBytes } from '../../src/reactivity/topic-bytes.js';

const COLLECTION = 'app/users';
const OLD_TAIL = 'tail-block-old' as BlockId;
const NEW_TAIL = 'tail-block-new' as BlockId;

const topicOf = (tail: BlockId): Uint8Array => reactivityTopicId(reactivityTailBytes(tail));

/** One `register` call the test settles by hand. */
interface PendingRegistration {
	readonly request: RegisterRequest;
	resolve(): void;
	reject(err: Error): void;
}

/** A cohort-topic service whose every `register` stays pending until the test resolves or rejects it. */
class HeldRegistrationService implements CohortTopicService {
	readonly registrations: PendingRegistration[] = [];
	withdraws = 0;
	onLocalCommit?: (event: CollectionChangeEvent, commitCert: CommitCert) => void;

	register(request: RegisterRequest): Promise<RegistrationHandle> {
		return new Promise<RegistrationHandle>((resolve, reject) => {
			this.registrations.push({
				request,
				resolve: () => resolve({ topicId: request.topicId, tier: request.tier, primary: new Uint8Array(32), backups: [], cohortEpoch: new Uint8Array(32), renewal: {} } as unknown as RegistrationHandle),
				reject,
			});
		});
	}
	async renew(): Promise<void> {}
	async lookup(): Promise<never> {
		throw new Error('lookup is not used by the watch service');
	}
	async withdraw(): Promise<void> {
		this.withdraws++;
	}
	moveRoot(): never {
		throw new Error('moveRoot is not used by the watch service');
	}
	cohortGossip(): never {
		throw new Error('cohortGossip is not used by the watch service');
	}
	verifier(): MembershipVerifier {
		return { cache: () => {}, forget: () => {}, verifyMessage: (): Promise<VerifyResult> => Promise.resolve('verified') };
	}
}

/** Let every promise chain the last step started run to its next real wait. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function notification(tail: BlockId, revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: bytesToB64url(reactivityCollectionIdBytes(COLLECTION)),
		tailId: bytesToB64url(reactivityTailBytes(tail)),
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	};
}

/** A watch attached under the old tail, with the service, registry, tick and tail under the test's control. */
async function attachedWatch() {
	const service = new HeldRegistrationService();
	const registry = new ReactivitySubscriberRegistry();
	const ticks: Array<() => void> = [];
	const state = { tail: { tailId: OLD_TAIL, revision: 4 } as CollectionTail, changes: 0 };
	const watch = new ReactivityCollectionWatch({
		service,
		profile: coreProfile(),
		quorumRatio: 0.75,
		subscribers: registry,
		scheduleRotation: () => {},
		setTimer: (fn) => { ticks.push(fn); return () => {}; },
	});
	const handle = watch.watch({ collectionId: COLLECTION, readTail: () => Promise.resolve(state.tail), onChange: () => { state.changes++; } });
	await settle();
	return { service, registry, state, handle, fireTick: (): void => ticks[ticks.length - 1]!() };
}

/** The same watch after the tick has found the log on a new tail block: the new registration is in flight. */
async function watchMidMove() {
	const fixture = await attachedWatch();
	fixture.service.registrations[0]!.resolve();
	await settle();
	fixture.state.tail = { tailId: NEW_TAIL, revision: 4 };
	fixture.fireTick();
	await settle();
	expect(fixture.service.registrations, 'the tick asked the cohort to register under the new tail').to.have.length(2);
	return { ...fixture, move: fixture.service.registrations[1]! };
}

describe('reactivity / collection watch', () => {
	it('the first tail read wakes the watcher: a commit made after the caller read but before that read is reported by nothing else', async () => {
		const { state } = await attachedWatch();
		expect(state.changes).to.equal(1);
	});

	it('a notification on the new topic reaches onChange while the new registration is still in flight', async () => {
		const { registry, state } = await watchMidMove();
		const before = state.changes;
		registry.deliver(topicOf(NEW_TAIL), notification(NEW_TAIL, 5));
		await settle();
		expect(state.changes - before, 'the in-flight attachment already routes the new topic').to.equal(1);
	});

	it('keeps the old handler registered until the new registration resolves, then drops it', async () => {
		const { registry, move } = await watchMidMove();
		expect(registry.has(topicOf(OLD_TAIL)), 'old topic still routed while the move is in flight').to.equal(true);
		expect(registry.has(topicOf(NEW_TAIL)), 'new topic routed before the cohort answers').to.equal(true);
		move.resolve();
		await settle();
		expect(registry.has(topicOf(OLD_TAIL)), 'old topic dropped once the new registration landed').to.equal(false);
		expect(registry.has(topicOf(NEW_TAIL))).to.equal(true);
	});

	it('a rejected new registration leaves the old handler registered and removes the new one', async () => {
		const { registry, move } = await watchMidMove();
		move.reject(new Error('no willing primary'));
		await settle();
		expect(registry.has(topicOf(OLD_TAIL)), 'the old attachment is untouched').to.equal(true);
		expect(registry.has(topicOf(NEW_TAIL)), 'the failed attachment routes nothing').to.equal(false);
	});

	it('closing during an in-flight registration leaves no handler registered and withdraws the registration when it lands', async () => {
		const { service, registry, handle } = await attachedWatch();
		expect(registry.has(topicOf(OLD_TAIL)), 'the first attach routes its topic before the cohort answers').to.equal(true);
		await handle.close();
		expect(registry.topicCount, 'close dropped the in-flight handler').to.equal(0);
		service.registrations[0]!.resolve();
		await settle();
		expect(registry.topicCount, 'a registration landing after close registers nothing').to.equal(0);
		expect(service.withdraws, 'the late registration was withdrawn at once').to.equal(1);
	});

	it('a tail read heals a gap the cohort could not backfill: the next revision is delivered, not re-requested', async () => {
		const { service, registry, state, fireTick } = await attachedWatch();
		service.registrations[0]!.resolve();
		await settle();
		const before = state.changes;
		// Revision 7 arrives with 5 and 6 never delivered: a gap, and this fixture has no recover transport.
		registry.deliver(topicOf(OLD_TAIL), notification(OLD_TAIL, 7));
		await settle();
		expect(state.changes - before, 'a gap wakes nobody on its own').to.equal(0);
		state.tail = { tailId: OLD_TAIL, revision: 7 };
		fireTick();
		await settle();
		expect(state.changes - before, 'the tick found the newer revision').to.equal(1);
		registry.deliver(topicOf(OLD_TAIL), notification(OLD_TAIL, 8));
		await settle();
		expect(state.changes - before, 'revision 8 is contiguous with what the tick read').to.equal(2);
	});
});
