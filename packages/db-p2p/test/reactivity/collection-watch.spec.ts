import { expect } from 'chai';
import {
	bytesToB64url,
	coreProfile,
	reactivityCollectionTopicId,
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
/** The collection's topic: the one key the registry routes under, whatever tail the log is on. */
const TOPIC = reactivityCollectionTopicId(reactivityCollectionIdBytes(COLLECTION));
const OLD_TAIL = 'tail-block-old' as BlockId;
const NEW_TAIL = 'tail-block-new' as BlockId;

/** One `register` call the test settles by hand. */
interface PendingRegistration {
	readonly request: RegisterRequest;
	/** Land the registration at tree tier `treeTier` (default 0, the root), under the request's root key. */
	resolve(treeTier?: number): void;
	reject(err: Error): void;
}

/** A cohort-topic service whose every `register` stays pending until the test resolves or rejects it. */
class HeldRegistrationService implements CohortTopicService {
	readonly registrations: PendingRegistration[] = [];
	/** Every `moveRoot`: the handle moved and the root key it was moved to. */
	readonly moves: Array<{ handle: RegistrationHandle; rootKey: Uint8Array }> = [];
	withdraws = 0;
	onLocalCommit?: (event: CollectionChangeEvent, commitCert: CommitCert) => void;

	register(request: RegisterRequest): Promise<RegistrationHandle> {
		return new Promise<RegistrationHandle>((resolve, reject) => {
			this.registrations.push({
				request,
				resolve: (treeTier = 0) => resolve({
					topicId: request.topicId,
					tier: request.tier,
					treeTier,
					rootKey: request.rootKey,
					primary: new Uint8Array(32),
					backups: [],
					cohortEpoch: new Uint8Array(32),
					cohortMembers: [],
					renewal: {},
				} as unknown as RegistrationHandle),
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
	moveRoot(handle: RegistrationHandle, rootKey: Uint8Array): void {
		this.moves.push({ handle, rootKey });
		(handle as { rootKey?: Uint8Array }).rootKey = rootKey;
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

/** A watch whose first registration (under the old tail) is in flight, with the service, registry, tick and tail under the test's control. */
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
	return { service, registry, state, handle, watch, fireTick: (): void => ticks[ticks.length - 1]!() };
}

/** The same watch once its first registration has landed at tree tier `treeTier`. */
async function registeredWatch(treeTier: number) {
	const fixture = await attachedWatch();
	fixture.service.registrations[0]!.resolve(treeTier);
	await settle();
	expect(fixture.watch.isAttached(COLLECTION)).to.equal(true);
	return fixture;
}

/** Move the log to the new tail block and let the tick find it. */
async function moveLogTo(fixture: Awaited<ReturnType<typeof attachedWatch>>, tail: BlockId): Promise<void> {
	fixture.state.tail = { tailId: tail, revision: 4 };
	fixture.fireTick();
	await settle();
}

describe('reactivity / collection watch', () => {
	it('the first tail read wakes the watcher: a commit made after the caller read but before that read is reported by nothing else', async () => {
		const { state } = await attachedWatch();
		expect(state.changes).to.equal(1);
	});

	it('a notification on the collection topic reaches onChange while the first registration is still in flight', async () => {
		const { registry, state } = await attachedWatch();
		expect(registry.has(TOPIC), 'the handler is registered before the cohort answers').to.equal(true);
		const before = state.changes;
		registry.deliver(TOPIC, notification(OLD_TAIL, 5));
		await settle();
		expect(state.changes - before).to.equal(1);
	});

	it('a tail move re-registers a registration at the root under the new root key, through the one handler', async () => {
		const fixture = await registeredWatch(0);
		const { service, registry, state } = fixture;
		await moveLogTo(fixture, NEW_TAIL);
		expect(service.registrations, 'the move asked the cohort to register again').to.have.length(2);
		expect([...service.registrations[1]!.request.rootKey!], 'under the new tail as the root key').to.deep.equal([...reactivityTailBytes(NEW_TAIL)]);
		expect([...service.registrations[1]!.request.topicId], 'on the same topic').to.deep.equal([...TOPIC]);
		expect(service.moves, 'a registration at the root is not moved in place').to.have.length(0);
		expect(registry.topicCount, 'the handler stayed where it was').to.equal(1);
		// A notification announced by the new root while the re-registration is in flight still reaches onChange.
		const before = state.changes;
		registry.deliver(TOPIC, notification(NEW_TAIL, 5));
		await settle();
		expect(state.changes - before).to.equal(1);
		service.registrations[1]!.resolve();
		await settle();
		expect(service.registrations, 'a registration already at the new root is not made again by the re-check').to.have.length(2);
		expect(service.withdraws, 'the old registration is displaced at the service, not withdrawn').to.equal(0);
		expect(registry.topicCount).to.equal(1);
	});

	it('a tail move for a registration below the root calls moveRoot with the new root key and registers nothing', async () => {
		const fixture = await registeredWatch(1);
		const { service, watch } = fixture;
		await moveLogTo(fixture, NEW_TAIL);
		expect(service.registrations, 'no register frame for a registration the rotation does not move').to.have.length(1);
		expect(service.moves).to.have.length(1);
		expect([...service.moves[0]!.rootKey]).to.deep.equal([...reactivityTailBytes(NEW_TAIL)]);
		expect(service.moves[0]!.handle.treeTier).to.equal(1);
		expect(watch.isAttached(COLLECTION), 'the registration is kept').to.equal(true);
		// Another tick on the same tail moves nothing again: the handle already names this root.
		fixture.fireTick();
		await settle();
		expect(service.moves, 'the move is recorded once per tail, not once per tick').to.have.length(1);
	});

	it('a rejected re-registration leaves the old registration in place, and the next tick registers again', async () => {
		const fixture = await registeredWatch(0);
		const { service, watch } = fixture;
		await moveLogTo(fixture, NEW_TAIL);
		service.registrations[1]!.reject(new Error('no willing primary'));
		await settle();
		expect(watch.isAttached(COLLECTION), 'the old registration keeps renewing at the old root').to.equal(true);
		expect(service.withdraws).to.equal(0);
		fixture.fireTick();
		await settle();
		expect(service.registrations, 'the handle still names the old root, so the next tick tries again').to.have.length(3);
		expect([...service.registrations[2]!.request.rootKey!]).to.deep.equal([...reactivityTailBytes(NEW_TAIL)]);
	});

	it('closing during an in-flight registration leaves no handler registered and withdraws the registration when it lands', async () => {
		const { service, registry, handle } = await attachedWatch();
		expect(registry.has(TOPIC), 'the first attach routes its topic before the cohort answers').to.equal(true);
		await handle.close();
		expect(registry.topicCount, 'close dropped the handler').to.equal(0);
		service.registrations[0]!.resolve();
		await settle();
		expect(registry.topicCount, 'a registration landing after close registers nothing').to.equal(0);
		expect(service.withdraws, 'the late registration was withdrawn at once').to.equal(1);
	});

	it('a tail read heals a gap the cohort could not backfill: the next revision is delivered, not re-requested', async () => {
		const { registry, state, fireTick } = await registeredWatch(0);
		const before = state.changes;
		// Revision 7 arrives with 5 and 6 never delivered: a gap, and this fixture has no recover transport.
		registry.deliver(TOPIC, notification(OLD_TAIL, 7));
		await settle();
		expect(state.changes - before, 'a gap wakes nobody on its own').to.equal(0);
		state.tail = { tailId: OLD_TAIL, revision: 7 };
		fireTick();
		await settle();
		expect(state.changes - before, 'the tick found the newer revision').to.equal(1);
		registry.deliver(TOPIC, notification(OLD_TAIL, 8));
		await settle();
		expect(state.changes - before, 'revision 8 is contiguous with what the tick read').to.equal(2);
	});
});
