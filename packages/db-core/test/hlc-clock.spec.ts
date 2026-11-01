/**
 * The hybrid logical clock's construction, over a fake local clock and an in-memory store: what it
 * issues as the local clock and observed HLCs move, where it resumes after a restart, and when it
 * saves its mark (docs/crdt-sync.md §HLC Generation and Causal Tracking).
 */

import { expect } from 'chai';
import { HlcClock, type Hlc, type HlcClockStore } from '../src/index.js';

class MemoryClockStore implements HlcClockStore {
	readonly saved: Hlc[] = [];
	constructor(private readonly stored?: Hlc) {}
	async load(): Promise<Hlc | undefined> { return this.stored; }
	async save(hlc: Hlc): Promise<void> { this.saved.push(hlc); }
}

/** Advance the local clock to `at`, then issue an HLC or observe one. */
type Step = { readonly at: number } & ({ readonly now: true } | { readonly observe: Hlc });

type Case = {
	readonly name: string;
	/** The mark the store holds from before a restart, if any. */
	readonly stored?: Hlc;
	readonly steps: readonly Step[];
	/** `[wallMs, logical]` of each `now` step's HLC, in order. */
	readonly issued: readonly (readonly [number, number])[];
	/** `wallMs` of each mark handed to the store, in order; unchecked when absent. */
	readonly saved?: readonly number[];
};

const self = 'self';
const peer = (wallMs: number, logical: number): Hlc => ({ wallMs, logical, nodeId: 'peer' });

const cases: readonly Case[] = [
	{
		name: 'the local clock ahead of the mark wins, logical 0',
		steps: [{ at: 1_000, now: true }, { at: 2_000, now: true }],
		issued: [[1_000, 0], [2_000, 0]]
	},
	{
		name: 'an observed HLC ahead of the local clock is issued above',
		steps: [{ at: 1_000, observe: peer(5_000, 3) }, { at: 1_001, now: true }],
		issued: [[5_000, 4]]
	},
	{
		name: 'two issues inside one millisecond differ by logical',
		steps: [{ at: 1_000, now: true }, { at: 1_000, now: true }],
		issued: [[1_000, 0], [1_000, 1]]
	},
	{
		name: 'an observed logical count at the top of the safe-integer range carries into wallMs',
		steps: [{ at: 1_000, observe: peer(5_000, Number.MAX_SAFE_INTEGER) }, { at: 1_000, now: true }, { at: 1_000, now: true }],
		issued: [[5_001, 0], [5_001, 1]]
	},
	{
		name: 'a local clock stepped backwards never lowers wallMs',
		steps: [{ at: 1_000, now: true }, { at: 400, now: true }],
		issued: [[1_000, 0], [1_000, 1]]
	},
	{
		name: 'a restart with the stored mark above the local clock resumes at the floor',
		stored: { wallMs: 50_000, logical: 7, nodeId: self },
		steps: [{ at: 20_000, now: true }],
		issued: [[60_000, 1]]
	},
	{
		name: 'a restart with the stored mark far below the local clock lets the local clock win',
		stored: { wallMs: 50_000, logical: 7, nodeId: self },
		steps: [{ at: 90_000, now: true }],
		issued: [[90_000, 0]]
	},
	{
		name: 'ordinary ticking saves at most once per interval; a jump saves at once',
		stored: { wallMs: 0, logical: 0, nodeId: self },
		steps: [
			{ at: 11_000, now: true },
			{ at: 11_500, now: true },
			{ at: 11_999, now: true },
			{ at: 12_000, now: true },
			{ at: 12_100, observe: peer(90_000, 0) },
			{ at: 12_200, now: true }
		],
		issued: [[11_000, 0], [11_500, 0], [11_999, 0], [12_000, 0], [90_000, 1]],
		saved: [10_000, 11_000, 12_000, 90_000]
	}
];

describe('HlcClock', () => {
	for (const testCase of cases) {
		it(testCase.name, async () => {
			let localMs = 0;
			const store = new MemoryClockStore(testCase.stored);
			const clock = await HlcClock.start({ nodeId: self, localClock: () => localMs, store });
			const issued: Hlc[] = [];
			for (const step of testCase.steps) {
				localMs = step.at;
				if ('now' in step) issued.push(clock.now());
				else clock.observe(step.observe);
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			expect(issued.map(hlc => [hlc.wallMs, hlc.logical])).to.deep.equal(testCase.issued);
			expect(issued.every(hlc => hlc.nodeId === self)).to.equal(true);
			if (testCase.saved) expect(store.saved.map(hlc => hlc.wallMs)).to.deep.equal(testCase.saved);
		});
	}
});
