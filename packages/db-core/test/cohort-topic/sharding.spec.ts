import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { createSlotAssigner } from '../../src/cohort-topic/registration/sharding.js';
import { bytesKey } from '../../src/cohort-topic/registration/bytes.js';

/** Deterministic peer id: sha256(label) truncated to 8 bytes — distinct, sortable, no Math.random. */
function peer(label: string): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, 8);
}

const EPOCH = sha256(new TextEncoder().encode('epoch-1')).slice(0, 32);

describe('cohort-topic / sharding', () => {
	const hash = createRingHash();
	const slots = createSlotAssigner(hash);

	function members(n: number): Uint8Array[] {
		return Array.from({ length: n }, (_, i) => peer(`member-${i}`));
	}

	it('is deterministic for a fixed (participantId, cohortEpoch, members)', () => {
		const m = members(16);
		const p = peer('participant-A');
		const a = slots.assignSlots(p, EPOCH, m);
		const b = slots.assignSlots(p, EPOCH, [...m].reverse()); // order of input must not matter
		expect(bytesKey(a.primary)).to.equal(bytesKey(b.primary));
		expect(a.backups.map(bytesKey)).to.deep.equal(b.backups.map(bytesKey));
	});

	it('primary and backups are drawn from ascending member order, wrapping mod k', () => {
		const m = members(16);
		const ordered = [...m].sort((x, y) => bytesKey(x) < bytesKey(y) ? -1 : bytesKey(x) > bytesKey(y) ? 1 : 0);
		const orderedKeys = ordered.map(bytesKey);
		const { primary, backups } = slots.assignSlots(peer('participant-A'), EPOCH, m);
		const slot = orderedKeys.indexOf(bytesKey(primary));
		expect(slot, 'primary is a member').to.be.gte(0);
		expect(backups).to.have.length(2);
		expect(bytesKey(backups[0]!)).to.equal(orderedKeys[(slot + 1) % 16]);
		expect(bytesKey(backups[1]!)).to.equal(orderedKeys[(slot + 2) % 16]);
	});

	it('wraps backups around the end of the order', () => {
		// Search for a participant whose slot lands on the last member, forcing both backups to wrap.
		const m = members(8);
		const ordered = [...m].sort((x, y) => bytesKey(x) < bytesKey(y) ? -1 : bytesKey(x) > bytesKey(y) ? 1 : 0);
		const lastKey = bytesKey(ordered[ordered.length - 1]!);
		let found = false;
		for (let i = 0; i < 500 && !found; i++) {
			const { primary, backups } = slots.assignSlots(peer(`wrap-${i}`), EPOCH, m);
			if (bytesKey(primary) === lastKey) {
				expect(bytesKey(backups[0]!)).to.equal(bytesKey(ordered[0]!));
				expect(bytesKey(backups[1]!)).to.equal(bytesKey(ordered[1]!));
				found = true;
			}
		}
		expect(found, 'a participant slotted onto the last member was found').to.be.true;
	});

	it('caps backups by available members (k=2 → 1 backup, k=1 → 0 backups)', () => {
		const two = members(2);
		const r2 = slots.assignSlots(peer('p'), EPOCH, two);
		expect(r2.backups).to.have.length(1);
		expect(bytesKey(r2.backups[0]!)).to.not.equal(bytesKey(r2.primary));

		const one = members(1);
		const r1 = slots.assignSlots(peer('p'), EPOCH, one);
		expect(r1.backups).to.have.length(0);
		expect(bytesKey(r1.primary)).to.equal(bytesKey(one[0]!));
	});

	it('changing the cohortEpoch can move the slot (membership-rotation precondition)', () => {
		const m = members(16);
		const epoch2 = sha256(new TextEncoder().encode('epoch-2')).slice(0, 32);
		// Over many participants at least one must move when the epoch changes.
		let moved = 0;
		for (let i = 0; i < 64; i++) {
			const p = peer(`mover-${i}`);
			if (bytesKey(slots.assignSlots(p, EPOCH, m).primary) !== bytesKey(slots.assignSlots(p, epoch2, m).primary)) {
				moved++;
			}
		}
		expect(moved, 'epoch change reshuffles some primaries').to.be.greaterThan(0);
	});

	it('shards roughly evenly over many participants', () => {
		const k = 16;
		const m = members(k);
		const counts = new Map<string, number>();
		const N = 16_000;
		for (let i = 0; i < N; i++) {
			const { primary } = slots.assignSlots(peer(`even-${i}`), EPOCH, m);
			const key = bytesKey(primary);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		expect(counts.size, 'every member is used').to.equal(k);
		const mean = N / k;
		for (const [key, c] of counts) {
			// Generous band: each member within ±30% of the mean over 16k draws.
			expect(c, `member ${key} count ${c} near mean ${mean}`).to.be.within(mean * 0.7, mean * 1.3);
		}
	});

	it('rejects an empty cohort', () => {
		expect(() => slots.assignSlots(peer('p'), EPOCH, [])).to.throw(RangeError);
	});
});
