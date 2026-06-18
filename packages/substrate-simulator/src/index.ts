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
export {
	type PrimaryAssignment,
	fnv1a32,
	cohortEpochOf,
	slotOf,
	CohortMembership
} from './cohort-membership.js';
export {
	type RegistrationRecord,
	type RenewResult,
	type RenewReply,
	type TopicCohortOptions,
	type ParticipantRenewalOptions,
	TopicCohort,
	ParticipantRenewal
} from './registration.js';
export {
	type BackoffConfig,
	type AdmissionGate,
	type BackoffAdmissionOptions,
	DEFAULT_BACKOFF_CONFIG,
	backoffDelay,
	BackoffAdmission,
	WillingnessGossip
} from './backoff.js';
export {
	type PartitionSpec,
	type PartitionConvergence,
	splitMembership,
	healMembership,
	checkConvergence
} from './partition.js';
export {
	type ChurnConfig,
	type ChurnGeneratorOptions,
	ChurnGenerator
} from './churn.js';
export {
	type WalkReply,
	type WalkProbe,
	type WalkTrace,
	type WalkAdmission,
	type ParticipantWalkOptions,
	ParticipantWalk,
	rejoinStagger,
	rateLimitedStagger
} from './walk.js';
export {
	distinctStartCoords,
	acceptedPerSecond,
	peakAcceptedPerSecond,
	peakAcceptedInWindow,
	acceptedAtTier,
	hopPercentile,
	outwardMovesArePromoted,
	unwillingRetriesRestartAtDMax
} from './walk-metrics.js';
export {
	type CapabilityFilter,
	type SimProvider,
	type MatchmakingConfig,
	type SeekerDemand,
	type HangOutAction,
	type HangOutDecision,
	DEFAULT_MATCHMAKING_CONFIG,
	matchesFilter,
	countMatchable,
	expectedNewMatches,
	contentionFactor,
	decideHangOut,
	FilterAcceptEstimator
} from './matchmaking.js';
export {
	type SeekerTrace,
	type TrafficReporter,
	type TierProviderConfig,
	type SeekerWalkOptions,
	TierProviderModel,
	SeekerWalk
} from './seeker-walk.js';
export {
	type RefinementSignal,
	patienceSplittingWouldHelp,
	seekerPoolContentionWouldFlip,
	measureRefinementSignal
} from './refinement-signal.js';
export {
	type DepthSample,
	type ConvergenceResult,
	type ConvergenceOptions,
	type OvershootComparison,
	expectedDepth,
	sampleDepth,
	uniformLadder,
	skewedLadder,
	PromotionTracer,
	runConvergence,
	compareLookahead
} from './promotion-convergence.js';
export {
	type ReactivityConfig,
	type RevisionEntry,
	type CheckpointWindow,
	type IngestVerdict,
	type ResumeKind,
	type ResumeTrace,
	type ResumeCost,
	type ResumeInput,
	type CoverageReadout,
	type AdaptiveWFinding,
	type ThrashReadout,
	type RotationBurstResult,
	DEFAULT_REACTIVITY_CONFIG,
	DEFAULT_RESUME_COST,
	ReplayRing,
	RollingCheckpoint,
	DedupeWindow,
	CohortPushState,
	classifyResume,
	resumeRpcCount,
	resumeLatency,
	traceResume,
	coverageSeconds,
	measureCoverage,
	assessAdaptiveW,
	measureRepeatedWakeThrash,
	simulateRotationBurst
} from './reactivity.js';
export {
	type TagValue,
	type Tags,
	type HistogramStats,
	type TimelinePoint,
	type CdfPoint,
	type MetricsSink,
	Metrics,
	summarize,
	serializeTags
} from './metrics.js';
export {
	type SimWorld,
	type Claim,
	type ClaimReport,
	type Scenario,
	type ScenarioFactory,
	type ColdStartOptions,
	type ChurnRecoveryOptions,
	type TailRotationOptions,
	type VotingQuorumOptions,
	type AdversarialOptions,
	ColdStartStormScenario,
	ChurnRecoveryScenario,
	TailRotationScenario,
	VotingQuorumScenario,
	AdversarialReportingScenario,
	SCENARIO_FACTORIES,
	runScenario,
	runAllScenarios,
	allClaimsPass
} from './scenarios.js';
export {
	type ScaleSweepOptions,
	type ScaleSample,
	type ScaleSweepResult,
	type SweepParameter,
	type SensitivitySample,
	type SensitivitySweepResult,
	type SensitivitySweepOptions,
	runScaleSweep,
	runSensitivitySweep,
	samplesFor
} from './sweep.js';
export {
	type EnvelopeBoundary,
	type BoundaryAxisSpec,
	type BoundaryReport,
	findBoundary,
	recordBoundary
} from './boundary.js';
export {
	type TreeBoundaryOptions,
	type TreeBoundaryReport,
	type UnwillingBreach,
	type ChurnReadout,
	type UnwillingReadout,
	prefixSkewAxis,
	churnFlapAxis,
	unwillingFractionAxis,
	measureChurnFlap,
	measureUnwillingWalks,
	runTreeBoundaries
} from './boundary-tree.js';
