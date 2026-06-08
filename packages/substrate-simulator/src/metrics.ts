import type { VTime } from './types.js';
import type { SimEvent, EventSink } from './topic-events.js';

/**
 * The simulator metrics engine — counters, histograms, and timelines with JSON/CSV export, modeled
 * on FRET's `getDiagnostics` accumulation pattern (`fret-service.ts`: a plain in-memory accumulator
 * read out at the end of a run). It is the aggregation half of `simulator-metrics-and-scenarios`:
 * the scenario runner (`scenarios.ts`) and the scale/sensitivity sweep (`sweep.ts`) drive the model
 * layer and fold every quantitative readout into a `MetricsSink`, then the claim validators read it
 * back. Pure in-memory state, no clock, no randomness — safe to snapshot and export at any point.
 *
 * `Metrics` also implements `EventSink`, so it can be wired directly into the tree / walk / churn /
 * registration models (which already emit the `SimEvent` vocabulary): every event becomes a counter
 * keyed by `event.<kind>` and tagged by tier where the event carries one. That is the "subscribe the
 * engine to the event streams" wiring Phase 1 calls for.
 */

/** A metric tag value — a tier number, topic id, parameter name, etc. */
export type TagValue = string | number;

/** Tag set attached to a counter/histogram sample (e.g. `{ tier: 0, topic: 'C' }`). */
export type Tags = Readonly<Record<string, TagValue>>;

/** Summary statistics derived from a histogram's recorded values. */
export interface HistogramStats {
	readonly count: number;
	readonly min: number;
	readonly max: number;
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
}

/** One sampled `(t, value)` point on a named timeline. */
export interface TimelinePoint {
	readonly t: VTime;
	readonly value: number;
}

/** One point of an empirical CDF: the fraction of recorded values `≤ value`. */
export interface CdfPoint {
	readonly value: number;
	readonly cumulativeFraction: number;
}

/**
 * The metric-collection surface scenarios and sweeps write to (ticket §Metrics engine). A
 * `counter` accumulates a monotone total; a `histogram` records a value for later percentile/CDF
 * readout; a `timeline` records a `(t, value)` point for over-time inspection. `exportJson` /
 * `exportCsv` serialize the whole accumulator for offline analysis.
 */
export interface MetricsSink {
	counter(name: string, by?: number, tags?: Tags): void;
	histogram(name: string, value: number, tags?: Tags): void;
	timeline(name: string, t: VTime, value: number): void;
	exportJson(): string;
	exportCsv(): string;
}

interface CounterCell {
	readonly name: string;
	readonly tags: Tags | undefined;
	value: number;
}

interface HistogramCell {
	readonly name: string;
	readonly tags: Tags | undefined;
	readonly values: number[];
}

/** Stable key for a `(name, tags)` pair: tag keys sorted so order of insertion never matters. */
function cellKey(name: string, tags?: Tags): string {
	return `${name}|${serializeTags(tags)}`;
}

/** Deterministic `k=v,k=v` rendering of a tag set (sorted keys); empty string when absent. */
export function serializeTags(tags?: Tags): string {
	if (!tags) {
		return '';
	}
	return Object.keys(tags)
		.sort()
		.map((k) => `${k}=${tags[k]}`)
		.join(',');
}

/**
 * Nearest-rank `p`-th percentile (0..100) of `values` (must be pre-sorted ascending). Mirrors
 * `walk-metrics.hopPercentile` so histogram percentiles and walk-hop percentiles agree exactly.
 */
function percentileOfSorted(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const rank = Math.ceil((p / 100) * sorted.length);
	const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[idx]!;
}

/** Quote a CSV cell iff it contains a comma, quote, or newline (RFC-4180 doubling). */
function csvCell(value: string): string {
	if (/[",\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export class Metrics implements MetricsSink, EventSink {
	private readonly counters = new Map<string, CounterCell>();
	private readonly histograms = new Map<string, HistogramCell>();
	private readonly timelines = new Map<string, TimelinePoint[]>();

	counter(name: string, by = 1, tags?: Tags): void {
		const key = cellKey(name, tags);
		const cell = this.counters.get(key);
		if (cell) {
			cell.value += by;
		} else {
			this.counters.set(key, { name, tags, value: by });
		}
	}

	histogram(name: string, value: number, tags?: Tags): void {
		const key = cellKey(name, tags);
		const cell = this.histograms.get(key);
		if (cell) {
			cell.values.push(value);
		} else {
			this.histograms.set(key, { name, tags, values: [value] });
		}
	}

	timeline(name: string, t: VTime, value: number): void {
		const points = this.timelines.get(name);
		if (points) {
			points.push({ t, value });
		} else {
			this.timelines.set(name, [{ t, value }]);
		}
	}

	/**
	 * `EventSink` adapter — fold a model event stream into per-kind counters, tagged by tier when the
	 * event carries one. This is how the tree / walk / churn / registration models feed the engine.
	 */
	record(event: SimEvent): void {
		const name = `event.${event.kind}`;
		if (event.kind === 'Promoted') {
			this.counter(name, 1, { tier: event.fromTier });
		} else if ('tier' in event) {
			this.counter(name, 1, { tier: event.tier });
		} else {
			this.counter(name, 1);
		}
	}

	// --- query surface (read by claim validators) ----------------------------

	/** Current total of a counter, or 0 if never incremented. */
	counterValue(name: string, tags?: Tags): number {
		return this.counters.get(cellKey(name, tags))?.value ?? 0;
	}

	/** Sum of every cell sharing `name`, across all tag sets — e.g. promotions across all tiers. */
	counterTotal(name: string): number {
		let total = 0;
		for (const c of this.counters.values()) {
			if (c.name === name) {
				total += c.value;
			}
		}
		return total;
	}

	/** Raw recorded histogram values (a copy), or `[]` if none. */
	histogramValues(name: string, tags?: Tags): number[] {
		return [...(this.histograms.get(cellKey(name, tags))?.values ?? [])];
	}

	/** Summary stats for a histogram, or `undefined` if it has no values. */
	histogramStats(name: string, tags?: Tags): HistogramStats | undefined {
		const cell = this.histograms.get(cellKey(name, tags));
		if (!cell || cell.values.length === 0) {
			return undefined;
		}
		return summarize(cell.values);
	}

	/** Nearest-rank percentile of a histogram; 0 when the histogram is empty. */
	percentile(name: string, p: number, tags?: Tags): number {
		if (p < 0 || p > 100) {
			throw new RangeError(`percentile must be in [0, 100], got ${p}`);
		}
		const values = this.histograms.get(cellKey(name, tags))?.values ?? [];
		return percentileOfSorted([...values].sort((a, b) => a - b), p);
	}

	/** Empirical CDF of a histogram: distinct values ascending with cumulative `≤` fraction. */
	cdf(name: string, tags?: Tags): CdfPoint[] {
		const values = this.histograms.get(cellKey(name, tags))?.values ?? [];
		if (values.length === 0) {
			return [];
		}
		const sorted = [...values].sort((a, b) => a - b);
		const out: CdfPoint[] = [];
		for (let i = 0; i < sorted.length; i++) {
			const value = sorted[i]!;
			if (out.length > 0 && out[out.length - 1]!.value === value) {
				continue;
			}
			// Count of entries ≤ value = index of last occurrence + 1.
			let last = i;
			while (last + 1 < sorted.length && sorted[last + 1]! === value) {
				last++;
			}
			out.push({ value, cumulativeFraction: (last + 1) / sorted.length });
		}
		return out;
	}

	/** A named timeline's points in record order (a copy), or `[]` if none. */
	timelineOf(name: string): TimelinePoint[] {
		return [...(this.timelines.get(name) ?? [])];
	}

	// --- export --------------------------------------------------------------

	/** Structured JSON snapshot: counters, histogram summaries (+ raw values), and timelines. */
	exportJson(): string {
		const counters = [...this.counters.values()].map((c) => ({
			name: c.name,
			tags: c.tags ?? {},
			value: c.value
		}));
		const histograms = [...this.histograms.values()].map((h) => ({
			name: h.name,
			tags: h.tags ?? {},
			...summarize(h.values),
			values: h.values
		}));
		const timelines = [...this.timelines.entries()].map(([name, points]) => ({ name, points }));
		return JSON.stringify({ counters, histograms, timelines }, undefined, 2);
	}

	/**
	 * Flat CSV for spreadsheet analysis: one row per datum with a `section` discriminator.
	 * Columns: `section,name,tags,stat,value`. Counters emit one row (`stat=count`); histograms emit
	 * one row per summary statistic; timelines emit one row per point with the virtual time in `stat`.
	 */
	exportCsv(): string {
		const rows: string[][] = [['section', 'name', 'tags', 'stat', 'value']];
		for (const c of this.counters.values()) {
			rows.push(['counter', c.name, serializeTags(c.tags), 'count', String(c.value)]);
		}
		for (const h of this.histograms.values()) {
			const tags = serializeTags(h.tags);
			const stats = summarize(h.values);
			for (const [stat, value] of Object.entries(stats)) {
				rows.push(['histogram', h.name, tags, stat, String(value)]);
			}
		}
		for (const [name, points] of this.timelines) {
			for (const p of points) {
				rows.push(['timeline', name, '', String(p.t), String(p.value)]);
			}
		}
		return rows.map((r) => r.map(csvCell).join(',')).join('\n');
	}
}

/** Summary statistics over a value list; zeroed `HistogramStats` for an empty list. */
export function summarize(values: readonly number[]): HistogramStats {
	if (values.length === 0) {
		return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, v) => acc + v, 0);
	return {
		count: sorted.length,
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
		mean: sum / sorted.length,
		p50: percentileOfSorted(sorted, 50),
		p95: percentileOfSorted(sorted, 95),
		p99: percentileOfSorted(sorted, 99)
	};
}
