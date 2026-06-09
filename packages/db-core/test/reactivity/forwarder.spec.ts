import { expect } from 'chai';
import {
	createReactivityForwarder,
	PushState,
	notificationDedupeKey,
	type NotificationV1,
	type NotificationVerifier,
} from '../../src/reactivity/index.js';
import type { VerifyResult } from '../../src/cohort-topic/membership/verifier.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

const b = (n: number): string => bytesToB64url(new Uint8Array([n]));

function makeNotification(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: b(1),
		tailId: b(2),
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [b(8)],
		...over,
	};
}

/** A verifier whose verdict is fixed (or scripted) — decouples forwarder logic from real crypto. */
class FakeVerifier implements NotificationVerifier {
	calls = 0;
	constructor(private readonly verdict: VerifyResult | ((n: NotificationV1) => VerifyResult) = 'verified') {}
	verify(n: NotificationV1): Promise<VerifyResult> {
		this.calls++;
		return Promise.resolve(typeof this.verdict === 'function' ? this.verdict(n) : this.verdict);
	}
}

const newState = (): PushState => new PushState({ collectionId: b(1), topicId: b(3), tailIdAtJoin: b(2) });

describe('reactivity forwarder', () => {
	it('verifies, dedupes, appends, and decides to forward a fresh notification', async () => {
		const state = newState();
		const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('verified') });
		const decision = await fwd.receive(makeNotification(10), 1000);
		expect(decision).to.equal('forward');
		expect(state.lastRevision).to.equal(10);
		expect(state.replayBuffer.get(10)?.payload.revision).to.equal(10);
	});

	it('drops a duplicate (same revision + sigDigest) silently without re-buffering', async () => {
		const state = newState();
		const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('verified') });
		const n = makeNotification(10);
		expect(await fwd.receive(n, 1000)).to.equal('forward');
		expect(await fwd.receive(n, 1001)).to.equal('duplicate');
		expect(state.replayBuffer.size).to.equal(1);
	});

	it('admits a same-revision retransmit that carries a distinct signature (partition merge)', async () => {
		const state = newState();
		const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('verified') });
		await fwd.receive(makeNotification(10, { sig: bytesToB64url(new Uint8Array([1])) }), 1000);
		const alt = makeNotification(10, { sig: bytesToB64url(new Uint8Array([2])) });
		expect(await fwd.receive(alt, 1001)).to.equal('forward');
	});

	it('drops an unverifiable notification before touching dedupe or the buffer', async () => {
		const state = newState();
		const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('untrusted') });
		expect(await fwd.receive(makeNotification(10), 1000)).to.equal('untrusted');
		expect(state.replayBuffer.size).to.equal(0);
		expect(state.dedupe.size).to.equal(0);
		expect(state.lastRevision).to.equal(-1);
	});

	it('exposes a stable dedupe key for diagnostics', () => {
		const n = makeNotification(10);
		expect(notificationDedupeKey(n)).to.equal(notificationDedupeKey(n));
	});

	it('any cohort member (not just the primary) can serve a replay after gossip', async () => {
		// Primary receives a run of notifications...
		const primary = newState();
		const fwd = createReactivityForwarder({ state: primary, verifier: new FakeVerifier('verified') });
		for (let rev = 10; rev <= 14; rev++) {
			await fwd.receive(makeNotification(rev), 1000 + rev);
		}
		// ...and gossips its push state to a backup member, who can then serve the same replay range.
		const backup = newState();
		backup.mergeGossip(primary.serializeGossip());
		expect(backup.replayBuffer.range(10, 14).map((e) => e.revision)).to.deep.equal([10, 11, 12, 13, 14]);
		expect(backup.replayBuffer.get(12)?.payload.revision).to.equal(12);
		expect(backup.lastRevision).to.equal(14);
		// The backup has also converged on the dedupe set, so it won't re-forward a seen revision.
		const backupFwd = createReactivityForwarder({ state: backup, verifier: new FakeVerifier('verified') });
		expect(await backupFwd.receive(makeNotification(12), 2000)).to.equal('duplicate');
	});

	it('evicts the oldest revision when the replay ring overflows capacity W', async () => {
		const state = new PushState({ collectionId: b(1), topicId: b(3), tailIdAtJoin: b(2), w: 3 });
		const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('verified') });
		for (let rev = 1; rev <= 5; rev++) {
			await fwd.receive(makeNotification(rev), 1000 + rev);
		}
		expect(state.replayBuffer.size).to.equal(3);
		expect(state.replayBuffer.lowRevision).to.equal(3);
		expect(state.replayBuffer.highRevision).to.equal(5);
		expect(state.replayBuffer.get(1)).to.equal(undefined);
	});
});
