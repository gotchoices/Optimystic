import { expect } from 'chai';
import { createDedupeWindow, createReplayBuffer, type NotificationV1 } from '../../src/reactivity/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

const note = (revision: number): NotificationV1 => ({
	v: 1,
	collectionId: bytesToB64url(new Uint8Array([1])),
	tailId: bytesToB64url(new Uint8Array([2])),
	revision,
	digest: bytesToB64url(new Uint8Array([revision & 0xff])),
	timestamp: 1000 + revision,
	sig: bytesToB64url(new Uint8Array([revision & 0xff])),
	signers: [bytesToB64url(new Uint8Array([8]))],
});

describe('reactivity dedupe window', () => {
	it('forwards a fresh key and drops an exact repeat', () => {
		const w = createDedupeWindow(64);
		expect(w.observe(10, 'sig')).to.equal('forward');
		expect(w.observe(10, 'sig')).to.equal('duplicate');
	});

	it('admits an earlier-revision retransmit with a distinct (revision, sigDigest)', () => {
		const w = createDedupeWindow(64);
		w.observe(20, 'a');
		expect(w.observe(15, 'b')).to.equal('forward'); // recovery: gap-closing retransmit
	});

	it('slides: a key older than the window is evicted and would re-forward', () => {
		const w = createDedupeWindow(3); // retains revisions [highest-2, highest]
		w.observe(1, 'a');
		w.observe(2, 'b');
		w.observe(3, 'c');
		w.observe(4, 'd'); // window now [2,4]; revision 1 evicted
		expect(w.has(1, 'a')).to.equal(false);
		expect(w.has(2, 'b')).to.equal(true);
		expect(w.observe(1, 'a')).to.equal('forward'); // re-admitted (subscriber-side dedupe still guards)
	});

	it('tracks the highest revision observed', () => {
		const w = createDedupeWindow(64);
		w.observe(5, 'a');
		w.observe(12, 'b');
		w.observe(7, 'c');
		expect(w.highestRevision).to.equal(12);
	});

	it('merges another member\'s seen set within the window', () => {
		const a = createDedupeWindow(64);
		const b = createDedupeWindow(64);
		a.observe(10, 'x');
		b.merge(a.serialize());
		expect(b.has(10, 'x')).to.equal(true);
		expect(b.observe(10, 'x')).to.equal('duplicate');
	});
});

describe('reactivity replay buffer', () => {
	it('retains entries keyed by revision and returns a range', () => {
		const buf = createReplayBuffer(256);
		for (let rev = 10; rev <= 15; rev++) {
			buf.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		}
		expect(buf.range(11, 13).map((e) => e.revision)).to.deep.equal([11, 12, 13]);
		expect(buf.get(12)?.payload.revision).to.equal(12);
		expect(buf.lowRevision).to.equal(10);
		expect(buf.highRevision).to.equal(15);
	});

	it('replaces (does not duplicate) a retransmit at the same revision', () => {
		const buf = createReplayBuffer(256);
		buf.append({ revision: 10, payload: note(10), receivedAt: 1000 });
		buf.append({ revision: 10, payload: note(10), receivedAt: 2000 });
		expect(buf.size).to.equal(1);
		expect(buf.get(10)?.receivedAt).to.equal(2000);
	});

	it('evicts the lowest revision on overflow', () => {
		const buf = createReplayBuffer(3);
		for (let rev = 1; rev <= 5; rev++) {
			buf.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		}
		expect(buf.size).to.equal(3);
		expect(buf.entries().map((e) => e.revision)).to.deep.equal([3, 4, 5]);
	});

	it('merges a peer buffer, freshest receivedAt winning a per-revision tie', () => {
		const a = createReplayBuffer(256);
		const b = createReplayBuffer(256);
		a.append({ revision: 10, payload: note(10), receivedAt: 1000 });
		b.append({ revision: 10, payload: note(10), receivedAt: 2000 });
		b.append({ revision: 11, payload: note(11), receivedAt: 2100 });
		a.merge(b.serialize());
		expect(a.get(10)?.receivedAt).to.equal(2000);
		expect(a.get(11)?.revision).to.equal(11);
	});
});
