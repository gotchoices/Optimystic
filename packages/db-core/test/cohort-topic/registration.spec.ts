import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { createRegistrationStore } from '../../src/cohort-topic/registration/store.js';
import { createSlotAssigner } from '../../src/cohort-topic/registration/sharding.js';
import { bytesEqual, bytesKey } from '../../src/cohort-topic/registration/bytes.js';
import {
	createRenewalParticipant,
	createRenewalCohortSide,
} from '../../src/cohort-topic/registration/renewal.js';
import type {
	RenewalGossip,
	RenewalParticipantTransport,
} from '../../src/cohort-topic/registration/renewal.js';
import {
	createMembershipHandoff,
} from '../../src/cohort-topic/registration/handoff.js';
import type {
	HandoffTransport,
	MembershipHandoff,
	PrimaryInventory,
	RecordRef,
} from '../../src/cohort-topic/registration/handoff.js';
import {
	DEFAULT_TTL_MS,
	pingIntervalMs,
} from '../../src/cohort-topic/registration/types.js';
import type { RegistrationRecord } from '../../src/cohort-topic/registration/types.js';
import type { RenewReplyV1, RenewV1 } from '../../src/cohort-topic/wire/index.js';
import { b64urlToBytes } from '../../src/cohort-topic/wire/index.js';

const enc = new TextEncoder();
function bytes(label: string, len = 8): Uint8Array {
	return sha256(enc.encode(label)).slice(0, len);
}
function topic(label: string): Uint8Array {
	return sha256(enc.encode(`topic-${label}`)).slice(0, 32);
}
function record(over: Partial<RegistrationRecord> = {}): RegistrationRecord {
	return {
		topicId: topic('T'),
		participantId: bytes('participant'),
		tier: 1,
		primary: bytes('member-0'),
		backups: [bytes('member-1'), bytes('member-2')],
		attachedAt: 1_000,
		lastPing: 1_000,
		ttl: DEFAULT_TTL_MS,
		...over,
	};
}

describe('cohort-topic / registration store', () => {
	it('indexes by participant and by topic', () => {
		const store = createRegistrationStore();
		const tA = topic('A');
		const tB = topic('B');
		const p1 = bytes('p1');
		const p2 = bytes('p2');
		store.put(record({ topicId: tA, participantId: p1 }));
		store.put(record({ topicId: tA, participantId: p2 }));
		store.put(record({ topicId: tB, participantId: p1 }));

		expect(store.getByParticipant(tA, p1)).to.not.be.undefined;
		expect(store.getByParticipant(tA, p1)!.topicId).to.equal(tA);
		expect(store.listByTopic(tA)).to.have.length(2);
		expect(store.listByTopic(tB)).to.have.length(1);
		expect(store.directParticipants(tA)).to.equal(2);
		expect(store.listAll()).to.have.length(3);
	});

	it('put replaces an existing participant record', () => {
		const store = createRegistrationStore();
		const t = topic('A');
		const p = bytes('p1');
		store.put(record({ topicId: t, participantId: p, lastPing: 1 }));
		store.put(record({ topicId: t, participantId: p, lastPing: 9 }));
		expect(store.directParticipants(t)).to.equal(1);
		expect(store.getByParticipant(t, p)!.lastPing).to.equal(9);
	});

	it('delete drops the record and prunes the empty topic', () => {
		const store = createRegistrationStore();
		const t = topic('A');
		const p = bytes('p1');
		store.put(record({ topicId: t, participantId: p }));
		store.delete(t, p);
		expect(store.getByParticipant(t, p)).to.be.undefined;
		expect(store.directParticipants(t)).to.equal(0);
		expect(store.listByTopic(t)).to.have.length(0);
	});

	it('evictStale removes records where now − lastPing > ttl, returning them', () => {
		const store = createRegistrationStore();
		const t = topic('A');
		const fresh = record({ topicId: t, participantId: bytes('fresh'), lastPing: 1_000, ttl: 100 });
		const stale = record({ topicId: t, participantId: bytes('stale'), lastPing: 1_000, ttl: 100 });
		store.put(fresh);
		store.put(stale);
		// now = 1_050 → fresh (50 ≤ 100) survives; bump now past ttl for the stale one only.
		expect(store.evictStale(1_050)).to.have.length(0);
		const evicted = store.evictStale(1_101); // 101 > 100
		expect(evicted).to.have.length(2); // both now stale at this clock
		expect(store.directParticipants(t)).to.equal(0);
	});

	it('evictStale uses each record’s own ttl boundary (strictly greater-than)', () => {
		const store = createRegistrationStore();
		const t = topic('A');
		store.put(record({ topicId: t, participantId: bytes('edge'), lastPing: 0, ttl: 100 }));
		expect(store.evictStale(100), 'exactly ttl is not yet stale').to.have.length(0);
		expect(store.evictStale(101)).to.have.length(1);
	});
});

// --- renewal: participant side ---

type SendBehavior = (target: Uint8Array, msg: RenewV1) => RenewReplyV1 | 'fail';

class MockParticipantTransport implements RenewalParticipantTransport {
	public readonly sentTo: string[] = [];
	public readonly sent: RenewV1[] = [];
	public relookups = 0;
	constructor(private readonly behavior: SendBehavior) {}
	async send(target: Uint8Array, msg: RenewV1): Promise<RenewReplyV1> {
		this.sentTo.push(bytesKey(target));
		this.sent.push(msg);
		const r = this.behavior(target, msg);
		if (r === 'fail') throw new Error('rpc failed');
		return r;
	}
	async relookup(): Promise<void> {
		this.relookups++;
	}
}

const okReply: RenewReplyV1 = { v: 1, result: 'ok' };

function participant(transport: MockParticipantTransport, init?: Partial<RegistrationRecord>) {
	return createRenewalParticipant(record(init), {
		transport,
		clock: () => 5_000,
		sign: () => Promise.resolve('sig'),
		correlationId: bytesKey(bytes('corr', 16)),
		initialCohortEpoch: bytes('epoch-1', 32),
	});
}

describe('cohort-topic / renewal participant', () => {
	it('pings the primary and resets the failure count on success', async () => {
		const t = new MockParticipantTransport(() => okReply);
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		expect(t.sentTo).to.deep.equal([bytesKey(record().primary), bytesKey(record().primary)]);
		expect(bytesEqual(p.record.primary, record().primary)).to.be.true;
	});

	it('promotes backups[0] after exactly three consecutive primary failures', async () => {
		const primary = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		const t = new MockParticipantTransport((target) =>
			bytesKey(target) === primary ? 'fail' : okReply,
		);
		const p = participant(t);
		await p.pingLoop(); // fail 1
		await p.pingLoop(); // fail 2
		expect(bytesEqual(p.record.primary, record().primary), 'no promotion before the 3rd fail').to.be.true;
		await p.pingLoop(); // fail 3 → reattach backups[0]
		expect(bytesEqual(p.record.primary, backup0), 'backups[0] promoted to primary').to.be.true;
		expect(p.record.backups.map(bytesKey)).to.not.include(bytesKey(backup0));
		// the failover reattach hit backups[0], not backups[1]
		expect(t.sentTo[t.sentTo.length - 1]).to.equal(bytesKey(backup0));
	});

	it('promotion cadence is ttl/3', () => {
		const t = new MockParticipantTransport(() => okReply);
		const p = participant(t);
		expect(p.pingIntervalMs).to.equal(pingIntervalMs(DEFAULT_TTL_MS));
		expect(p.pingIntervalMs).to.equal(Math.floor(DEFAULT_TTL_MS / 3));
	});

	it('re-runs lookup from d_max when primary and all backups fail', async () => {
		const t = new MockParticipantTransport(() => 'fail');
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // 3rd fail → failover tries both backups → relookup
		expect(t.relookups).to.equal(1);
	});

	it('backs off relookup to one per MAX_PING_FAILURES cycles when everything stays dead', async () => {
		const t = new MockParticipantTransport(() => 'fail');
		const p = participant(t);
		// Six consecutive failing pings: relookup fires on the 3rd and again on the 6th, not every cycle.
		for (let i = 0; i < 6; i++) await p.pingLoop();
		expect(t.relookups).to.equal(2);
	});

	it('refreshes the cohortEpoch hint lazily: not at failover, but on the next primary_moved ping', async () => {
		const primary = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		const movedEpoch = bytes('epoch-2', 32);
		const newPrimary = bytes('member-9');
		const t = new MockParticipantTransport((target) => {
			if (bytesKey(target) === primary) return 'fail';
			if (bytesEqual(target, backup0)) {
				// First the reattach succeeds plainly (no epoch refresh at failover time)...
				return okReply;
			}
			return okReply;
		});
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // promotes backups[0]
		expect(bytesEqual(p.cohortEpochHint!, bytes('epoch-1', 32)), 'epoch unchanged at failover').to.be.true;

		// Next ping to the new primary returns primary_moved carrying the fresh epoch → lazy refresh.
		const t2 = new MockParticipantTransport(() => ({
			v: 1,
			result: 'primary_moved',
			newPrimary: bytesKey(newPrimary),
			newBackups: [bytesKey(bytes('member-10'))],
			cohortEpoch: bytesKey(movedEpoch),
		}));
		const p2 = createRenewalParticipant(record({ primary: backup0 }), {
			transport: t2,
			clock: () => 6_000,
			sign: () => Promise.resolve('sig'),
			correlationId: 'c',
			initialCohortEpoch: bytes('epoch-1', 32),
		});
		await p2.pingLoop();
		expect(bytesEqual(p2.cohortEpochHint!, movedEpoch), 'epoch refreshed on primary_moved').to.be.true;
		expect(bytesEqual(p2.record.primary, newPrimary)).to.be.true;
	});

	it('sends reattach=true on the failover re-attach and a falsy reattach on a normal ping', async () => {
		const primary = bytesKey(record().primary);
		const t = new MockParticipantTransport((target) => (bytesKey(target) === primary ? 'fail' : okReply));
		const p = participant(t);
		await p.pingLoop(); // plain ping (fail 1)
		expect(t.sent[0]!.reattach, 'plain ping carries a falsy reattach').to.not.equal(true);
		await p.pingLoop(); // fail 2
		await p.pingLoop(); // fail 3 → re-attach backups[0]
		const last = t.sent[t.sent.length - 1]!;
		expect(last.reattach, 're-attach carries the signed reattach flag').to.equal(true);
		expect(t.sentTo[t.sentTo.length - 1], 're-attach went to backups[0]').to.equal(bytesKey(record().backups[0]!));
	});

	it('crash failover: promotes backups[0] on ok and subsequent plain pings stay on it (anti-bounce)', async () => {
		const primary = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		// The dead primary always fails; the promoted backup serves every ping (plain or re-attach).
		const t = new MockParticipantTransport((target) => (bytesKey(target) === primary ? 'fail' : okReply));
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // 3rd fail → re-attach backups[0] returns ok → promote
		expect(bytesEqual(p.record.primary, backup0), 'backups[0] promoted').to.be.true;
		// Several subsequent plain pings: they go to backup0 and it keeps serving — no bounce back.
		const beforeRelookups = t.relookups;
		for (let i = 0; i < 4; i++) {
			await p.pingLoop();
			expect(bytesEqual(p.record.primary, backup0), `still on backups[0] after subsequent ping ${i}`).to.be.true;
		}
		expect(t.relookups, 'no relookup once promoted backup keeps serving').to.equal(beforeRelookups);
	});

	it('failover honors primary_moved to a live member instead of blind-promoting the contacted backup', async () => {
		const primary = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		const liveMember = bytes('member-live');
		const movedEpoch = bytes('epoch-rot', 32);
		const t = new MockParticipantTransport((target) => {
			if (bytesKey(target) === primary) return 'fail';
			if (bytesEqual(target, backup0)) {
				return {
					v: 1,
					result: 'primary_moved',
					newPrimary: bytesKey(liveMember),
					newBackups: [bytesKey(bytes('member-live-b'))],
					cohortEpoch: bytesKey(movedEpoch),
				};
			}
			return okReply;
		});
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // 3rd fail → re-attach backups[0] → primary_moved to a live member
		expect(bytesEqual(p.record.primary, liveMember), 'adopts the rotated live primary').to.be.true;
		expect(bytesEqual(p.cohortEpochHint!, movedEpoch), 'epoch hint refreshed from primary_moved').to.be.true;
	});

	it('failover ignores a primary_moved that points back at the just-failed primary (bounce guard)', async () => {
		const deadPrimary = record().primary;
		const primaryKey = bytesKey(deadPrimary);
		const backup0 = record().backups[0]!;
		const backup1 = record().backups[1]!;
		const t = new MockParticipantTransport((target) => {
			if (bytesKey(target) === primaryKey) return 'fail';
			if (bytesEqual(target, backup0)) {
				// Adversarial/stale reply pointing back at the corpse — must be ignored.
				return { v: 1, result: 'primary_moved', newPrimary: bytesKey(deadPrimary) };
			}
			if (bytesEqual(target, backup1)) return okReply; // next backup accepts
			return okReply;
		});
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // 3rd fail → backups[0] bounce-guarded → backups[1] promoted
		expect(bytesEqual(p.record.primary, deadPrimary), 'never re-adopts the dead primary').to.be.false;
		expect(bytesEqual(p.record.primary, backup1), 'falls through to the next backup').to.be.true;
	});

	it('re-attach unknown_registration falls through to the next backup, else relookup', async () => {
		const primaryKey = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		const backup1 = record().backups[1]!;
		const t = new MockParticipantTransport((target) => {
			if (bytesKey(target) === primaryKey) return 'fail';
			if (bytesEqual(target, backup0)) return { v: 1, result: 'unknown_registration' };
			if (bytesEqual(target, backup1)) return okReply;
			return okReply;
		});
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // backups[0] unknown → backups[1] ok
		expect(bytesEqual(p.record.primary, backup1), 'promotes the backup that confirmed').to.be.true;

		// All backups unknown → relookup.
		const t2 = new MockParticipantTransport((target) =>
			bytesKey(target) === primaryKey ? 'fail' : { v: 1, result: 'unknown_registration' },
		);
		const p2 = participant(t2);
		await p2.pingLoop();
		await p2.pingLoop();
		await p2.pingLoop();
		expect(t2.relookups, 'relookup when no backup confirms').to.equal(1);
	});

	it('resets the strike count after adopting a primary_moved during failover (no immediate re-failover)', async () => {
		const deadPrimary = bytesKey(record().primary);
		const backup0 = record().backups[0]!;
		const liveMember = bytes('member-live');
		const liveB = bytes('member-live-b');
		// Dead primary fails; backup0 redirects to a (also-unreachable) live member that itself fails.
		const t = new MockParticipantTransport((target) => {
			if (bytesKey(target) === deadPrimary) return 'fail';
			if (bytesEqual(target, backup0)) {
				return { v: 1, result: 'primary_moved', newPrimary: bytesKey(liveMember), newBackups: [bytesKey(liveB)] };
			}
			return 'fail'; // liveMember + liveB are unreachable
		});
		const p = participant(t);
		await p.pingLoop();
		await p.pingLoop();
		await p.pingLoop(); // 3rd fail → failover → backup0 redirects → adopt liveMember
		expect(bytesEqual(p.record.primary, liveMember), 'adopted the moved primary').to.be.true;

		// A single failed ping of the new primary must NOT immediately re-failover: the strike count
		// was reset on adoption, so we still owe two more strikes before failover/relookup.
		await p.pingLoop();
		expect(t.relookups, 'one transient failure does not re-failover right after adoption').to.equal(0);
		await p.pingLoop();
		expect(t.relookups, 'still under the 3-strike threshold').to.equal(0);
		await p.pingLoop(); // now the 3rd consecutive failure of the new primary → failover → relookup
		expect(t.relookups, 'failover only after a fresh run of MAX_PING_FAILURES').to.equal(1);
	});
});

// --- renewal: cohort side ---

function renewMsg(rec: RegistrationRecord, reattach = false): RenewV1 {
	const msg: RenewV1 = {
		v: 1,
		topicId: bytesKey(rec.topicId),
		participantId: bytesKey(rec.participantId),
		correlationId: 'c',
		timestamp: 1,
		signature: 's',
	};
	if (reattach) {
		msg.reattach = true;
	}
	return msg;
}

class RecordingGossip implements RenewalGossip {
	public readonly touched: string[] = [];
	public readonly evictedKeys: string[] = [];
	touch(rec: RegistrationRecord): void {
		this.touched.push(bytesKey(rec.participantId));
	}
	evicted(rec: RegistrationRecord): void {
		this.evictedKeys.push(bytesKey(rec.participantId));
	}
}

describe('cohort-topic / renewal cohort side', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);
	const cohortMembers = Array.from({ length: 5 }, (_, i) => bytes(`cm-${i}`));
	const epoch = bytes('epoch-c', 32);

	function sideAt(self: Uint8Array, gossip: RecordingGossip, store = createRegistrationStore()) {
		return {
			store,
			side: createRenewalCohortSide({
				store,
				self,
				slots,
				cohort: () => ({ members: cohortMembers, cohortEpoch: epoch }),
				gossip,
			}),
		};
	}

	it('touches lastPing and gossips when the renew lands on the current primary', () => {
		const t = topic('R');
		const p = bytes('rp');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(primary, gossip);
		const rec = record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 });
		store.put(rec);
		const reply = side.onRenew(renewMsg(rec), 9_000);
		expect(reply.result).to.equal('ok');
		expect(store.getByParticipant(t, p)!.lastPing).to.equal(9_000);
		expect(gossip.touched).to.deep.equal([bytesKey(p)]);
	});

	it('returns unknown_registration for a record it does not hold', () => {
		const gossip = new RecordingGossip();
		const { side } = sideAt(cohortMembers[0]!, gossip);
		const reply = side.onRenew(renewMsg(record({ topicId: topic('R'), participantId: bytes('ghost') })), 1);
		expect(reply.result).to.equal('unknown_registration');
	});

	it('returns primary_moved when this member is no longer the computed primary', () => {
		const t = topic('R');
		const p = bytes('rp2');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		// Pick a self that is NOT the computed primary.
		const notPrimary = cohortMembers.find((m) => !bytesEqual(m, primary))!;
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(notPrimary, gossip);
		store.put(record({ topicId: t, participantId: p, primary, backups }));
		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 5_000);
		expect(reply.result).to.equal('primary_moved');
		expect(bytesEqual(b64urlToBytes(reply.newPrimary!), primary)).to.be.true;
		expect(reply.cohortEpoch).to.equal(bytesKey(epoch));
	});

	it('keeps serving a moved record while the dual-serve predicate holds, then redirects', () => {
		const t = topic('R');
		const p = bytes('rp3');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const notPrimary = cohortMembers.find((m) => !bytesEqual(m, primary))!;
		const gossip = new RecordingGossip();
		const store = createRegistrationStore();
		let dualServing = true;
		const side = createRenewalCohortSide({
			store,
			self: notPrimary,
			slots,
			cohort: () => ({ members: cohortMembers, cohortEpoch: epoch }),
			gossip,
			isServing: () => dualServing,
		});
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 }));
		// While dual-serving: touch + serve despite not being the computed primary.
		const served = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 7_000);
		expect(served.result).to.equal('ok');
		expect(store.getByParticipant(t, p)!.lastPing).to.equal(7_000);
		// After the ack (dual-serve ends): redirect.
		dualServing = false;
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 8_000).result).to.equal('primary_moved');
	});

	it('accepts a re-attach from a computed backup that holds the record, then serves subsequent plain pings', () => {
		const t = topic('FR');
		const p = bytes('fp1');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const self = backups[0]!; // a computed backup
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(self, gossip);
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 }));

		const reattachReply = side.onRenew(renewMsg(record({ topicId: t, participantId: p }), true), 4_000);
		expect(reattachReply.result, 're-attach accepted by computed backup').to.equal('ok');
		const held = store.getByParticipant(t, p)!;
		expect(held.lastPing, 'lastPing touched').to.equal(4_000);
		expect(bytesEqual(held.primary, self), 'primary re-stamped to self').to.be.true;
		expect(held.backups.map(bytesKey), 'self removed from backups').to.not.include(bytesKey(self));
		expect(gossip.touched, 'gossiped the re-stamped record').to.deep.equal([bytesKey(p)]);

		// Subsequent PLAIN ping under the unchanged epoch: served via the failover override, not redirected.
		const plainReply = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 5_000);
		expect(plainReply.result, 'override serves the subsequent plain ping').to.equal('ok');
		expect(store.getByParticipant(t, p)!.lastPing).to.equal(5_000);
	});

	it('a plain ping on a backup that holds the record redirects (no promotion, no override)', () => {
		const t = topic('FR');
		const p = bytes('fp2');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const self = backups[0]!;
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(self, gossip);
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 }));

		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 4_000);
		expect(reply.result, 'plain ping never promotes').to.equal('primary_moved');
		expect(bytesEqual(b64urlToBytes(reply.newPrimary!), primary)).to.be.true;
		expect(store.getByParticipant(t, p)!.primary, 'record untouched by a plain ping').to.satisfy((x: Uint8Array) => bytesEqual(x, primary));
		// No override created → a further plain ping still redirects.
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 5_000).result).to.equal('primary_moved');
	});

	it('redirects a re-attach landing on a member that is neither primary nor a computed backup', () => {
		const t = topic('FR');
		const p = bytes('fp3');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const self = cohortMembers.find(
			(m) => !bytesEqual(m, primary) && !backups.some((b) => bytesEqual(b, m)),
		)!;
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(self, gossip);
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 }));

		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p }), true), 4_000);
		expect(reply.result, 'non-backup re-attach is redirected, not promoted').to.equal('primary_moved');
		expect(bytesEqual(store.getByParticipant(t, p)!.primary, primary), 'record not re-stamped').to.be.true;
	});

	it('the failover override is epoch-scoped: a rotation clears it', () => {
		const t = topic('FR');
		const p = bytes('fp4');
		const epoch1 = bytes('epoch-e1', 32);
		const epoch2 = bytes('epoch-e2', 32);
		const a1 = slots.assignSlots(p, epoch1, cohortMembers);
		const self = a1.backups[0]!; // computed backup under epoch-1
		const gossip = new RecordingGossip();
		const store = createRegistrationStore();
		let currentEpoch = epoch1;
		const side = createRenewalCohortSide({
			store,
			self,
			slots,
			cohort: () => ({ members: cohortMembers, cohortEpoch: currentEpoch }),
			gossip,
		});
		store.put(record({ topicId: t, participantId: p, primary: a1.primary, backups: a1.backups, lastPing: 1_000 }));

		// Accept the re-attach under epoch-1 → override set.
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p }), true), 4_000).result).to.equal('ok');
		// Sanity: still served under epoch-1.
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 4_100).result).to.equal('ok');

		// Rotate to epoch-2; the stale override must not serve.
		currentEpoch = epoch2;
		const a2 = slots.assignSlots(p, epoch2, cohortMembers);
		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 5_000);
		if (bytesEqual(a2.primary, self)) {
			expect(reply.result, 'serves only because self is the new computed primary').to.equal('ok');
		} else {
			expect(reply.result, 'stale override no longer serves across the rotation').to.equal('primary_moved');
		}
	});

	it('accepts a re-attach where this member is already the computed primary, without a redundant override', () => {
		const t = topic('FR');
		const p = bytes('fp5');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(primary, gossip); // self == computed primary
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000 }));

		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p }), true), 4_000);
		expect(reply.result).to.equal('ok');
		expect(store.getByParticipant(t, p)!.lastPing).to.equal(4_000);
		// Serves as the computed primary (not via an override); a plain ping continues to serve.
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 4_500).result).to.equal('ok');
	});

	it('clears a failover override when its record is evicted (no stale serve after re-registration)', () => {
		const t = topic('FR');
		const p = bytes('fp6');
		const { primary, backups } = slots.assignSlots(p, epoch, cohortMembers);
		const self = backups[0]!; // a computed backup that will accept the takeover
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(self, gossip);
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 1_000, ttl: 100 }));

		// Accept the re-attach → override recorded under the current epoch, primary re-stamped to self.
		expect(side.onRenew(renewMsg(record({ topicId: t, participantId: p }), true), 1_050).result).to.equal('ok');

		// The record goes stale and is swept; the override must be cleared with it.
		const evicted = side.sweepStale(1_200); // 1200 - 1050 = 150 > ttl 100
		expect(evicted.map((r) => bytesKey(r.participantId))).to.include(bytesKey(p));

		// Same participant re-registers under the UNCHANGED epoch, naming the deterministic primary again.
		store.put(record({ topicId: t, participantId: p, primary, backups, lastPing: 2_000, ttl: 100 }));
		// A plain ping to `self` (no longer the computed primary, override gone) must redirect — not serve.
		const reply = side.onRenew(renewMsg(record({ topicId: t, participantId: p })), 2_050);
		expect(reply.result, 'stale override did not survive eviction').to.equal('primary_moved');
		expect(bytesEqual(b64urlToBytes(reply.newPrimary!), primary)).to.be.true;
	});

	it('sweepStale evicts every stale record and gossips each eviction', () => {
		const t = topic('R');
		const gossip = new RecordingGossip();
		const { store, side } = sideAt(cohortMembers[0]!, gossip);
		store.put(record({ topicId: t, participantId: bytes('s1'), lastPing: 0, ttl: 100 }));
		store.put(record({ topicId: t, participantId: bytes('s2'), lastPing: 0, ttl: 100 }));
		store.put(record({ topicId: t, participantId: bytes('alive'), lastPing: 1_000, ttl: 100 }));
		const evicted = side.sweepStale(150); // s1,s2 stale (150 > 100); alive fresh (lastPing 1000)
		expect(evicted).to.have.length(2);
		expect(gossip.evictedKeys.sort()).to.deep.equal([bytesKey(bytes('s1')), bytesKey(bytes('s2'))].sort());
		expect(store.directParticipants(t)).to.equal(1);
	});
});

// --- membership-rotation handoff ---

/**
 * Cohort harness: each member has its own store + handoff. The transport wires `pull` to the
 * holder's `onPull` and `ack` to the holder's `onAck`, and fans inventories out to every other
 * member. Inventories are queued and drained explicitly so tests can inspect intermediate state.
 */
class HandoffHarness {
	readonly stores = new Map<string, ReturnType<typeof createRegistrationStore>>();
	readonly handoffs = new Map<string, MembershipHandoff>();
	private readonly inbox: Array<{ to: string; inv: PrimaryInventory }> = [];
	private epoch: Uint8Array;

	constructor(
		readonly members: Uint8Array[],
		private readonly slots = createSlotAssigner(createRingHash()),
	) {
		this.epoch = bytes('epoch-1', 32);
		for (const m of members) {
			const store = createRegistrationStore();
			this.stores.set(bytesKey(m), store);
			const self = m;
			const transport: HandoffTransport = {
				sendInventory: (inv) => {
					for (const other of members) {
						if (!bytesEqual(other, self)) this.inbox.push({ to: bytesKey(other), inv });
					}
				},
				pull: async (from, ref) => this.handoffs.get(bytesKey(from))!.onPull(ref),
				ack: (to, ref) => this.handoffs.get(bytesKey(to))!.onAck(ref),
			};
			this.handoffs.set(bytesKey(m), createMembershipHandoff({
				store,
				self,
				slots: this.slots,
				cohort: () => ({ members: this.members, cohortEpoch: this.epoch }),
				transport,
			}));
		}
	}

	setEpoch(e: Uint8Array): void {
		this.epoch = e;
	}

	/** Seed a record onto whichever member is its primary under the current epoch (and its backups). */
	seed(rec: Omit<RegistrationRecord, 'primary' | 'backups'>): RegistrationRecord {
		const { primary, backups } = this.slots.assignSlots(rec.participantId, this.epoch, this.members);
		const full: RegistrationRecord = { ...rec, primary, backups };
		this.stores.get(bytesKey(primary))!.put(full);
		return full;
	}

	startAll(): void {
		for (const m of this.members) this.handoffs.get(bytesKey(m))!.start();
	}

	async drainInbox(): Promise<void> {
		while (this.inbox.length > 0) {
			const { to, inv } = this.inbox.shift()!;
			await this.handoffs.get(to)!.onInventory(inv);
		}
	}

	holderOf(rec: RegistrationRecord): Uint8Array | undefined {
		return this.members.find((m) => this.stores.get(bytesKey(m))!.getByParticipant(rec.topicId, rec.participantId) !== undefined);
	}
}

describe('cohort-topic / membership-rotation handoff', () => {
	const slots = createSlotAssigner(createRingHash());
	const members = Array.from({ length: 5 }, (_, i) => bytes(`hm-${i}`));

	it('hands every record to its new primary with no loss across a membership change', async () => {
		const harness = new HandoffHarness(members, slots);
		const t = topic('H');
		// Seed 40 participants under epoch-1 onto their primaries.
		const seeds: RegistrationRecord[] = [];
		for (let i = 0; i < 40; i++) {
			seeds.push(harness.seed({
				topicId: t, participantId: bytes(`hp-${i}`), tier: 1,
				attachedAt: 1, lastPing: 1, ttl: DEFAULT_TTL_MS,
			}));
		}
		// Rotate the epoch, then run the inventory → pull → ack handoff.
		const epoch2 = bytes('epoch-2', 32);
		harness.setEpoch(epoch2);
		harness.startAll();
		await harness.drainInbox();

		// Every record is now held by the member that is its primary under epoch-2.
		for (const s of seeds) {
			const newPrimary = slots.assignSlots(s.participantId, epoch2, members).primary;
			const holder = harness.holderOf(s);
			expect(holder, `record ${bytesKey(s.participantId)} survived`).to.not.be.undefined;
			const onNewPrimary = harness.stores.get(bytesKey(newPrimary))!.getByParticipant(s.topicId, s.participantId);
			expect(onNewPrimary, 'new primary holds the record').to.not.be.undefined;
		}
	});

	it('a member dual-serves a moved record until it receives the ack', async () => {
		// Find a participant whose primary moves between epoch-1 and epoch-2.
		const epoch1 = bytes('epoch-1', 32);
		const epoch2 = bytes('epoch-2', 32);
		const t = topic('H');
		let chosen: Uint8Array | undefined;
		let oldPrimary: Uint8Array | undefined;
		let newPrimary: Uint8Array | undefined;
		for (let i = 0; i < 500 && chosen === undefined; i++) {
			const p = bytes(`dual-${i}`);
			const a = slots.assignSlots(p, epoch1, members).primary;
			const b = slots.assignSlots(p, epoch2, members).primary;
			if (!bytesEqual(a, b)) {
				chosen = p; oldPrimary = a; newPrimary = b;
			}
		}
		expect(chosen, 'found a participant whose primary moves').to.not.be.undefined;

		const harness = new HandoffHarness(members, slots);
		const rec = harness.seed({ topicId: t, participantId: chosen!, tier: 1, attachedAt: 1, lastPing: 1, ttl: DEFAULT_TTL_MS });
		harness.setEpoch(epoch2);

		const oldHandoff = harness.handoffs.get(bytesKey(oldPrimary!))!;
		const newHandoff = harness.handoffs.get(bytesKey(newPrimary!))!;
		const ref: RecordRef = { topicId: rec.topicId, participantId: rec.participantId };

		// After start(), the old primary marks the record dual-serving — still answering renews.
		harness.startAll();
		expect(oldHandoff.isServing(ref.topicId, ref.participantId), 'old primary keeps serving pre-ack').to.be.true;
		expect(newHandoff.isServing(ref.topicId, ref.participantId), 'new primary already computes itself as serving').to.be.true;

		// Drain: the new primary pulls and acks; the old primary then stops dual-serving.
		await harness.drainInbox();
		expect(oldHandoff.isServing(ref.topicId, ref.participantId), 'old primary stops serving after ack').to.be.false;
	});

	it('is a no-op for a record whose primary does not move', async () => {
		const harness = new HandoffHarness(members, slots);
		const t = topic('H');
		// Same epoch before and after → no record should move; seed and "rotate" to the same epoch.
		const rec = harness.seed({ topicId: t, participantId: bytes('static'), tier: 1, attachedAt: 1, lastPing: 1, ttl: DEFAULT_TTL_MS });
		const holderBefore = harness.holderOf(rec)!;
		harness.startAll();
		await harness.drainInbox();
		const holderAfter = harness.holderOf(rec)!;
		expect(bytesEqual(holderBefore, holderAfter), 'holder unchanged').to.be.true;
	});
});
