import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortMemberEngine } from '../../src/cohort-topic/member-engine.js';
import { createRegistrationStore } from '../../src/cohort-topic/registration/store.js';
import { createRenewalCohortSide } from '../../src/cohort-topic/registration/renewal.js';
import { createTopicBudget } from '../../src/cohort-topic/antidos/topic-budget.js';
import { createRegisterRateLimiter } from '../../src/cohort-topic/antidos/rate-limiter.js';
import { createSlotAssigner } from '../../src/cohort-topic/registration/sharding.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { bytesEqual, bytesKey } from '../../src/cohort-topic/registration/bytes.js';
import { DEFAULT_TTL_MS } from '../../src/cohort-topic/registration/types.js';
import type { RegistrationRecord } from '../../src/cohort-topic/registration/types.js';
import { createColdStartManager } from '../../src/cohort-topic/coldstart.js';
import type { RegisterV1, RenewV1 } from '../../src/cohort-topic/wire/types.js';

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

	it('a withdraw via handleRenew releases the topic budget to 0 and records no arrival', () => {
		// `makeEngine` stubs `traffic` with the `unused` proxy, so the withdraw path failing into
		// `recordArrival` (the `ok` branch) would throw — this simultaneously asserts "no arrival recorded".
		const { engine, store, budget } = makeEngine();
		const TOPIC = bytes('withdraw-topic');
		const p = bytes('p', 16);
		admit(store, budget, TOPIC, p, 1_000);
		expect(budget.participantCount(TOPIC), 'admitted topic carries its participant count').to.equal(1);

		const withdraw: RenewV1 = {
			v: 1,
			topicId: bytesKey(TOPIC),
			participantId: bytesKey(p),
			correlationId: bytesKey(bytes('cid-withdraw')),
			timestamp: 2_000,
			withdraw: true,
			signature: '',
		};
		const reply = engine.handleRenew(withdraw, 2_000);
		expect(reply.result, 'the holder accepted the withdraw').to.equal('withdrawn');
		expect(store.getByParticipant(TOPIC, p), 'the record was evicted').to.equal(undefined);
		expect(budget.participantCount(TOPIC), 'the freed slot was released to 0 (no leak)').to.equal(0);
	});
});

describe('cohort-topic / member-engine: onAdmit fires on accept', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const self = bytes('self-onadmit', 16);
	const cohortEpoch = bytes('epoch-onadmit', 32);
	const members = [self];
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members, cohortEpoch });

	/** Minimal stub coldStart: never serves (no forwarder), instantiate is a no-op at tier 0. */
	const coldStart = createColdStartManager({
		parentRegistrar: { registerWithParent: (): Promise<void> => Promise.resolve() },
	});

	it('calls onAdmit with the admitted record when a registration is accepted', async () => {
		const store = createRegistrationStore();
		let admittedRecord: RegistrationRecord | undefined;

		const engine = createCohortMemberEngine({
			self,
			profile: {} as never,
			hash,
			store,
			slots,
			willingness: { evaluate: (): { kind: 'accepted' } => ({ kind: 'accepted' }) },
			promotion: {
				onParticipantCountChange: (): Promise<undefined> => Promise.resolve(undefined),
				maybeDemote: (): Promise<undefined> => Promise.resolve(undefined),
				isPromoted: (): boolean => false,
				applyPromotionNotice: (): void => {},
				applyDemotionNotice: (): void => {},
			},
			coldStart,
			traffic: {
				recordArrival: (): void => {},
				snapshot: (): { arrivalsPerMin: number; queriesPerMin: number; directParticipants: number } =>
					({ arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0 }),
			} as never,
			renewal: unused('renewal'),
			cohort,
			quorumWilling: (): boolean => true,
			onAdmit: (rec): void => { admittedRecord = rec; },
		});

		const topicId = bytes('onadmit-topic');
		const participant = bytes('onadmit-participant', 16);
		const reg: RegisterV1 = {
			v: 1,
			topicId: bytesKey(topicId),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesKey(participant),
			ttl: 90_000,
			bootstrap: true,
			timestamp: 1_000,
			correlationId: bytesKey(bytes('cid-onadmit')),
			signature: '',
		};

		const result = await engine.handleRegister(reg, { followOn: false, treeTier: 0 }, 1_000);
		expect(result.result, 'registration accepted').to.equal('accepted');
		expect(admittedRecord, 'onAdmit fired with the record').to.not.equal(undefined);
		expect(admittedRecord!.participantId, 'onAdmit record has the correct participantId').to.deep.equal(participant);
	});

	it('does not call onAdmit when willingness declines the registration', async () => {
		const store = createRegistrationStore();
		let admitCalled = false;

		const engine = createCohortMemberEngine({
			self,
			profile: {} as never,
			hash,
			store,
			slots,
			willingness: { evaluate: (): { kind: 'unwilling_cohort'; retryAfterMs: number } => ({ kind: 'unwilling_cohort', retryAfterMs: 1_000 }) },
			promotion: unused('promotion'),
			coldStart,
			traffic: { recordArrival: (): void => {} } as never,
			renewal: unused('renewal'),
			cohort,
			quorumWilling: (): boolean => true,
			onAdmit: (): void => { admitCalled = true; },
		});

		const topicId = bytes('onadmit-reject-topic');
		const participant = bytes('onadmit-reject-participant', 16);
		const reg: RegisterV1 = {
			v: 1,
			topicId: bytesKey(topicId),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesKey(participant),
			ttl: 90_000,
			bootstrap: true,
			timestamp: 1_000,
			correlationId: bytesKey(bytes('cid-onadmit-reject')),
			signature: '',
		};

		const result = await engine.handleRegister(reg, { followOn: false, treeTier: 0 }, 1_000);
		expect(result.result, 'registration declined').to.equal('unwilling_cohort');
		expect(admitCalled, 'onAdmit must not fire on rejection').to.equal(false);
	});
});

describe('cohort-topic / member-engine: followOn cold-start admission', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const self = bytes('followon-self', 16);
	const cohortEpoch = bytes('followon-epoch', 32);
	const members = [self];
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members, cohortEpoch });
	const parentCoord = bytes('followon-parent', 32);
	// The routing context the host derives from a `followOn: true` frame (ctx.followOn mirrors reg.followOn).
	const ctx = { followOn: true, treeTier: 1, parentCoord };

	/**
	 * Compose a member engine whose cold-start manager is real (so `serves` flips true once a forwarder
	 * instantiates) and whose bootstrap-evidence gate returns `evidenceOk` (undefined → gate not wired). A
	 * background `registerWithParent` counter proves the instantiated tier-1 child links to its parent.
	 */
	function makeEngine(opts: { evidenceOk?: boolean }): {
		engine: ReturnType<typeof createCohortMemberEngine>;
		store: ReturnType<typeof createRegistrationStore>;
		coldStart: ReturnType<typeof createColdStartManager>;
		parentCalls: () => number;
	} {
		const store = createRegistrationStore();
		let parentCalls = 0;
		const coldStart = createColdStartManager({
			parentRegistrar: { registerWithParent: async (): Promise<void> => { parentCalls++; } },
		});
		const engine = createCohortMemberEngine({
			self,
			profile: {} as never,
			hash,
			store,
			slots,
			willingness: { evaluate: (): { kind: 'accepted' } => ({ kind: 'accepted' }) },
			promotion: {
				onParticipantCountChange: (): Promise<undefined> => Promise.resolve(undefined),
				maybeDemote: (): Promise<undefined> => Promise.resolve(undefined),
				isPromoted: (): boolean => false,
				applyPromotionNotice: (): void => {},
				applyDemotionNotice: (): void => {},
			},
			coldStart,
			traffic: {
				recordArrival: (): void => {},
				snapshot: (): { windowSeconds: number; arrivalsPerMin: number; queriesPerMin: number; directParticipants: number; childCohortCount: number } =>
					({ windowSeconds: 60, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 }),
			} as never,
			renewal: unused('renewal'),
			cohort,
			quorumWilling: (): boolean => true,
			bootstrapEvidence: opts.evidenceOk === undefined ? undefined : { verify: (): boolean => opts.evidenceOk! },
		});
		return { engine, store, coldStart, parentCalls: (): number => parentCalls };
	}

	function followOnReg(topic: Uint8Array, participant: Uint8Array, cid: string): RegisterV1 {
		return {
			v: 1,
			topicId: bytesKey(topic),
			tier: 2, // a T2 topic → the evidence gate demands PoW/reputation/parent-ref, same as a bootstrap
			treeTier: 1, // a follow-on is a deeper-than-root growth point
			participantCoord: bytesKey(participant),
			ttl: 90_000,
			followOn: true,
			timestamp: 1_000,
			correlationId: bytesKey(bytes(cid)),
			signature: '',
		};
	}

	it('a followOn cold register with valid evidence instantiates the child and admits', async () => {
		const { engine, coldStart, parentCalls } = makeEngine({ evidenceOk: true });
		const TOPIC = bytes('followon-cold');
		const reply = await engine.handleRegister(followOnReg(TOPIC, bytes('followon-p', 16), 'cid-cold'), ctx, 1_000);
		expect(reply.result, 'the follow-on instantiates the cold child and admits').to.equal('accepted');
		const fwd = coldStart.get(TOPIC);
		expect(fwd, 'the child forwarder was instantiated').to.not.equal(undefined);
		expect(fwd!.tier, 'instantiated at the child tree tier (d = 1)').to.equal(1);
		await new Promise<void>((r) => setTimeout(r, 0)); // flush the background parent registration
		expect(parentCalls(), 'the tier-1 child kicks off registration with its tier-0 parent').to.equal(1);
	});

	it('a followOn register with bad evidence is refused (unwilling_cohort) and never instantiates', async () => {
		const { engine, coldStart } = makeEngine({ evidenceOk: false });
		const TOPIC = bytes('followon-badevidence');
		const reply = await engine.handleRegister(followOnReg(TOPIC, bytes('p', 16), 'cid-bad'), ctx, 1_000);
		expect(reply.result, 'the evidence gate rejects before the cold-start decision').to.equal('unwilling_cohort');
		expect(coldStart.get(TOPIC), 'no forwarder instantiated on a rejected follow-on').to.equal(undefined);
	});

	it('a followOn register on an already-hot child admits via the normal path (no re-instantiation)', async () => {
		const { engine, store, coldStart } = makeEngine({ evidenceOk: true });
		const TOPIC = bytes('followon-hot');
		// Seed a resident participant so the child is already hot (serves(topic) true) without a forwarder.
		const seedP = bytes('seed-hot', 16);
		const { primary, backups } = slots.assignSlots(seedP, cohortEpoch, members);
		store.put({ topicId: TOPIC, participantId: seedP, tier: 2, primary, backups, attachedAt: 1_000, lastPing: 1_000, ttl: DEFAULT_TTL_MS });
		const reply = await engine.handleRegister(followOnReg(TOPIC, bytes('p', 16), 'cid-hot'), ctx, 2_000);
		expect(reply.result, 'a hot child admits the follow-on via the normal admission path').to.equal('accepted');
		expect(coldStart.get(TOPIC), 'the hot path never instantiates a forwarder').to.equal(undefined);
	});
});

describe('cohort-topic / member-engine: handleProbe (read-only lookup)', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const self = bytes('probe-self', 16);
	const cohortEpoch = bytes('probe-epoch', 32);
	const members = [self];
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members, cohortEpoch });

	interface ProbeSpies {
		arrivals: number;
		promotionFired: number;
		instantiated: number;
	}

	/**
	 * Compose the minimal engine the probe path needs. `willingness` / `renewal` / `profile` are the
	 * `unused` proxy: a probe must NEVER touch the admission pipeline, so any access fails the test loudly.
	 * The traffic / promotion / cold-start collaborators are spies asserting the probe records / fires /
	 * instantiates nothing.
	 */
	function makeProbeEngine(opts?: {
		isPromoted?: boolean;
		served?: boolean;
		verifyRegisterSig?: (reg: RegisterV1) => boolean;
		probeRateLimiter?: { check: () => { ok: true } | { ok: false; retryAfterMs: number } };
	}): { engine: ReturnType<typeof createCohortMemberEngine>; store: ReturnType<typeof createRegistrationStore>; spies: ProbeSpies } {
		const store = createRegistrationStore();
		const spies: ProbeSpies = { arrivals: 0, promotionFired: 0, instantiated: 0 };
		const traffic = {
			recordArrival: (): void => { spies.arrivals++; },
			recordQuery: (): void => {},
			snapshot: (topicId: Uint8Array): { windowSeconds: number; arrivalsPerMin: number; queriesPerMin: number; directParticipants: number; childCohortCount: number } =>
				({ windowSeconds: 60, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: store.directParticipants(topicId), childCohortCount: 0 }),
		} as never;
		const promotion = {
			onParticipantCountChange: (): Promise<undefined> => { spies.promotionFired++; return Promise.resolve(undefined); },
			maybeDemote: (): Promise<undefined> => Promise.resolve(undefined),
			isPromoted: (): boolean => opts?.isPromoted === true,
			applyPromotionNotice: (): void => {},
			applyDemotionNotice: (): void => {},
		};
		const coldStart = {
			// A probe must never instantiate; if it does, fail loudly.
			instantiate: (): never => { spies.instantiated++; throw new Error('handleProbe must not instantiate a cold-start forwarder'); },
			get: (): undefined => undefined, // never serves via a forwarder in these tests; `served` seeds the store instead
		} as never;
		const engine = createCohortMemberEngine({
			self,
			profile: unused('profile'),
			hash,
			store,
			slots,
			willingness: unused('willingness'),
			promotion,
			coldStart,
			traffic,
			renewal: unused('renewal'),
			cohort,
			quorumWilling: (): boolean => true,
			verifyRegisterSig: opts?.verifyRegisterSig,
			probeRateLimiter: opts?.probeRateLimiter as never,
		});
		return { engine, store, spies };
	}

	/** Seed a soft-state record so `serves(topicId)` is true (a register had admitted `participant`). */
	function seed(store: ReturnType<typeof createRegistrationStore>, topic: Uint8Array, participant: Uint8Array): void {
		const { primary, backups } = slots.assignSlots(participant, cohortEpoch, members);
		store.put({ topicId: topic, participantId: participant, tier: 0, primary, backups, attachedAt: 1_000, lastPing: 1_000, ttl: DEFAULT_TTL_MS });
	}

	function mkProbe(topic: Uint8Array, participant: Uint8Array, cid: string): RegisterV1 {
		return {
			v: 1,
			topicId: bytesKey(topic),
			tier: 0,
			treeTier: 0,
			participantCoord: bytesKey(participant),
			ttl: 90_000,
			probe: true,
			timestamp: 1_000,
			correlationId: bytesKey(bytes(cid)),
			signature: '',
		};
	}

	it('served topic → accepted with the participant-specific slots, leaving the store unchanged (read-only)', async () => {
		const { engine, store, spies } = makeProbeEngine();
		const TOPIC = bytes('probe-served');
		const seedParticipant = bytes('seed-participant', 16);
		seed(store, TOPIC, seedParticipant); // a prior registration → topic is served
		expect(store.directParticipants(TOPIC), 'one resident participant before the probe').to.equal(1);

		const prober = bytes('prober', 16);
		const reply = await engine.handleRegister(mkProbe(TOPIC, prober, 'cid-served'), { followOn: false, treeTier: 0 }, 2_000);

		expect(reply.result).to.equal('accepted');
		// The probe resolves the SAME primary/backups a register would (assignSlots is pure, per-participant).
		const expected = slots.assignSlots(prober, cohortEpoch, members);
		expect(reply.primary).to.equal(bytesKey(expected.primary));
		expect(reply.backups).to.deep.equal(expected.backups.map(bytesKey));
		expect(reply.cohortEpoch).to.equal(bytesKey(cohortEpoch));
		expect(reply.cohortMembers).to.deep.equal(members.map(bytesKey));
		expect(reply.topicTraffic, 'the read-only traffic snapshot is attached').to.not.equal(undefined);

		// Read-only: nothing admitted, counted, or promoted.
		expect(store.directParticipants(TOPIC), 'no new record was persisted').to.equal(1);
		expect(spies.arrivals, 'no arrival counted').to.equal(0);
		expect(spies.promotionFired, 'no promotion trigger fired').to.equal(0);
		expect(spies.instantiated, 'no cold-start instantiation').to.equal(0);
	});

	it('cold topic → no_state, store stays empty, no cold-start instantiation', async () => {
		const { engine, store, spies } = makeProbeEngine();
		const TOPIC = bytes('probe-cold');
		const reply = await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-cold'), { followOn: false, treeTier: 0 }, 2_000);
		expect(reply.result).to.equal('no_state');
		expect(store.directParticipants(TOPIC), 'a cold probe persists nothing').to.equal(0);
		expect(spies.instantiated, 'no instantiation on a cold probe').to.equal(0);
		expect(spies.arrivals).to.equal(0);
	});

	it('promoted topic → promoted with targetTier === ctx.treeTier + 1', async () => {
		const { engine, store } = makeProbeEngine({ isPromoted: true });
		const TOPIC = bytes('probe-promoted');
		seed(store, TOPIC, bytes('seed-promoted', 16)); // served, and promotion.isPromoted → true
		const reply = await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-promoted'), { followOn: false, treeTier: 2 }, 2_000);
		expect(reply.result).to.equal('promoted');
		expect(reply.targetTier).to.equal(3);
	});

	it('never fires the promotion trigger, even when a register at the same point would', async () => {
		// A probe of a served topic classifies and returns; it must not call promotion.onParticipantCountChange
		// (the spy throws-by-count): a real register's `accept` path is what fires that trigger, never a probe.
		const { engine, store, spies } = makeProbeEngine();
		const TOPIC = bytes('probe-no-promote');
		seed(store, TOPIC, bytes('seed-no-promote', 16));
		await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-no-promote'), { followOn: false, treeTier: 0 }, 2_000);
		expect(spies.promotionFired, 'the promotion trigger never fires on a probe').to.equal(0);
	});

	it('over-rate probe → unwilling_cohort with the limiter retryAfterMs', async () => {
		const { engine, store } = makeProbeEngine({ probeRateLimiter: { check: () => ({ ok: false, retryAfterMs: 4_321 }) } });
		const TOPIC = bytes('probe-rate');
		seed(store, TOPIC, bytes('seed-rate', 16)); // served — but the rate gate short-circuits before classify
		const reply = await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-rate'), { followOn: false, treeTier: 0 }, 2_000);
		expect(reply.result).to.equal('unwilling_cohort');
		expect(reply.retryAfterMs).to.equal(4_321);
	});

	it('forged participant signature → no_state (serve nothing), even for a served topic', async () => {
		const { engine, store } = makeProbeEngine({ verifyRegisterSig: () => false });
		const TOPIC = bytes('probe-forged');
		seed(store, TOPIC, bytes('seed-forged', 16));
		const reply = await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-forged'), { followOn: false, treeTier: 0 }, 2_000);
		expect(reply.result, 'a forged-sig probe never resolves a cohort snapshot').to.equal('no_state');
	});

	it('an independent probe rate-limit budget: over-rate probe does not consume the engine register path', async () => {
		// The probe limiter is its own instance; an over-rate probe answers unwilling_cohort but leaves the
		// (absent here) register limiter untouched — asserted structurally by the separate `probeRateLimiter`
		// dep. A served topic still classifies read-only once the probe limiter admits.
		let calls = 0;
		const { engine, store } = makeProbeEngine({ probeRateLimiter: { check: () => { calls++; return { ok: true }; } } });
		const TOPIC = bytes('probe-budget');
		seed(store, TOPIC, bytes('seed-budget', 16));
		const reply = await engine.handleRegister(mkProbe(TOPIC, bytes('p', 16), 'cid-budget'), { followOn: false, treeTier: 0 }, 2_000);
		expect(reply.result).to.equal('accepted');
		expect(calls, 'the probe path consulted its own rate limiter').to.equal(1);
	});
});

describe('cohort-topic / member-engine: sweepStale reclaims idle rate-limiter keys', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const self = bytes('rl-self', 16);
	const cohortEpoch = bytes('rl-epoch', 32);
	const members = [self];
	const cohort = (): { members: readonly Uint8Array[]; cohortEpoch: Uint8Array } => ({ members, cohortEpoch });

	// A cold cohort: never serves a forwarder, so a register lands no_state — but runGuards has already
	// consulted the rate limiter and allocated its (peer, topic) key by then.
	const coldStart = { get: (): undefined => undefined, instantiate: (): never => { throw new Error('sweep test must not instantiate'); } } as never;

	function mkReg(topic: Uint8Array, participant: Uint8Array, cid: string, ts: number, probe = false): RegisterV1 {
		return {
			v: 1,
			topicId: bytesKey(topic),
			tier: 1,
			treeTier: 0,
			participantCoord: bytesKey(participant),
			ttl: 90_000,
			bootstrap: false,
			probe,
			timestamp: ts,
			correlationId: bytesKey(bytes(cid)),
			signature: '',
		};
	}

	it('drives a register + probe to allocate keys, then sweepStale reclaims both once idle', async () => {
		const store = createRegistrationStore();
		const renewal = createRenewalCohortSide({ store, self, slots, cohort, gossip: { touch: (): void => {}, evicted: (): void => {} } });
		const rateLimiter = createRegisterRateLimiter({ idleTtlMs: 1_000 });
		const probeRateLimiter = createRegisterRateLimiter({ idleTtlMs: 1_000 });
		const engine = createCohortMemberEngine({
			self,
			profile: unused('profile'),
			hash,
			store,
			slots,
			willingness: unused('willingness'),
			promotion: unused('promotion'),
			coldStart,
			traffic: unused('traffic'),
			renewal,
			cohort,
			quorumWilling: (): boolean => false, // cold → no_state, but the rate gate ran first
			rateLimiter,
			probeRateLimiter,
		});

		const topic = bytes('rl-topic');
		const peer = bytes('rl-peer', 16);
		const reg = await engine.handleRegister(mkReg(topic, peer, 'rl-cid', 1_000), { followOn: false, treeTier: 0 }, 1_000);
		const probe = await engine.handleRegister(mkReg(topic, peer, 'rl-probe-cid', 1_000, true), { followOn: false, treeTier: 0 }, 1_000);
		expect(reg.result).to.equal('no_state');
		expect(probe.result).to.equal('no_state');
		expect(rateLimiter.size, 'the register allocated a rate-limiter key').to.equal(1);
		expect(probeRateLimiter.size, 'the probe allocated a probe rate-limiter key').to.equal(1);

		// A gossip-round sweep one idle-TTL past the checks reclaims both keys.
		engine.sweepStale(1_000 + 1_000);
		expect(rateLimiter.size, 'the idle register key was reclaimed on the gossip cadence').to.equal(0);
		expect(probeRateLimiter.size, 'the idle probe key was reclaimed on the gossip cadence').to.equal(0);
	});
});
