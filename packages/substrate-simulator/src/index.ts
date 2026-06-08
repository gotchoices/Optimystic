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
export { bytesToHex } from './hex.js';
export {
	type TopicId,
	type TierAddressConfig,
	DEFAULT_TIER_ADDRESS_CONFIG,
	log2F,
	prefixBits,
	coordForTier,
	coord0,
	buildCoordLadder,
	deriveTopicId
} from './topic-addressing.js';
export {
	type Tier,
	TIER_COUNT,
	type DeviceProfile,
	type MemberWillingness,
	type MemberWillingnessOptions,
	type AdmissionResult,
	type AdmissionVerdict,
	DEFAULT_OVERLOAD_BUCKET,
	profileAllows,
	makeMemberWillingness,
	setMemberLoadBucket,
	isWilling,
	willingnessVector,
	willingnessBits,
	cohortWillingnessBits,
	classifyAdmission
} from './willingness.js';
export {
	type TopicTrafficV1,
	type SimEvent,
	type SimEventKind,
	type EventSink,
	CollectingEventSink,
	NULL_EVENT_SINK
} from './topic-events.js';
export {
	type GrowthSample,
	type TopicCohortState,
	type LifecycleConfig,
	type TopicTreeOptions,
	DEFAULT_LIFECYCLE_CONFIG,
	TopicTree
} from './topic-tree.js';
