import { expect } from 'chai';
import { SyncDeadlines } from '../src/storage/sync-deadlines.js';
import type { SetTimer } from '../src/storage/write-group.js';

// The bookkeeping a deferring store keeps between its commits and the sync that covers them. The
// file log's own spec (`packages/db-p2p-storage-fs/test/file-write-log.spec.ts`) drives the sync
// step end to end; here are the rules whose branching lives in the helper alone.

/** A clock and a timer the test moves by hand: `armed` holds every timer set and not cancelled, with the time it is due. */
function harness() {
	let clock = 0;
	let armed: { readonly due: number; readonly fn: () => void }[] = [];
	const setTimer: SetTimer = (fn, ms) => {
		const timer = { due: clock + ms, fn };
		armed.push(timer);
		return () => { armed = armed.filter(t => t !== timer); };
	};
	const logged: unknown[][] = [];
	const deadlines = new SyncDeadlines<string>({ onDue: () => undefined, setTimer, now: () => clock, log: (...args) => { logged.push(args); }, subject: 'test' });
	return {
		deadlines,
		logged,
		armedAt: () => armed.map(t => t.due),
		advance: (ms: number) => { clock += ms; },
		defer: (item: string, syncWithinMs: number) => deadlines.defer(item, deadlines.deadlineFor(syncWithinMs)),
	};
}

describe('SyncDeadlines', () => {
	it('a later, longer deadline does not move the timer and a shorter one does; the cover settles in order', async () => {
		const { deadlines, armedAt, defer } = harness();
		const a = defer('A', 5000);
		const b = defer('B', 9000);
		expect(armedAt()).to.deep.equal([5000]);
		const c = defer('C', 1000);
		expect(armedAt()).to.deep.equal([1000]);

		const cover = deadlines.take();
		expect(cover.items).to.deep.equal(['A', 'B', 'C']);
		expect(armedAt()).to.deep.equal([], 'take disarms');
		const settled: string[] = [];
		const watched = ([['A', a], ['B', b], ['C', c]] as const).map(([name, durable]) => durable.then(() => { settled.push(name); }));
		cover.settle();
		await Promise.all(watched);
		expect(settled).to.deep.equal(['A', 'B', 'C']);
	});

	it('an overdue deadline makes the next commit sync', () => {
		const { deadlines, defer, advance } = harness();
		void defer('A', 1000);
		expect(deadlines.mustSyncNow(deadlines.deadlineFor(5000))).to.equal(false);
		advance(1001);
		expect(deadlines.mustSyncNow(deadlines.deadlineFor(5000))).to.equal(true);
	});

	it("says window-overrun once per episode of late syncs, not for the timer's own slop", () => {
		const { deadlines, logged, advance } = harness();
		const syncAfter = (ms: number, owedSince?: (deadline: number) => number) => {
			const deadline = deadlines.deadlineFor(1000)!;
			void deadlines.defer('x', deadline);
			advance(ms);
			deadlines.take(owedSince?.(deadline)).settle();
		};
		syncAfter(1005, deadline => deadline + 5);
		expect(logged, 'a timer that fired late is not the store running late').to.have.length(0);
		syncAfter(1500);
		syncAfter(1500);
		expect(logged, 'one line for the episode').to.have.length(1);
		expect(logged[0]!.slice(1)).to.deep.equal(['test', 500, 1]);
		syncAfter(0);
		syncAfter(1200);
		expect(logged, 'an on-time sync ended the episode').to.have.length(2);
	});
});
