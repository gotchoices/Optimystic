import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	PROVIDER_TTL_CORE_MS,
	SEEKER_TTL_MS,
	Tier,
	bytesToB64url,
	createRegistrationStore,
	createRingHash,
	createSlotAssigner,
	decodeArrivalPushV1,
	encodeArrivalPushAckV1,
	matchTopicId,
	observeRecordAdditions,
	type ArrivalPushResult,
	type ArrivalPushV1,
	type RegistrationRecord,
	type RegistrationStore,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import { ArrivalPushDriver, type ArrivalPushEngine } from '../../src/matchmaking/arrival-push-driver.js';

const utf8 = new TextEncoder();
const idBytes = (s: string): Uint8Array => utf8.encode(s);
const idString = (b: Uint8Array): string => new TextDecoder().decode(b);
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const topicId = matchTopicId('capability', 'pdf-render');
const cohortEpoch = new Uint8Array(32).fill(7);
const traffic: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 12, queriesPerMin: 2, directParticipants: 4, childCohortCount: 0 };
const slots = createSlotAssigner(createRingHash());

function record(id: string, attachedAt: number, ttl: number, appState: Uint8Array): RegistrationRecord {
	return { topicId, participantId: idBytes(id), tier: Tier.T2, primary: idBytes('member-a'), backups: [], attachedAt, lastPing: attachedAt, ttl, appState };
}

async function providerRecord(id: string, attachedAt: number, capacityBudget = 8): Promise<RegistrationRecord> {
	const provider = new MatchmakingProvider({ topicId, capabilities: ['pdf-render'], capacityBudget, contactHint: `c-${id}`, sign: fakeSign });
	return record(id, attachedAt, PROVIDER_TTL_CORE_MS, await provider.appPayloadBytes());
}

async function seekerRecord(id: string, attachedAt: number, wantCount: number, correlation = 1): Promise<RegistrationRecord> {
	const seeker = new MatchmakingSeeker({ topicId, wantCount, contactHint: id, pushOnArrival: true, sign: fakeSign, correlationId: new Uint8Array(16).fill(correlation) });
	return record(id, attachedAt, SEEKER_TTL_MS, await seeker.appPayloadBytes());
}

/** Timers that fire only when the test says so. */
class ManualTimers {
	private readonly pending = new Map<number, () => void>();
	private nextId = 0;

	readonly setTimer = (fn: () => void, _ms: number): (() => void) => {
		const id = this.nextId++;
		this.pending.set(id, fn);
		return () => this.pending.delete(id);
	};

	get armed(): number {
		return this.pending.size;
	}

	fireAll(): void {
		const due = [...this.pending.values()];
		this.pending.clear();
		for (const fn of due) {
			fn();
		}
	}
}

interface SentPush {
	readonly from: string;
	readonly contactHint: string;
	readonly push: ArrivalPushV1;
}

/** One cohort member: a real store behind the absent→present observer, feeding its own driver. */
interface Member {
	readonly store: RegistrationStore;
	readonly timers: ManualTimers;
	/** Records the observer reported as newly present. */
	readonly added: RegistrationRecord[];
}

function cohortMember(self: string, members: readonly string[], sent: SentPush[], ack: (push: ArrivalPushV1) => ArrivalPushResult = () => 'ok'): Member {
	const timers = new ManualTimers();
	const added: RegistrationRecord[] = [];
	const driver = new ArrivalPushDriver({
		selfPeerId: self,
		slots,
		sign: fakeSign,
		send: async (contactHint, frame) => {
			const push = decodeArrivalPushV1(frame);
			sent.push({ from: self, contactHint, push });
			return encodeArrivalPushAckV1({ v: 1, result: ack(push) });
		},
		setTimer: timers.setTimer,
	});
	const store: RegistrationStore = observeRecordAdditions(createRegistrationStore(), (rec) => {
		added.push(rec);
		driver.onRecordAdded(engine, rec);
	});
	const engine: ArrivalPushEngine = {
		servedCoord: new Uint8Array(32).fill(1),
		cohort: () => ({ members: members.map(idBytes), cohortEpoch }),
		records: (t) => store.listByTopic(t),
		heldRecord: (t, p) => store.getByParticipant(t, p),
		topicTraffic: () => traffic,
	};
	return { store, timers, added };
}

describe('matchmaking / arrival push driver', () => {
	it('a renewal of a held provider is not an arrival: one push in total', async () => {
		const sent: SentPush[] = [];
		const member = cohortMember('member-a', ['member-a'], sent);
		member.store.put(await seekerRecord('seeker-1', 100, 3));
		const provider = await providerRecord('provider-1', 200);
		member.store.put(provider);
		member.timers.fireAll();
		await settle();

		member.store.put({ ...provider, lastPing: 300 });
		expect(member.timers.armed).to.equal(0);
		member.timers.fireAll();
		await settle();

		// The observer reported the seeker and the provider's first put, not its renewal.
		expect(member.added.map((r) => idString(r.participantId))).to.deep.equal(['seeker-1', 'provider-1']);
		expect(sent).to.have.length(1);
		expect(sent[0]!.push.providers.map((p) => p.participantId)).to.deep.equal(['provider-1']);
	});

	it('coalesces arrivals within the window into one push, and flushes at once when they cover the need', async () => {
		const sent: SentPush[] = [];
		const member = cohortMember('member-a', ['member-a'], sent);
		member.store.put(await seekerRecord('seeker-many', 100, 5));
		for (const n of [1, 2, 3]) {
			member.store.put(await providerRecord(`provider-${n}`, 200 + n));
		}
		await settle();
		expect(sent).to.have.length(0);
		member.timers.fireAll();
		await settle();
		expect(sent).to.have.length(1);
		expect(sent[0]!.push.providers.map((p) => p.participantId)).to.deep.equal(['provider-1', 'provider-2', 'provider-3']);
		expect(sent[0]!.push.correlationId).to.equal(bytesToB64url(new Uint8Array(16).fill(1)));
		expect(sent[0]!.push.topicTraffic).to.deep.equal(traffic);

		// A seeker wanting one provider gets it without waiting for the timer.
		member.store.put(await seekerRecord('seeker-one', 300, 1));
		member.store.put(await providerRecord('provider-4', 400));
		await settle();
		expect(sent.filter((s) => s.contactHint === 'seeker-one')).to.have.length(1);
	});

	it('only the seeker\'s slot primary pushes to it', async () => {
		const members = ['member-a', 'member-b'];
		const sent: SentPush[] = [];
		const cohort = members.map((self) => cohortMember(self, members, sent));
		const seekers = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => seekerRecord(`seeker-${n}`, 100 + n, 2)));
		const provider = await providerRecord('provider-1', 200, seekers.length);
		for (const rec of [...seekers, provider]) {
			for (const member of cohort) {
				member.store.put(rec);
			}
		}
		for (const member of cohort) {
			member.timers.fireAll();
		}
		await settle();

		const pushedTo = sent.map((s) => s.contactHint).sort();
		expect(pushedTo).to.deep.equal(seekers.map((r) => idString(r.participantId)).sort());
		for (const { from, contactHint } of sent) {
			const primary = slots.assignSlots(idBytes(contactHint), cohortEpoch, members.map(idBytes)).primary;
			expect(from).to.equal(idString(primary));
		}
	});

	it('stops pushing a registration the seeker disowns, and pushes its re-registration', async () => {
		const sent: SentPush[] = [];
		const current = bytesToB64url(new Uint8Array(16).fill(2));
		const member = cohortMember('member-a', ['member-a'], sent, (push) => push.correlationId === current ? 'ok' : 'unknown_seeker');
		member.store.put(await seekerRecord('seeker-1', 100, 3, 1));
		member.store.put(await providerRecord('provider-1', 200));
		member.timers.fireAll();
		await settle();
		expect(sent).to.have.length(1);

		member.store.put(await providerRecord('provider-2', 300));
		expect(member.timers.armed).to.equal(0);

		member.store.put(await seekerRecord('seeker-1', 350, 3, 2));
		member.store.put(await providerRecord('provider-3', 400));
		member.timers.fireAll();
		await settle();
		expect(sent).to.have.length(2);
		expect(sent[1]!.push.correlationId).to.equal(current);
		expect(sent[1]!.push.providers.map((p) => p.participantId)).to.deep.equal(['provider-3']);
	});
});
