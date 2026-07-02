import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCohortGossipBus } from '../../src/cohort-topic/gossip/bus.js';
import { toGossipRecord } from '../../src/cohort-topic/gossip/records.js';
import { createRegistrationStore } from '../../src/cohort-topic/registration/store.js';
import { createTopicBudget } from '../../src/cohort-topic/antidos/topic-budget.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import type { ICohortGossipTransport, PeerRef, RingCoord } from '../../src/cohort-topic/ports.js';
import type { RegistrationStore, RegistrationRecord } from '../../src/cohort-topic/registration/types.js';
import type { CohortGossipV1 } from '../../src/cohort-topic/wire/types.js';

function bytes(label: string, len = 32): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

const COORD: RingCoord = bytes('cohort-coord');
const EPOCH = bytes('epoch-1');
const EPOCH2 = bytes('epoch-2');

/** A transport that fans every broadcast to all registered handlers (a shared in-memory cohort bus). */
class FanoutTransport implements ICohortGossipTransport {
	private readonly handlers = new Set<(from: PeerRef, msg: Uint8Array) => void>();
	broadcast(_coord: RingCoord, msg: Uint8Array): void {
		for (const h of this.handlers) {
			h({ id: new Uint8Array(0) }, msg);
		}
	}
	onMessage(handler: (from: PeerRef, msg: Uint8Array) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}
}

function record(participant: string, lastPing: number): RegistrationRecord {
	return {
		topicId: bytes('topic-A'),
		participantId: bytes(participant, 16),
		tier: 1,
		primary: bytes('member-0', 16),
		backups: [bytes('member-1', 16)],
		attachedAt: 1_000,
		lastPing,
		ttl: 90_000,
	};
}

function gossip(from: string, epoch: Uint8Array, opts: Partial<CohortGossipV1> = {}): CohortGossipV1 {
	return {
		v: 1,
		fromMember: from,
		coord: bytesToB64url(COORD),
		cohortEpoch: bytesToB64url(epoch),
		treeTier: 0,
		willingnessBits: 'f',
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 30,
		topicSummaries: [],
		timestamp: 1_000,
		signature: bytesToB64url(bytes('sig', 8)),
		...opts,
	};
}

describe('cohort-topic / gossip bus', () => {
	function busFor(store: RegistrationStore, transport: ICohortGossipTransport, epoch: () => Uint8Array) {
		return createCohortGossipBus({ transport, store, coord: COORD, localEpoch: epoch, now: () => 2_000 });
	}

	it('spreads a touched record to every member within one round', () => {
		// Member A holds + touches a record; B and C have empty stores. One broadcast round converges them.
		const transport = new FanoutTransport();
		const storeA = createRegistrationStore();
		const storeB = createRegistrationStore();
		const storeC = createRegistrationStore();
		const busA = busFor(storeA, transport, () => EPOCH);
		busFor(storeB, transport, () => EPOCH);
		busFor(storeC, transport, () => EPOCH);

		const touched = record('participant-1', 5_000);
		storeA.put(touched);
		busA.broadcast(gossip('member-A', EPOCH, { records: [toGossipRecord(touched)] }));

		for (const store of [storeB, storeC]) {
			const got = store.getByParticipant(touched.topicId, touched.participantId);
			expect(got, 'record visible after one round').to.not.be.undefined;
			expect(got!.lastPing).to.equal(5_000);
		}
	});

	it('merges record deltas last-writer-wins by lastPing', () => {
		const store = createRegistrationStore();
		const bus = busFor(store, new FanoutTransport(), () => EPOCH);
		const older = record('p', 1_000);
		const newer = record('p', 9_000);
		bus.applyInbound(gossip('m', EPOCH, { records: [toGossipRecord(newer)] }), 2_000);
		bus.applyInbound(gossip('m', EPOCH, { records: [toGossipRecord(older)] }), 2_000);
		expect(store.getByParticipant(older.topicId, older.participantId)!.lastPing).to.equal(9_000);
	});

	it('applies an eviction delta', () => {
		const store = createRegistrationStore();
		const rec = record('p', 1_000);
		store.put(rec);
		const bus = busFor(store, new FanoutTransport(), () => EPOCH);
		bus.applyInbound(gossip('m', EPOCH, { evicted: [{ topicId: bytesToB64url(rec.topicId), participantId: bytesToB64url(rec.participantId) }] }), 2_000);
		expect(store.getByParticipant(rec.topicId, rec.participantId)).to.be.undefined;
	});

	it('re-touches the topic budget down when a gossiped eviction drains a topic (sibling-drain leak fix)', () => {
		// A topic whose participants are sharded onto a sibling primary drains into THIS member's store as a
		// gossip eviction (not its own TTL sweep), so the bus must re-touch the budget down via onRecordsEvicted —
		// else the slot leaks exactly as it would on the engine TTL path.
		const store = createRegistrationStore();
		const budget = createTopicBudget({ topicsMax: 2 });
		const rec = record('p', 1_000);
		store.put(rec);
		budget.admit(rec.topicId);
		budget.touch(rec.topicId, store.directParticipants(rec.topicId)); // mirror accept()'s up-touch
		expect(budget.participantCount(rec.topicId), 'admitted topic carries its participant count').to.equal(1);

		const bus = createCohortGossipBus({
			transport: new FanoutTransport(),
			store,
			coord: COORD,
			localEpoch: () => EPOCH,
			now: () => 2_000,
			onRecordsEvicted: (topicIds) => {
				for (const t of topicIds) budget.touch(t, store.directParticipants(t));
			},
		});
		bus.applyInbound(gossip('m', EPOCH, { evicted: [{ topicId: bytesToB64url(rec.topicId), participantId: bytesToB64url(rec.participantId) }] }), 2_000);
		expect(store.getByParticipant(rec.topicId, rec.participantId), 'the gossiped eviction removed the record').to.be.undefined;
		expect(budget.participantCount(rec.topicId), 'the drained topic was re-touched down to 0 (slot reclaimable)').to.equal(0);
	});

	it('fires onRecordsEvicted once per distinct drained topic, and not at all without evictions', () => {
		const store = createRegistrationStore();
		const calls: string[][] = [];
		const bus = createCohortGossipBus({
			transport: new FanoutTransport(),
			store,
			coord: COORD,
			localEpoch: () => EPOCH,
			now: () => 2_000,
			onRecordsEvicted: (topicIds) => calls.push(topicIds.map(bytesToB64url)),
		});
		// A records-only merge (no evictions) must not fire the hook.
		bus.applyInbound(gossip('m', EPOCH, { records: [toGossipRecord(record('p', 5_000))] }), 2_000);
		expect(calls.length, 'no eviction → hook not fired').to.equal(0);

		// Two evictions naming the SAME topic collapse to one distinct topic id in a single hook call.
		const r1 = record('p1', 5_000);
		const r2 = record('p2', 5_000); // both carry topicId bytes('topic-A')
		store.put(r1);
		store.put(r2);
		bus.applyInbound(gossip('m', EPOCH, { evicted: [
			{ topicId: bytesToB64url(r1.topicId), participantId: bytesToB64url(r1.participantId) },
			{ topicId: bytesToB64url(r2.topicId), participantId: bytesToB64url(r2.participantId) },
		] }), 2_000);
		expect(calls.length, 'one merge with evictions → exactly one hook call').to.equal(1);
		expect(calls[0], 'distinct topic ids only').to.deep.equal([bytesToB64url(r1.topicId)]);
	});

	it('does not resurrect a record already past its TTL at merge time', () => {
		// rec: lastPing 1_000, ttl 90_000 → expired once now − lastPing > ttl. Replication must not
		// reintroduce a registration the owner has effectively evicted (matches store.evictStale).
		const store = createRegistrationStore();
		const bus = busFor(store, new FanoutTransport(), () => EPOCH);
		const stale = record('p', 1_000);
		bus.applyInbound(gossip('m', EPOCH, { records: [toGossipRecord(stale)] }), 200_000);
		expect(store.getByParticipant(stale.topicId, stale.participantId), 'expired record dropped').to.be.undefined;
	});

	it('merges the per-member view (willingness/load/summaries)', () => {
		const bus = busFor(createRegistrationStore(), new FanoutTransport(), () => EPOCH);
		bus.applyInbound(gossip('member-X', EPOCH, { willingnessBits: 'a', loadBuckets: [1, 2, 3, 4], timestamp: 10 }), 2_000);
		const c = bus.view().get('member-X');
		expect(c, 'member contribution recorded').to.not.be.undefined;
		expect(c!.willingness).to.equal(0xa);
		expect([...c!.loadBuckets]).to.deep.equal([1, 2, 3, 4]);
	});

	it('keeps the newest contribution per member (view is last-writer-wins by timestamp)', () => {
		const bus = busFor(createRegistrationStore(), new FanoutTransport(), () => EPOCH);
		bus.applyInbound(gossip('m', EPOCH, { willingnessBits: 'f', timestamp: 100 }), 2_000);
		bus.applyInbound(gossip('m', EPOCH, { willingnessBits: '0', timestamp: 50 }), 2_000); // stale
		expect(bus.view().get('m')!.willingness).to.equal(0xf);
	});

	it('detects cohort-epoch drift and does not merge foreign-epoch records', () => {
		const store = createRegistrationStore();
		const bus = busFor(store, new FanoutTransport(), () => EPOCH);
		let drift: { inbound: Uint8Array; from: string } | undefined;
		bus.onDrift((inbound, _local, from) => { drift = { inbound, from }; });

		const rec = record('p', 5_000);
		bus.applyInbound(gossip('member-stale', EPOCH2, { records: [toGossipRecord(rec)] }), 2_000);

		expect(drift, 'drift fired').to.not.be.undefined;
		expect(drift!.from).to.equal('member-stale');
		expect(bytesToB64url(drift!.inbound)).to.equal(bytesToB64url(EPOCH2));
		expect(store.getByParticipant(rec.topicId, rec.participantId), 'foreign-epoch record not merged').to.be.undefined;
	});

	it('does not fire drift when the inbound epoch matches local', () => {
		const bus = busFor(createRegistrationStore(), new FanoutTransport(), () => EPOCH);
		let fired = false;
		bus.onDrift(() => { fired = true; });
		bus.applyInbound(gossip('m', EPOCH), 2_000);
		expect(fired).to.be.false;
	});

	it('routes by coord: a gossip naming a different cohort is not merged', () => {
		// Two coords can share a member set (hence an epoch), so epoch alone never isolates them — the
		// bus must drop a gossip whose `coord` is not its own, record deltas and all.
		const store = createRegistrationStore();
		const bus = busFor(store, new FanoutTransport(), () => EPOCH);
		const rec = record('p', 5_000);
		const foreign = gossip('m', EPOCH, { coord: bytesToB64url(bytes('other-coord')), records: [toGossipRecord(rec)] });
		bus.applyInbound(foreign, 2_000);
		expect(store.getByParticipant(rec.topicId, rec.participantId), 'foreign-coord record not merged').to.be.undefined;
		expect(bus.view().get('m'), 'foreign-coord view not merged').to.be.undefined;
	});

	it('verifyInbound drops an unauthenticated transport frame before any merge', () => {
		// The auth gate only guards the transport path (onInbound), so drive a real broadcast through it.
		const transport = new FanoutTransport();
		const store = createRegistrationStore();
		const bus = createCohortGossipBus({ transport, store, coord: COORD, localEpoch: () => EPOCH, now: () => 2_000, verifyInbound: () => false });
		const rec = record('p', 5_000);
		// A second bus (no gate) broadcasts a record; the gated bus receives it over the transport.
		const sender = busFor(createRegistrationStore(), transport, () => EPOCH);
		sender.broadcast(gossip('m', EPOCH, { records: [toGossipRecord(rec)] }));
		expect(store.getByParticipant(rec.topicId, rec.participantId), 'rejected frame not merged').to.be.undefined;
		expect(bus.view().get('m'), 'rejected frame view not merged').to.be.undefined;
	});

	it('verifyInbound passing a frame merges it as usual', () => {
		const transport = new FanoutTransport();
		const store = createRegistrationStore();
		const seen: string[] = [];
		createCohortGossipBus({ transport, store, coord: COORD, localEpoch: () => EPOCH, now: () => 2_000, verifyInbound: (g) => { seen.push(g.fromMember); return true; } });
		const rec = record('p', 5_000);
		const sender = busFor(createRegistrationStore(), transport, () => EPOCH);
		sender.broadcast(gossip('m', EPOCH, { records: [toGossipRecord(rec)] }));
		expect(store.getByParticipant(rec.topicId, rec.participantId)?.lastPing, 'verified frame merged').to.equal(5_000);
		expect(seen, 'gate saw the inbound frame').to.deep.equal(['m']);
	});
});
