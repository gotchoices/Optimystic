import type { EventScheduler, SeededRng, VTime } from './types.js';
import type { PartitionSpec } from './partition.js';

/**
 * Churn generator — scheduled peer arrivals and departures at a configured rate, with per-event
 * latency jitter, all drawn from the seeded RNG. Models `docs/cohort-topic.md` §Failure modes and
 * §Anti-flood (re-registration jitter). Population dynamics only: arrivals/departures are surfaced
 * through callbacks so a caller can place peers on the FRET ring (`simulator-fret-cohort-model`),
 * attach/detach them on a `TopicTree`, or drive registrations — the generator owns *when*, the
 * caller owns *what*. Synchronous and deterministic from `(seed, config)`.
 */

export interface ChurnConfig {
	/** Fraction of the active population that turns over per minute, e.g. 0.2 for 20%/min. */
	readonly churnPctPerMin: number;
	/** Maximum per-event scheduling jitter (ms); each event fires `tick + rng.nextInt(jitter+1)`. */
	readonly latencyJitterMs: number;
	/** Optional injected partitions + heals (applied by the caller via the partition module). */
	readonly partitionEvents?: PartitionSpec[];
}

export interface ChurnGeneratorOptions {
	readonly scheduler: EventScheduler;
	readonly rng: SeededRng;
	readonly config: ChurnConfig;
	/** Initial active population (participant ids). Mutated as peers come and go. */
	readonly active: string[];
	/** Reserve pool of ids available to arrive. Mutated as peers come and go. */
	readonly pool: string[];
	/** Churn-evaluation cadence on the virtual clock (default 60_000 ms = one minute). */
	readonly tickMs?: VTime;
	readonly onArrival?: (participantId: string, now: VTime) => void;
	readonly onDeparture?: (participantId: string, now: VTime) => void;
}

export class ChurnGenerator {
	readonly config: ChurnConfig;
	arrivals = 0;
	departures = 0;
	private readonly scheduler: EventScheduler;
	private readonly rng: SeededRng;
	private readonly active: string[];
	private readonly pool: string[];
	private readonly tickMs: VTime;
	private readonly onArrival: (id: string, now: VTime) => void;
	private readonly onDeparture: (id: string, now: VTime) => void;
	private running = false;

	constructor(opts: ChurnGeneratorOptions) {
		if (!(opts.config.churnPctPerMin >= 0)) {
			throw new RangeError(`churnPctPerMin must be >= 0, got ${opts.config.churnPctPerMin}`);
		}
		if (!Number.isInteger(opts.config.latencyJitterMs) || opts.config.latencyJitterMs < 0) {
			throw new RangeError(`latencyJitterMs must be a non-negative integer, got ${opts.config.latencyJitterMs}`);
		}
		this.scheduler = opts.scheduler;
		this.rng = opts.rng;
		this.config = opts.config;
		this.active = opts.active;
		this.pool = opts.pool;
		this.tickMs = opts.tickMs ?? 60_000;
		this.onArrival = opts.onArrival ?? (() => {});
		this.onDeparture = opts.onDeparture ?? (() => {});
	}

	get activeCount(): number {
		return this.active.length;
	}

	/** Start the recurring churn tick; bound it with `scheduler.run(until)`. Idempotent. */
	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.scheduleTick();
	}

	stop(): void {
		this.running = false;
	}

	private scheduleTick(): void {
		this.scheduler.scheduleAfter(this.tickMs, (ctx) => {
			if (!this.running) {
				return;
			}
			this.churnOnce(ctx.now);
			this.scheduleTick();
		});
	}

	/**
	 * One churn step: turn over `churnPctPerMin · population · (tick/min)` peers — an equal number
	 * out (clean departure → cohort TTL eviction) and in (arrival → ring placement / attach), each
	 * staggered by latency jitter so the burst spreads rather than spiking (anti-flood
	 * §Re-registration storm). Count is computed before mutation so a tick's in/out are balanced.
	 */
	private churnOnce(now: VTime): void {
		const fraction = (this.config.churnPctPerMin * this.tickMs) / 60_000;
		const count = Math.round(this.active.length * fraction);
		for (let i = 0; i < count; i++) {
			this.scheduleDeparture(now);
			this.scheduleArrival(now);
		}
	}

	private scheduleDeparture(now: VTime): void {
		if (this.active.length === 0) {
			return;
		}
		const idx = this.rng.nextInt(this.active.length);
		const id = this.active.splice(idx, 1)[0]!;
		this.pool.push(id);
		const at = this.jitter(now);
		this.scheduler.scheduleAt(at, (ctx) => {
			this.departures++;
			this.onDeparture(id, ctx.now);
		});
	}

	private scheduleArrival(now: VTime): void {
		if (this.pool.length === 0) {
			return;
		}
		const idx = this.rng.nextInt(this.pool.length);
		const id = this.pool.splice(idx, 1)[0]!;
		this.active.push(id);
		const at = this.jitter(now);
		this.scheduler.scheduleAt(at, (ctx) => {
			this.arrivals++;
			this.onArrival(id, ctx.now);
		});
	}

	private jitter(now: VTime): VTime {
		const j = this.config.latencyJitterMs > 0 ? this.rng.nextInt(this.config.latencyJitterMs + 1) : 0;
		return now + j;
	}
}
