export type {
	VTime,
	PeerRef,
	EventRun,
	BatchRun,
	EventScheduler,
	EventContext,
	SeededRng,
	LatencyModel,
	SimConfig,
	SimWorldCore
} from './types.js';

export { Mulberry32Rng, createRng } from './rng.js';
export { EventHeap, type HeapEntry } from './heap.js';
export { VirtualScheduler, type SchedulerOptions } from './scheduler.js';
export {
	DeterministicLatency,
	StochasticLatency,
	AdversarialLatency,
	DEFAULT_GOSSIP_ROUND_MS,
	DEFAULT_HOP_MS,
	type StochasticLatencyOptions,
	type LatencyStrategy
} from './latency.js';
export { generatePeers } from './peer.js';
export { createSimWorld } from './world.js';
export { RingModel, type RingCoord } from './ring-model.js';
export { CohortModel } from './cohort-model.js';
export {
	SizeModel,
	computeDMax,
	DEFAULT_DMAX_CONFIG,
	type DMaxConfig,
	type SizeEstimate
} from './size-model.js';
export { FretModel, type FretModelOptions } from './fret-model.js';
