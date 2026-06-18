import { expect } from 'chai';
import { bytesToB64url, type ReRegistrationPlan } from '@optimystic/db-core';
import { RotationReRegistrationScheduler, type RotationTimerCancel } from '../../src/reactivity/rotation-rereg-scheduler.js';
import type { RotationNotice } from '../../src/reactivity/subscription-manager.js';

// --- fixtures ---------------------------------------------------------------

const TAIL_A = new Uint8Array([0xa1, 0xa2]);
const TOPIC_A = new Uint8Array([0x10, 0x11]);
const TAIL_B = new Uint8Array([0xb1, 0xb2]);
const TOPIC_B = new Uint8Array([0x20, 0x21]);

interface NoticeOver {
	newTailId?: Uint8Array;
	newTopicId?: Uint8Array;
	lastRevision?: number;
	fireAt?: number;
	preAnnounced?: boolean;
}

/** A {@link RotationNotice} for a successor — the shape the manager hands the host's `onRotation` observer. */
function notice(over: NoticeOver = {}): RotationNotice {
	const newTailId = over.newTailId ?? TAIL_A;
	const plan: ReRegistrationPlan = {
		newTailId,
		newTopicId: over.newTopicId ?? TOPIC_A,
		lastRevision: over.lastRevision ?? 100,
		fireAt: over.fireAt ?? 5_000,
	};
	return { newTailId: bytesToB64url(newTailId), preAnnounced: over.preAnnounced ?? false, plan };
}

/**
 * A deterministic timer queue + clock. `now` advances only via {@link advance}; due timers fire in ascending
 * `fireAt` order (so a 0-delay timer fires before a later one), and a cancel handle removes a not-yet-fired
 * timer. Records the `delayMs` of every `setTimer` call so a test can assert the clamp.
 */
class FakeScheduler {
	now = 0;
	readonly delays: number[] = [];
	private nextId = 1;
	private readonly timers = new Map<number, { fireAt: number; fn: () => void }>();

	readonly setTimer = (fn: () => void, delayMs: number): RotationTimerCancel => {
		this.delays.push(delayMs);
		const id = this.nextId++;
		this.timers.set(id, { fireAt: this.now + delayMs, fn });
		return (): void => {
			this.timers.delete(id);
		};
	};

	readonly clock = (): number => this.now;

	get pending(): number {
		return this.timers.size;
	}

	/** Advance the clock by `ms`, firing every timer due at or before the new time (ascending `fireAt`). */
	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let next: { fireAt: number; fn: () => void } | undefined;
			for (const [id, t] of this.timers) {
				if (t.fireAt <= target && (next === undefined || t.fireAt < next.fireAt)) {
					nextId = id;
					next = t;
				}
			}
			if (nextId === undefined || next === undefined) {
				break;
			}
			this.timers.delete(nextId);
			this.now = next.fireAt;
			next.fn();
		}
		this.now = target;
	}
}

/** A recording `reRegister` seam; optionally rejects (or synchronously throws) for chosen successor topics. */
function recorder(opts: { rejectTopics?: Uint8Array[]; throwTopics?: Uint8Array[] } = {}): {
	calls: ReRegistrationPlan[];
	reRegister: (plan: ReRegistrationPlan) => Promise<void>;
} {
	const calls: ReRegistrationPlan[] = [];
	const rejectKeys = new Set((opts.rejectTopics ?? []).map((t) => bytesToB64url(t)));
	const throwKeys = new Set((opts.throwTopics ?? []).map((t) => bytesToB64url(t)));
	return {
		calls,
		reRegister: (plan: ReRegistrationPlan): Promise<void> => {
			calls.push(plan);
			const key = bytesToB64url(plan.newTopicId);
			if (throwKeys.has(key)) {
				throw new Error(`synchronous reRegister failure for ${key}`);
			}
			if (rejectKeys.has(key)) {
				return Promise.reject(new Error(`async reRegister failure for ${key}`));
			}
			return Promise.resolve();
		},
	};
}

/** Flush the microtask + macrotask queue so a swallowed rejection settles before the assertion. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- tests ------------------------------------------------------------------

describe('reactivity / rotation re-registration scheduler', () => {
	it('fires the re-registration exactly at plan.fireAt with the plan', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		const n = notice({ fireAt: 5_000 });
		sched.schedule(n);
		expect(clock.delays, 'delay = fireAt - now (now is 0)').to.deep.equal([5_000]);
		expect(sched.pendingCount).to.equal(1);

		clock.advance(4_999);
		expect(rec.calls, 'not yet — one tick short of fireAt').to.have.length(0);

		clock.advance(1);
		expect(rec.calls, 'fired at fireAt').to.have.length(1);
		expect(rec.calls[0], 'fired with the notice plan').to.equal(n.plan);
		expect(sched.pendingCount, 'pending cleared after fire').to.equal(0);
	});

	it('clamps a past fireAt to a 0 delay (fires immediately, never a negative delay)', () => {
		const clock = new FakeScheduler();
		clock.now = 10_000;
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ fireAt: 5_000 })); // fireAt already 5s in the past
		expect(clock.delays, 'delay clamped to 0, not -5000').to.deep.equal([0]);

		clock.advance(0); // flush the 0-delay timer
		expect(rec.calls, 'past-fireAt fires on the next tick').to.have.length(1);
	});

	it('de-dupes a second notice for an already-scheduled successor (redirect vs pre-announce race)', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTopicId: TOPIC_A, preAnnounced: true })); // pre-announce
		sched.schedule(notice({ newTopicId: TOPIC_A, preAnnounced: false })); // redirect for the SAME successor
		expect(sched.pendingCount, 'only one timer for the successor').to.equal(1);
		expect(clock.delays, 'the duplicate never scheduled a second timer').to.have.length(1);

		clock.advance(5_000);
		expect(rec.calls, 'fired once for the successor').to.have.length(1);
	});

	it('de-dupe survives firing — a notice for an already-fired successor is ignored', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTopicId: TOPIC_A }));
		clock.advance(5_000);
		expect(rec.calls, 'fired once').to.have.length(1);

		sched.schedule(notice({ newTopicId: TOPIC_A })); // re-surfaced after it already fired
		expect(sched.pendingCount, 'no new timer for an already-fired successor').to.equal(0);
		clock.advance(5_000);
		expect(rec.calls, 'still only the one fire').to.have.length(1);
	});

	it('schedules two independent timers for a chained rotation OLD→A→B (both fire)', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTailId: TAIL_A, newTopicId: TOPIC_A, fireAt: 3_000 }));
		sched.schedule(notice({ newTailId: TAIL_B, newTopicId: TOPIC_B, fireAt: 6_000 })); // A→B before A's timer fires
		expect(sched.pendingCount, 'A and B are distinct successors → two timers').to.equal(2);

		clock.advance(10_000);
		expect(rec.calls.map((p) => bytesToB64url(p.newTopicId)), 'both fired (superseded A is not cancelled)').to.deep.equal([
			bytesToB64url(TOPIC_A),
			bytesToB64url(TOPIC_B),
		]);
	});

	it('stop() cancels a pending timer so it never fires', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ fireAt: 5_000 }));
		sched.stop();
		expect(sched.pendingCount, 'stop cleared the pending timer').to.equal(0);
		expect(clock.pending, 'the underlying timer was cancelled').to.equal(0);

		clock.advance(10_000);
		expect(rec.calls, 'no re-register after stop').to.have.length(0);
	});

	it('stop() refuses further scheduling', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.stop();
		sched.schedule(notice({ fireAt: 1_000 }));
		expect(sched.pendingCount, 'scheduling after stop is a no-op').to.equal(0);
		clock.advance(5_000);
		expect(rec.calls).to.have.length(0);
	});

	it('cancel(newTopicId) drops one pending timer, leaving the others', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTailId: TAIL_A, newTopicId: TOPIC_A, fireAt: 4_000 }));
		sched.schedule(notice({ newTailId: TAIL_B, newTopicId: TOPIC_B, fireAt: 4_000 }));
		sched.cancel(TOPIC_A);
		expect(sched.pendingCount, 'only B remains pending').to.equal(1);

		clock.advance(5_000);
		expect(rec.calls.map((p) => bytesToB64url(p.newTopicId)), 'only B fired').to.deep.equal([bytesToB64url(TOPIC_B)]);
	});

	it('cancel() with no argument drops every pending timer', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTopicId: TOPIC_A, fireAt: 4_000 }));
		sched.schedule(notice({ newTopicId: TOPIC_B, fireAt: 4_000 }));
		sched.cancel();
		expect(sched.pendingCount).to.equal(0);
		clock.advance(5_000);
		expect(rec.calls, 'nothing fired').to.have.length(0);
	});

	it('cancel after fire, and cancel twice, are safe no-ops', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTopicId: TOPIC_A }));
		clock.advance(5_000);
		expect(rec.calls, 'fired').to.have.length(1);

		expect(() => sched.cancel(TOPIC_A), 'cancel after fire does not throw').to.not.throw();
		expect(() => sched.cancel(TOPIC_A), 'cancel twice does not throw').to.not.throw();
		expect(() => sched.cancel(TOPIC_B), 'cancel of an unknown successor does not throw').to.not.throw();
		expect(sched.pendingCount).to.equal(0);
	});

	it('cancel(newTopicId) forgets the successor so a fresh notice reschedules it', () => {
		const clock = new FakeScheduler();
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		sched.schedule(notice({ newTopicId: TOPIC_A, fireAt: 5_000 }));
		sched.cancel(TOPIC_A);
		sched.schedule(notice({ newTopicId: TOPIC_A, fireAt: 6_000 })); // re-surfaced after an explicit cancel
		expect(sched.pendingCount, 'a cancelled successor can be rescheduled').to.equal(1);

		clock.advance(10_000);
		expect(rec.calls, 'the rescheduled move fired').to.have.length(1);
	});

	it('isolates a rejecting / synchronously-throwing reRegister — other timers still fire', async () => {
		const clock = new FakeScheduler();
		const rec = recorder({ rejectTopics: [TOPIC_A], throwTopics: [TOPIC_B] });
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister, setTimer: clock.setTimer, now: clock.clock });

		const cleanTopic = new Uint8Array([0x30, 0x31]);
		sched.schedule(notice({ newTopicId: TOPIC_A, fireAt: 1_000 })); // rejects
		sched.schedule(notice({ newTopicId: TOPIC_B, fireAt: 2_000 })); // throws synchronously
		sched.schedule(notice({ newTopicId: cleanTopic, fireAt: 3_000 })); // resolves

		expect(() => clock.advance(5_000), 'a throwing seam never escapes the timer callback').to.not.throw();
		expect(rec.calls.map((p) => bytesToB64url(p.newTopicId)), 'every move was attempted').to.deep.equal([
			bytesToB64url(TOPIC_A),
			bytesToB64url(TOPIC_B),
			bytesToB64url(cleanTopic),
		]);
		await flush(); // a swallowed rejection must not surface as an unhandled rejection
	});

	it('production defaults (unref\'d setTimeout + Date.now) actually fire the move', async () => {
		const rec = recorder();
		const sched = new RotationReRegistrationScheduler({ reRegister: rec.reRegister }); // no injected timer/clock

		sched.schedule(notice({ fireAt: 0 })); // fireAt in the past vs Date.now() → 0-delay timeout
		expect(rec.calls, 'not fired synchronously').to.have.length(0);
		await flush();
		expect(rec.calls, 'the default setTimeout binding fired the move').to.have.length(1);
		sched.stop();
	});
});
