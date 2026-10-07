/**
 * Ticket: slot-hold-for-an-aged-writer (GitHub #18's shape).
 *
 * One diary, two writers. A FAST writer appends sequentially with a short pause between writes. A
 * SLOW writer appends once a second through a transactor whose every repo call — `get`, `pend`,
 * `commit`, `cancel` — is delayed by a fixed amount, which models a phone over a relay whose event
 * loop is also being starved. The delay is the only difference between them.
 *
 * Without the slot hold the slow writer's read-to-pend window (several sequential round trips) is
 * longer than the fast writer's commit interval, so nearly every slow pend is refused as stale and
 * the slow writer can exhaust its retry budget: at this delay the plan-stage measurement saw 23 of 26
 * slow pends refused stale, one write giving up after 22.8 s, and a 36 s outage over a 40 s run. The
 * CONTROL arm below reproduces that with the hold disabled; it burns its whole budget by
 * construction, so it runs only under `RUN_LONG_TESTS_CONTROL=1`:
 *
 *   PowerShell: $env:RUN_LONG_TESTS_CONTROL=1; yarn workspace @optimystic/db-p2p test --grep "aged writer"
 *   bash:        RUN_LONG_TESTS_CONTROL=1 yarn workspace @optimystic/db-p2p test --grep "aged writer"
 *
 * With the hold on, each member that has refused the slow writer `SlotHoldAfterLosses` times holds
 * the next slot of the log tail for it, the fast writer is answered `held` until the slow one lands,
 * and the slow writer lands on its next attempt: every slow write commits, within
 * `SlotHoldAfterLosses + 2` pends (one more than the threshold, plus one for a rival already past its
 * promise round when the hold was granted). The fast writer's commit count is asserted too, against
 * the pace it set alone on the same machine moments earlier, so the hold's honest cost — the holder's
 * own read-to-pend window per episode — is a measured share rather than a constant that is only right
 * on the machine it was measured on.
 */

import { expect } from 'chai';
import { Diary, SlotHoldAfterLosses, SyncRetryExhaustedError, type IRepo, type ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor } from '../src/testing/mesh-harness.js';
import { captureLog } from './support/capture-log.js';

interface Entry { who: string; n: number }

/** The slow writer's delay on every repo call: the row of the plan-stage table where it starved. */
const SLOW_CALL_MS = 120;
/** The fast writer's pause between appends, and the slow writer's. */
const FAST_PAUSE_MS = 200;
const SLOW_PAUSE_MS = 1000;
/** How long the fast writer runs ALONE first, to measure this machine's uncontended pace. */
const PACE_MS = 5000;
/** The share of its uncontended pace the fast writer must keep under contention. Measured at about
 *  three quarters (66 to 73 commits in 20 s against 68 in 15 s alone); half separates the hold's honest
 *  cost from a hold that idles the tail — a holder that never consumed would cost the whole window per
 *  grant, which at this shape is most of the run — with room for a slower machine. */
const KEPT_PACE = 0.5;
const GRANTED = 'cluster-member:slot-hold-granted';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** `repo` with every call delayed `ms`, counting pends per action id (one action id is one write's
 *  whole retry cycle, so the count per id is that write's attempts). */
const delayedBy = (ms: number, pends: Map<string, number>) => (inner: IRepo): IRepo => {
	const after = async <T>(call: () => Promise<T>): Promise<T> => {
		await sleep(ms);
		return await call();
	};
	return {
		get: (gets, options) => after(() => inner.get(gets, options)),
		pend: (request, options) => {
			pends.set(request.actionId, (pends.get(request.actionId) ?? 0) + 1);
			return after(() => inner.pend(request, options));
		},
		cancel: (actionRef, options) => after(() => inner.cancel(actionRef, options)),
		commit: (request, options) => after(() => inner.commit(request, options))
	};
};

interface SlowWrite { elapsedMs: number; error?: unknown }

interface Run {
	/** The fast writer's commits in `PACE_MS` alone, before the slow writer started. */
	fastCommitsAlone: number;
	/** The fast writer's commits under contention, over the run's `durationMs`. */
	fastCommits: number;
	slowWrites: SlowWrite[];
	/** Pends per slow action id. */
	pends: Map<string, number>;
	/** Every `cluster-member` line the three members logged during the run. */
	captured: unknown[][];
}

/** Both writers against one diary on a fresh three-node mesh, for `durationMs`. */
const runContention = async (durationMs: number, slotHoldWindowMs?: number): Promise<Run> => {
	const mesh = await createMesh(3, {
		responsibilityK: 3,
		clusterSize: 3,
		...(slotHoldWindowMs === undefined ? {} : { clusterPolicy: { slotHoldWindowMs } })
	});
	const fast: ITransactor = buildNetworkTransactor(mesh);
	const pends = new Map<string, number>();
	const slow: ITransactor = buildNetworkTransactor(mesh, { wrapRepo: delayedBy(SLOW_CALL_MS, pends) });

	const diaryId = 'aged-writer/diary';
	const fastDiary = await Diary.createOrOpen<Entry>(fast, diaryId);
	// Commit the diary before the slow writer opens it, so both write to one header.
	await fastDiary.append({ who: 'seed', n: 0 });
	const slowDiary = await Diary.createOrOpen<Entry>(slow, diaryId);

	/** The fast writer appending on its own cadence until `deadline`; resolves to its commit count. */
	const fastUntil = async (deadline: number): Promise<number> => {
		let commits = 0;
		for (let n = 1; Date.now() < deadline; n++) {
			await fastDiary.append({ who: 'fast', n });
			commits++;
			await sleep(FAST_PAUSE_MS);
		}
		return commits;
	};
	// The fast writer alone first: its pace on THIS machine is what the contended count is judged
	// against, since a constant floor is right only for the machine it was measured on.
	const fastCommitsAlone = await fastUntil(Date.now() + PACE_MS);

	let fastCommits = 0;
	const slowWrites: SlowWrite[] = [];
	const captured = await captureLog('cluster-member', async () => {
		const deadline = Date.now() + durationMs;
		const fastLoop = fastUntil(deadline).then(commits => { fastCommits = commits; });
		const slowLoop = (async (): Promise<void> => {
			for (let n = 1; Date.now() < deadline; n++) {
				const startedAt = Date.now();
				try {
					await slowDiary.append({ who: 'slow', n });
					slowWrites.push({ elapsedMs: Date.now() - startedAt });
				} catch (error) {
					slowWrites.push({ elapsedMs: Date.now() - startedAt, error });
				}
				await sleep(SLOW_PAUSE_MS);
			}
		})();
		await Promise.all([fastLoop, slowLoop]);
	});
	return { fastCommitsAlone, fastCommits, slowWrites, pends, captured };
};

/** The fewest contended fast commits that keep {@link KEPT_PACE} of the pace measured alone. */
const keptPaceFloor = (run: Run, durationMs: number): number =>
	Math.floor(run.fastCommitsAlone * (durationMs / PACE_MS) * KEPT_PACE);

const describeRun = (run: Run): string => {
	const failed = run.slowWrites.filter(w => w.error !== undefined).length;
	const longest = Math.max(0, ...run.slowWrites.map(w => w.elapsedMs));
	const mostPends = Math.max(0, ...run.pends.values());
	const holds = run.captured.filter(args => typeof args[0] === 'string' && args[0].includes(GRANTED)).length;
	return `fast commits ${run.fastCommits} (${run.fastCommitsAlone} alone in ${PACE_MS} ms), slow writes ${run.slowWrites.length} (${failed} failed, longest ${longest} ms, most pends for one write ${mostPends}), holds granted ${holds}`;
};

describe('An aged writer behind a stream of quicker ones is held a slot', function () {
	it('lands every slow write within SlotHoldAfterLosses + 2 pends while the fast writer keeps its throughput', async function () {
		this.timeout(60_000);
		const run = await runContention(20_000);
		const summary = describeRun(run);

		const failures = run.slowWrites.filter(w => w.error !== undefined);
		expect(failures.map(w => String(w.error)), `every slow write must land (${summary})`).to.deep.equal([]);
		expect(run.slowWrites.length, `the slow writer must have written more than once (${summary})`).to.be.at.least(3);
		for (const [actionId, count] of run.pends) {
			expect(count, `write ${actionId} pended ${count} times (${summary})`).to.be.at.most(SlotHoldAfterLosses + 2);
		}
		// The honest cost: each hold idles the tail for the slow writer's own read-to-pend window.
		expect(run.fastCommits, `the fast writer must keep ${KEPT_PACE} of its uncontended pace (${summary})`)
			.to.be.at.least(keptPaceFloor(run, 20_000));
		// Without this a lucky phase alignment would pass the assertions above with no hold at all.
		expect(run.captured.filter(args => typeof args[0] === 'string' && args[0].includes(GRANTED)).length,
			`at least one hold must have been granted (${summary})`).to.be.at.least(1);
	});

	it('CONTROL: with the hold disabled the same shape starves the slow writer (RUN_LONG_TESTS_CONTROL=1)', async function () {
		if (process.env.RUN_LONG_TESTS_CONTROL !== '1') this.skip();
		this.timeout(120_000);
		const run = await runContention(40_000, 0);
		const summary = describeRun(run);

		expect(run.captured.filter(args => typeof args[0] === 'string' && args[0].includes(GRANTED)).length,
			`disabled means no grant (${summary})`).to.equal(0);
		const starved = run.slowWrites.some(w => w.error instanceof SyncRetryExhaustedError || w.elapsedMs > 10_000);
		expect(starved, `at least one slow write must have given up or taken over 10 s (${summary})`).to.equal(true);
	});
});
