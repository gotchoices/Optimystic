import { expect } from 'chai';
import { ClusterMember } from '../src/cluster/cluster-repo.js';

// Browsers and React Native (Hermes) return a number from `setTimeout`/`setInterval`, which has no
// `unref`. Every node builds a `ClusterMember`, whose constructor arms two intervals, so an unguarded
// `.unref()` there stopped any node from starting off Node (GitHub issue #28).

const dummy = {} as any;

type TimerFn = (handler: () => void, ms?: number) => unknown;

/** Swap a global timer for one that returns a number, as browsers and Hermes do. */
function numericTimer(real: TimerFn, numbersToReal: Map<number, unknown>): TimerFn {
	let next = 1;
	return (handler, ms) => {
		const id = next++;
		numbersToReal.set(id, real(handler, ms));
		return id;
	};
}

describe('numeric timer handles (browser / React Native)', () => {
	const realSetTimeout = globalThis.setTimeout;
	const realSetInterval = globalThis.setInterval;
	const realClearTimeout = globalThis.clearTimeout;
	const realClearInterval = globalThis.clearInterval;
	const timeouts = new Map<number, unknown>();
	const intervals = new Map<number, unknown>();

	beforeEach(() => {
		globalThis.setTimeout = numericTimer(realSetTimeout as unknown as TimerFn, timeouts) as typeof setTimeout;
		globalThis.setInterval = numericTimer(realSetInterval as unknown as TimerFn, intervals) as typeof setInterval;
		globalThis.clearTimeout = ((id: number) => realClearTimeout(timeouts.get(id) as ReturnType<typeof setTimeout>)) as typeof clearTimeout;
		globalThis.clearInterval = ((id: number) => realClearInterval(intervals.get(id) as ReturnType<typeof setInterval>)) as typeof clearInterval;
	});

	afterEach(() => {
		globalThis.setTimeout = realSetTimeout;
		globalThis.setInterval = realSetInterval;
		globalThis.clearTimeout = realClearTimeout;
		globalThis.clearInterval = realClearInterval;
		for (const handle of timeouts.values()) realClearTimeout(handle as ReturnType<typeof setTimeout>);
		for (const handle of intervals.values()) realClearInterval(handle as ReturnType<typeof setInterval>);
		timeouts.clear();
		intervals.clear();
	});

	it('constructs a ClusterMember when timers return numbers', () => {
		let member: ClusterMember | undefined;
		expect(() => { member = new ClusterMember(dummy, dummy, dummy, dummy); }).to.not.throw();
		member?.dispose();
	});
});
