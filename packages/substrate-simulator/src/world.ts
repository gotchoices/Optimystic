import type { SimConfig, SimWorldCore, LatencyModel } from './types.js';
import { createRng } from './rng.js';
import { VirtualScheduler, type SchedulerOptions } from './scheduler.js';
import { DeterministicLatency, DEFAULT_HOP_MS } from './latency.js';

/**
 * Wire the core four fields of a simulation from `(SimConfig, LatencyModel)`. Downstream
 * tickets (`simulator-fret-cohort-model` and later) extend `SimWorldCore` by composition —
 * adding the peer population and ring models on top — rather than churning this type. This
 * ticket ships only the core; no population/topics here.
 *
 * Latency defaults to `DeterministicLatency` (Decision 2): conservative and reproducible.
 */
export function createSimWorld(
	config: SimConfig,
	latency: LatencyModel = new DeterministicLatency(DEFAULT_HOP_MS),
	schedulerOptions?: SchedulerOptions
): SimWorldCore {
	const rng = createRng(config.seed);
	const scheduler = new VirtualScheduler(rng, latency, schedulerOptions);
	return { scheduler, rng, latency, config };
}
