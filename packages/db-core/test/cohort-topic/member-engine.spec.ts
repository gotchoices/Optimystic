import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortMemberEngine } from '../../src/cohort-topic/member-engine.js';
import { createRegistrationStore } from '../../src/cohort-topic/registration/store.js';
import { createRenewalCohortSide } from '../../src/cohort-topic/registration/renewal.js';
import { createTopicBudget } from '../../src/cohort-topic/antidos/topic-budget.js';
import { createSlotAssigner } from '../../src/cohort-topic/registration/sharding.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { bytesEqual } from '../../src/cohort-topic/registration/bytes.js';
import { DEFAULT_TTL_MS } from '../../src/cohort-topic/registration/types.js';
import type { RegistrationRecord } from '../../src/cohort-topic/registration/types.js';

function bytes(label: string, len = 32): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

/**
 * A collaborator a `sweepStale` call must never touch — any property access throws, so the test fails
 * loudly if the seam ever starts depending on the willingness / promotion / cold-start / traffic paths.
 * Keeps this focused on the TTL-drain → budget-release contract without composing the whole admission stack.
 */
function unused<T>(name: string): T {
	return new Proxy({}, {
		get(_t, prop): never {
			throw new Error(`sweepStale must not touch ${name}.${String(prop)}`);
		},
	}) as T;
}

describe('cohort-topic / member-engine sweepStale → topic-budget release', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const self = bytes('self-member', 16);
	const cohortEpoch = bytes('epoch-1', 32);
	const members = [self];
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members, cohortEpoch });

	/** Compose the minimal engine the `sweepStale` seam needs: real store + renewal + budget, rest stubbed. */
	function makeEngine(topicsMax = 4): { engine: ReturnType<typeof createCohortMemberEngine>; store: ReturnType<typeof createRegistrationStore>; budget: ReturnType<typeof createTopicBudget> } {
		const store = createRegistrationStore();
		const budget = createTopicBudget({ topicsMax });
		const renewal = createRenewalCohortSide({
			store,
			self,
			slots,
			cohort,
			gossip: { touch: (): void => {}, evicted: (): void => {} },
		});
		const engine = createCohortMemberEngine({
			self,
			profile: unused('profile'),
			hash,
			store,
			slots,
			willingness: unused('willingness'),
			promotion: unused('promotion'),
			coldStart: unused('coldStart'),
			traffic: unused('traffic'),
			renewal,
			cohort,
			quorumWilling: (): boolean => true,
			topicBudget: budget,
		});
		return { engine, store, budget };
	}

	/** Seed `store` + budget as if a register had admitted `participant` on `topic` at `lastPing`. */
	function admit(store: ReturnType<typeof createRegistrationStore>, budget: ReturnType<typeof createTopicBudget>, topic: Uint8Array, participant: Uint8Array, lastPing: number): RegistrationRecord {
		const { primary, backups } = slots.assignSlots(participant, cohortEpoch, members);
		const rec: RegistrationRecord = { topicId: topic, participantId: participant, tier: 1, primary, backups, attachedAt: lastPing, lastPing, ttl: DEFAULT_TTL_MS };
		store.put(rec);
		budget.admit(topic);
		budget.touch(topic, store.directParticipants(topic)); // mirror accept()'s up-touch
		return rec;
	}

	it('drains a topic to participantCount 0 (resident-but-cold) when its last participant is TTL-swept', () => {
		const { engine, store, budget } = makeEngine();
		const TOPIC = bytes('drain-topic');
		const p = bytes('p', 16);
		admit(store, budget, TOPIC, p, 1_000);
		expect(budget.participantCount(TOPIC), 'admitted topic carries its participant count').to.equal(1);

		// One ttl past the only ping: the record is swept and the budget is re-touched back DOWN.
		const evicted = engine.sweepStale(1_000 + DEFAULT_TTL_MS + 1);
		expect(evicted.some((r) => bytesEqual(r.topicId, TOPIC)), 'the stale record is swept').to.equal(true);
		expect(budget.has(TOPIC), 'a drained topic stays resident-but-cold (LRU reuse), it is not dropped').to.equal(true);
		expect(budget.participantCount(TOPIC), 'the drained topic fell to participantCount 0 — its slot is now reclaimable').to.equal(0);
	});

	it('a partial drain re-touches to the remaining count, not zero (the slot is held until the topic fully drains)', () => {
		const { engine, store, budget } = makeEngine();
		const TOPIC = bytes('partial-topic');
		const pStale = bytes('p-stale', 16);
		const pFresh = bytes('p-fresh', 16);
		admit(store, budget, TOPIC, pStale, 1_000);
		admit(store, budget, TOPIC, pFresh, 1_000 + DEFAULT_TTL_MS); // pinged later → survives the sweep
		expect(budget.participantCount(TOPIC), 'two participants resident').to.equal(2);

		// Sweep at a time that evicts only the stale participant; the fresh one survives.
		const evicted = engine.sweepStale(1_000 + DEFAULT_TTL_MS + 1);
		expect(evicted.length, 'only the stale participant is swept').to.equal(1);
		expect(evicted[0]!.participantId).to.deep.equal(pStale);
		expect(budget.participantCount(TOPIC), 're-touched from the store to the surviving count, not prematurely freed').to.equal(1);
	});

	it('re-touches once per distinct topic when one sweep drains several topics', () => {
		const { engine, store, budget } = makeEngine();
		const A = bytes('multi-a');
		const B = bytes('multi-b');
		admit(store, budget, A, bytes('pa', 16), 1_000);
		admit(store, budget, B, bytes('pb', 16), 1_000);
		expect(budget.size).to.equal(2);

		engine.sweepStale(1_000 + DEFAULT_TTL_MS + 1);
		expect(budget.participantCount(A), 'topic A released').to.equal(0);
		expect(budget.participantCount(B), 'topic B released').to.equal(0);
	});

	it('the sweepStale re-touch is a no-op when no budget is wired (optional dependency)', () => {
		const store = createRegistrationStore();
		const renewal = createRenewalCohortSide({ store, self, slots, cohort, gossip: { touch: (): void => {}, evicted: (): void => {} } });
		const engine = createCohortMemberEngine({
			self, profile: unused('profile'), hash, store, slots,
			willingness: unused('willingness'), promotion: unused('promotion'), coldStart: unused('coldStart'), traffic: unused('traffic'),
			renewal, cohort, quorumWilling: (): boolean => true,
			// topicBudget intentionally omitted
		});
		const p = bytes('p', 16);
		const { primary, backups } = slots.assignSlots(p, cohortEpoch, members);
		store.put({ topicId: bytes('no-budget-topic'), participantId: p, tier: 1, primary, backups, attachedAt: 1_000, lastPing: 1_000, ttl: DEFAULT_TTL_MS });
		// Must not throw with no budget to re-touch.
		const evicted = engine.sweepStale(1_000 + DEFAULT_TTL_MS + 1);
		expect(evicted.length).to.equal(1);
	});
});
