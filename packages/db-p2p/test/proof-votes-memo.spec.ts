import { expect } from 'chai';
import { VerdictMemo } from '../src/cluster/proof-votes-memo.js';

type Verdict = { ok: boolean };

/** A computation that counts its runs per key and answers `verdict`. */
const counting = () => {
	const runs = new Map<string, number>();
	const compute = (key: string, verdict: Verdict) => async (): Promise<Verdict> => {
		runs.set(key, (runs.get(key) ?? 0) + 1);
		return verdict;
	};
	return { runs, compute };
};

const retainPasses = (verdict: Verdict): boolean => verdict.ok;

describe('VerdictMemo', () => {
	it('computes a key once across concurrent and repeated calls while the verdict is retained, and again when it is not', async () => {
		const memo = new VerdictMemo<Verdict>();
		const { runs, compute } = counting();

		const concurrent = await Promise.all(
			[1, 2, 3].map(() => memo.judge('pass', compute('pass', { ok: true }), retainPasses)));
		expect(concurrent).to.deep.equal([{ ok: true }, { ok: true }, { ok: true }]);
		await memo.judge('pass', compute('pass', { ok: true }), retainPasses);
		expect(runs.get('pass')).to.equal(1);

		const failures = await Promise.all(
			[1, 2].map(() => memo.judge('fail', compute('fail', { ok: false }), retainPasses)));
		expect(failures).to.deep.equal([{ ok: false }, { ok: false }]);
		expect(runs.get('fail'), 'concurrent calls share one computation even when it is not retained').to.equal(1);
		await memo.judge('fail', compute('fail', { ok: false }), retainPasses);
		expect(runs.get('fail'), 'a verdict not retained is computed again').to.equal(2);
	});

	it('evicts the least recently used key past the character budget, a hit refreshing it, and never retains a key over the entry cap', async () => {
		// Keys of 4 characters against a budget of 8: two fit, a third evicts one.
		const memo = new VerdictMemo<Verdict>({ totalChars: 8, entryChars: 6 });
		const { runs, compute } = counting();
		const judge = (key: string) => memo.judge(key, compute(key, { ok: true }), retainPasses);

		await judge('aaaa');
		await judge('bbbb');
		await judge('aaaa');            // a hit: 'bbbb' is now the least recently used
		await judge('cccc');            // evicts 'bbbb'
		await judge('aaaa');
		await judge('bbbb');            // computed again, evicting 'cccc'
		expect([runs.get('aaaa'), runs.get('bbbb'), runs.get('cccc')]).to.deep.equal([1, 2, 1]);

		await judge('long-key');        // 8 characters, over the 6-character entry cap
		await judge('long-key');
		expect(runs.get('long-key')).to.equal(2);
		await judge('aaaa');
		await judge('bbbb');
		expect([runs.get('aaaa'), runs.get('bbbb')], 'an unretained key evicts nothing').to.deep.equal([1, 2]);
	});
});
