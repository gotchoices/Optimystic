import { expect } from 'chai';
import { Metrics, summarize, serializeTags } from '../src/metrics.js';

describe('Metrics — counters', () => {
	it('accumulates by name and tag set, independent of tag insertion order', () => {
		const m = new Metrics();
		m.counter('rpc', 1, { tier: 0 });
		m.counter('rpc', 2, { tier: 0 });
		m.counter('rpc', 5, { tier: 1 });
		m.counter('rpc'); // untagged default +1
		expect(m.counterValue('rpc', { tier: 0 })).to.equal(3);
		expect(m.counterValue('rpc', { tier: 1 })).to.equal(5);
		expect(m.counterValue('rpc')).to.equal(1);
		// Tag order does not split the cell.
		m.counter('load', 1, { a: 1, b: 2 });
		m.counter('load', 1, { b: 2, a: 1 });
		expect(m.counterValue('load', { a: 1, b: 2 })).to.equal(2);
	});

	it('returns 0 for an unknown counter', () => {
		expect(new Metrics().counterValue('nope')).to.equal(0);
	});
});

describe('Metrics — histograms', () => {
	it('summarizes values with nearest-rank percentiles', () => {
		const m = new Metrics();
		for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			m.histogram('hops', v);
		}
		const stats = m.histogramStats('hops');
		expect(stats).to.not.equal(undefined);
		expect(stats!.count).to.equal(10);
		expect(stats!.min).to.equal(1);
		expect(stats!.max).to.equal(10);
		expect(stats!.mean).to.equal(5.5);
		expect(stats!.p50).to.equal(5);
		expect(stats!.p95).to.equal(10);
		expect(m.percentile('hops', 100)).to.equal(10);
	});

	it('exposes an empirical CDF with cumulative fractions', () => {
		const m = new Metrics();
		for (const v of [1, 1, 2, 3]) {
			m.histogram('x', v);
		}
		const cdf = m.cdf('x');
		expect(cdf).to.deep.equal([
			{ value: 1, cumulativeFraction: 0.5 },
			{ value: 2, cumulativeFraction: 0.75 },
			{ value: 3, cumulativeFraction: 1 }
		]);
	});

	it('returns undefined stats / empty cdf for an empty histogram', () => {
		const m = new Metrics();
		expect(m.histogramStats('absent')).to.equal(undefined);
		expect(m.cdf('absent')).to.deep.equal([]);
		expect(m.percentile('absent', 50)).to.equal(0);
	});

	it('rejects an out-of-range percentile', () => {
		expect(() => new Metrics().percentile('x', 101)).to.throw(RangeError);
	});
});

describe('Metrics — timelines', () => {
	it('records (t, value) points in order', () => {
		const m = new Metrics();
		m.timeline('depth', 0, 0);
		m.timeline('depth', 1000, 1);
		m.timeline('depth', 2000, 2);
		expect(m.timelineOf('depth')).to.deep.equal([
			{ t: 0, value: 0 },
			{ t: 1000, value: 1 },
			{ t: 2000, value: 2 }
		]);
	});
});

describe('Metrics — EventSink adapter', () => {
	it('folds the SimEvent stream into per-kind, per-tier counters', () => {
		const m = new Metrics();
		m.record({ kind: 'Promoted', topicId: 't', fromTier: 0, toTier: 1, at: 10 });
		m.record({ kind: 'NoState', topicId: 't', tier: 2, at: 11 });
		m.record({ kind: 'NoState', topicId: 't', tier: 2, at: 12 });
		m.record({ kind: 'Evicted', topicId: 't', participantId: 'p', at: 13 });
		expect(m.counterValue('event.Promoted', { tier: 0 })).to.equal(1);
		expect(m.counterValue('event.NoState', { tier: 2 })).to.equal(2);
		expect(m.counterValue('event.Evicted')).to.equal(1);
	});
});

describe('Metrics — export', () => {
	it('exports parseable JSON with counters, histogram summaries, and timelines', () => {
		const m = new Metrics();
		m.counter('c', 3, { tier: 0 });
		m.histogram('h', 5);
		m.histogram('h', 15);
		m.timeline('tl', 100, 7);
		const parsed = JSON.parse(m.exportJson()) as {
			counters: { name: string; value: number }[];
			histograms: { name: string; count: number; values: number[] }[];
			timelines: { name: string; points: { t: number; value: number }[] }[];
		};
		expect(parsed.counters).to.have.lengthOf(1);
		expect(parsed.counters[0]!.value).to.equal(3);
		expect(parsed.histograms[0]!.count).to.equal(2);
		expect(parsed.histograms[0]!.values).to.deep.equal([5, 15]);
		expect(parsed.timelines[0]!.points).to.deep.equal([{ t: 100, value: 7 }]);
	});

	it('exports CSV with a header and RFC-4180-quoted multi-tag cells', () => {
		const m = new Metrics();
		m.counter('rpc', 4, { a: 1, b: 2 });
		m.histogram('hops', 3);
		m.timeline('tl', 50, 9);
		const csv = m.exportCsv();
		const lines = csv.split('\n');
		expect(lines[0]).to.equal('section,name,tags,stat,value');
		// The multi-tag cell contains a comma → it must be quoted.
		expect(csv).to.contain('"a=1,b=2"');
		expect(csv).to.contain('counter,rpc');
		expect(csv).to.contain('histogram,hops');
		expect(csv).to.contain('timeline,tl,,50,9');
	});
});

describe('summarize / serializeTags helpers', () => {
	it('summarize zeroes an empty list', () => {
		expect(summarize([])).to.deep.equal({ count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 });
	});

	it('serializeTags sorts keys deterministically', () => {
		expect(serializeTags({ b: 2, a: 1 })).to.equal('a=1,b=2');
		expect(serializeTags()).to.equal('');
	});
});
