/**
 * Reactivity **mock-transport mesh harness** — the in-process, many-logical-node substrate for the
 * reactivity *e2e* tier (`docs/reactivity.md`), layered on the cohort-topic mesh harness
 * ({@link import("./cohort-topic-mesh-harness.js")}) rather than forking it (the same relationship the
 * {@link import("./matchmaking-mesh-harness.js").MatchmakingMesh} has to it). It drives the **real**
 * reactivity hot path end-to-end over a network of real-Ed25519-keyed cohort-topic hosts:
 *
 *  - **Origination** rides the real {@link makeCohortTopicChangeNotifier} over a real {@link StorageRepo}:
 *    a `pend`+`commit` fires the catch-all change feed → the bridge hands the {@link CollectionChangeEvent}
 *    + a **real** threshold {@link CommitCert} (each tail-cohort member signs the commit-vote payload with
 *    its real Ed25519 key, assembled by {@link buildCommitCert}) to the real
 *    {@link ReactivityOriginationManager}, which builds the {@link NotificationV1} reusing the cert's
 *    threshold signature **unchanged** — exactly as in production (`local-change-notifier-bridge`).
 *  - **Forwarding** runs the real {@link createReactivityForwarder} receive path (verify → dedupe → buffer)
 *    over a real {@link PushState} (replay ring + rolling checkpoint + per-subscriber backpressure).
 *  - **Delivery** runs the real {@link ReactivitySubscriptionManager} (register at cohort-topic tier **T3**,
 *    verify against the cached tail-cohort {@link MembershipCertV1} with **real** collected-multisig crypto,
 *    contiguity check, gap → backfill, `(collectionId, revision)` dedupe, surface).
 *  - **Recovery** serves real {@link serveBackfill} / {@link serveResume} from the tail `PushState`, applied
 *    subscriber-side by the manager's `resume()` / backfill seam.
 *  - **Rotation** drives the real {@link BlockFillTracker} / {@link buildRotationHint} /
 *    {@link planReRegistrationWave} / {@link buildRotationHandoffCheckpoint} lifecycle; **backpressure**
 *    drives the real {@link PushState.enqueueForSubscribers}.
 *
 * **What is real vs. modeled (honest).** Every signature, registration record, replay-buffer entry, dedupe
 * decision, checkpoint fold, and resume classification is the real db-core/db-p2p code. What the harness
 * *models* is the **notification transport** (the application protocol that would dial each subscriber's
 * primary and each child cohort) — it fans the originated notification to the tracked direct subscribers
 * in-process via the real per-subscriber bounded queues — and, like the matchmaking harness, the
 * **single-tier-0 reach**: the cohort-topic substrate serves a single tier-0 cohort (multi-tier *serving*
 * promotion to a tier-`d ≥ 1` forwarder cohort is gated on the cohort-topic follow-ons), so a deep
 * forwarder *tree* fan-out is tagged-unimplemented in the suites, not faked here. The tail cohort fanning
 * to every direct subscriber — the heart of contiguous/verified delivery — is fully real.
 *
 * **Virtual time.** Like the sibling harnesses this is not a wall-clock simulator: `now` is an explicit
 * virtual clock the harness advances ({@link ReactivityMesh.advanceTime}), so `T_drain` / rotation timing
 * resolve deterministically without sleeping. The only real-time waits are the cohort harness's tiny
 * async-settle polls.
 */

import type { PrivateKey } from "@libp2p/interface";
import {
	Tier,
	reactivityTopicId,
	createReactivityForwarder,
	createNotificationVerifier,
	PushState,
	serveBackfill,
	serveResume,
	buildRotationHint,
	BlockFillTracker,
	TailDrainGate,
	planReRegistrationWave,
	buildRotationHandoffCheckpoint,
	applyRotationHandoff,
	createRejoinJitter,
	mayServeAsReactivityForwarder,
	deltaMaxForProfile,
	coreProfile,
	edgeProfile,
	bytesToB64url,
	DEFAULT_CAP_PROMOTE_FAST,
	T_REJOIN_JITTER_MS,
	WARM_THRESHOLD_DEFAULT,
	type ActionId,
	type BlockId,
	type CohortTopicService,
	type CollectionChangeEvent,
	type CommitCert,
	type ClusterRecord,
	type ClusterPeers,
	type Signature,
	type ForwardDecision,
	type IBlock,
	type MembershipCertV1,
	type NotificationV1,
	type NotificationVerifier,
	type NodeProfile,
	type ReactivityForwarder,
	type RegistrationHandle,
	type ResumeApplyOutcome,
	type ResumeReplyV1,
	type ResumeV1,
	type RotationHintV1,
	type CheckpointSummary,
	type ReRegistrationPlan,
	type Transforms,
} from "@optimystic/db-core";
import { StorageRepo } from "../storage/storage-repo.js";
import { BlockStorage } from "../storage/block-storage.js";
import { MemoryRawStorage } from "../storage/memory-storage.js";
import { makeCohortTopicChangeNotifier } from "../cohort-topic/change-bridge.js";
import { buildCommitCert } from "../cluster/commit-cert.js";
import { ReactivitySubscriptionManager, type RotationNotice } from "../reactivity/subscription-manager.js";
import { ReactivityOriginationManager } from "../reactivity/origination-manager.js";
import { RotationReRegistrationScheduler, type RotationTimerCancel } from "../reactivity/rotation-rereg-scheduler.js";
import { RotationRedirectError } from "../reactivity/recover-transport.js";
import {
	addressing,
	buildMesh,
	delay,
	makeMembers,
	setupTopic,
	type CohortMesh,
	type Member,
	type MeshOptions,
	type TopicSetup,
} from "./cohort-topic-mesh-harness.js";

export { addressing, delay };
export type { Member, NotificationV1 };

const utf8 = new TextEncoder();

/** Construction inputs for a {@link ReactivityMesh}. */
export interface ReactivityMeshOptions {
	/** Node count. Default 12. */
	readonly nodeCount?: number;
	/** Cohort size `wantK`. Default `min(nodeCount, 8)`. */
	readonly wantK?: number;
	/** Verifier threshold (notifications are signed by all `wantK` tail members; the verifier needs `>= minSigs`). Default `max(1, wantK - 2)`. */
	readonly minSigs?: number;
	/** FRET network-size estimate (drives the default walk start tier). Default 256 → `d_max = 1`. */
	readonly sizeEstimate?: number;
	/**
	 * `cap_promote` applied to every cohort. Default very high so the topic stays a single tier-0 cohort for
	 * the life of a test (multi-tier *serving* promotion is a cohort-topic follow-on; see the module note).
	 * Lower it to drive the promotion *signal* (the cold-to-hot growth suite).
	 */
	readonly capPromote?: number;
	/** Per-node profile by index (Edge nodes never forward T3). Default all Core. */
	readonly profiles?: readonly ("edge" | "core")[];
}

/** Per-collection knobs (scaled down so resume/checkpoint suites need only a few dozen commits). */
export interface CollectionOptions {
	/** Replay-buffer depth `W` (default 256; scale down for fast resume tests). */
	readonly w?: number;
	/** Parent-checkpoint span `W_checkpoint` (default 4096). */
	readonly wCheckpoint?: number;
	/** Per-subscriber bounded-queue depth `queue_max` (default 32). */
	readonly queueMax?: number;
	/** Per-collection delta budget (bytes); default Core `delta_max`. */
	readonly deltaMaxBytes?: number;
	/** Block-fill size driving tail rotation (default 64). */
	readonly blockFillSize?: number;
	/** Anticipatory warm-up threshold (default 8). */
	readonly warmThreshold?: number;
}

/** Per-subscription tuning. */
export interface SubscribeOptions {
	/** Last revision already held; `0` (default) ⇒ fresh subscribe, adopt the first notification as baseline. */
	readonly lastKnownRev?: number;
	/** Node profile for the subscriber (Edge ⇒ shorter TTL, declines deltas, never forwards). Default the node's mesh profile. */
	readonly profile?: NodeProfile;
	/**
	 * When `false`, the subscriber does **not** drain its bounded queue after each fan-out — modeling a slow
	 * subscriber on a flaky link whose queue fills and drops-oldest. Default `true` (drain immediately).
	 */
	readonly autoDrain?: boolean;
}

/** A live reactivity subscription in the mesh — the real manager + its delivery bookkeeping. */
export interface SubscriptionHandle {
	readonly nodeIndex: number;
	readonly member: Member;
	/** Per-subscriber id (its dialable member bytes, base64url) — the backpressure-map key. */
	readonly subId: string;
	/** The real subscription manager (assigned once, immediately after the handle is built). */
	manager: ReactivitySubscriptionManager;
	/** Verified, contiguous, deduped notifications the manager surfaced (in delivery order). */
	readonly delivered: NotificationV1[];
	/** The tail (base64url) this subscriber currently tracks — fan-out targets only current-tail subscribers. */
	attachedTailB64: string;
	readonly collectionName: string;
	/** Whether the subscriber drains its bounded queue automatically (false ⇒ slow-subscriber model). */
	autoDrain: boolean;
	/** Whether the subscriber is asleep (skipped by fan-out; its replay buffer still fills). */
	asleep: boolean;
	/** Registration handle from the real `service.register` walk. */
	registration?: RegistrationHandle;
	/** Number of backfill RPCs the subscriber's gap-detection seam drove. */
	backfills: number;
	/** Set true if a resume escalated to a chain read (out_of_window / untrusted checkpoint). */
	chainRead: boolean;
	/** Set to `[newTailId, newRevisionAtRotation]` if a resume returned tail_rotated. */
	tailRotated?: readonly [string, number];
	/** Checkpoint summaries applied on a checkpoint-window resume (the merged-digest hint). */
	readonly checkpointDigests: CheckpointSummary[];
	/** Rotation notices the manager surfaced from a delivered pre-announce / hard rotation (once per successor). */
	readonly rotationNotices: RotationNotice[];
	/**
	 * Per-subscriber re-registration scheduler bound to the manager's `onRotation` observer, driven over the
	 * harness virtual clock ({@link ReactivityMesh.advanceTime}). On fire it re-attaches this subscriber under
	 * the new tail (the production move the deferred Quereus `Database.watch` factory performs) — so the
	 * notify/recover rotation seams run end-to-end (`reactivity-rotation-host-wiring-e2e` §C).
	 */
	scheduler: RotationReRegistrationScheduler;
}

/** Per-collection state the harness threads through origination, fan-out, and recovery. */
interface CollectionState {
	readonly name: string;
	readonly collectionId: Uint8Array;
	readonly collectionIdB64: string;
	tailId: Uint8Array;
	topicId: Uint8Array;
	coord0: Uint8Array;
	tailCohort: Member[];
	/** Cohort setup for the **current** tail; re-established (willingness re-seeded) on each {@link ReactivityMesh.rotateTail}. */
	setup: TopicSetup;
	readonly repo: StorageRepo;
	readonly originationService: CohortTopicService;
	origination?: ReactivityOriginationManager;
	pushState: PushState;
	forwarder: ReactivityForwarder;
	readonly emitQueue: NotificationV1[];
	rev: number;
	blockSeq: number;
	readonly deltaMaxBytes: number;
	readonly w: number;
	readonly wCheckpoint: number;
	readonly queueMax: number;
	readonly fillTracker: BlockFillTracker;
	rotationHint?: RotationHintV1;
	/**
	 * The outgoing tail's drain gate, set by a transport-driven {@link ReactivityMesh.rotateTail} (`{
	 * autoReattach: false }`) — models the running node's `ReactivityForwarderHost.markRotated`. A resume whose
	 * `latestKnownTailId` anchors {@link rotatedFromTailB64} is bounced to the new tree while it `isDraining`.
	 */
	rotationGate?: TailDrainGate;
	/** The tail (base64url) {@link rotationGate} rotated away from — the stale tail a resume gets redirected from. */
	rotatedFromTailB64?: string;
	readonly subscribers: SubscriptionHandle[];
	/** Certs cached for actionId so the synchronous bridge extractor can resolve a pre-signed real cert. */
	readonly certByAction: Map<string, CommitCert>;
}

/** Options for {@link ReactivityMesh.rotateTail}. */
export interface RotateTailOptions {
	/**
	 * When `true` (default) the harness migrates live subscribers to the new tail directly (the wave/handoff
	 * continuity model). When `false` it instead models the running node's `ReactivityForwarderHost.markRotated`
	 * — arming the outgoing tail's {@link TailDrainGate} — so a subscriber resuming against the old tail is
	 * **redirected** to the new tree and re-attaches through its own `onRotation` → scheduler → reRegister path
	 * (the transport-driven e2e proof, `reactivity-rotation-host-wiring-e2e` §C).
	 */
	readonly autoReattach?: boolean;
}

/** The outcome of a {@link ReactivityMesh.rotateTail} — the planned re-registration wave + handoff. */
export interface RotationResult {
	readonly newTailId: Uint8Array;
	readonly newTailIdB64: string;
	readonly rotationRevision: number;
	readonly plans: readonly ReRegistrationPlan[];
	/** Peak re-registration arrivals in any `T_rejoin_jitter`-long window of the wave (the fast-promote bound). */
	readonly peakWindowArrivals: number;
	/** The buffer-to-checkpoint handoff folded onto the new tail (undefined if the old ring was empty). */
	readonly handoff?: CheckpointSummary;
}

/**
 * The reactivity integration mesh. Build with {@link buildReactivityMesh}; register a collection with
 * {@link registerCollection}; drive subscribers/commits/recovery with {@link subscribe} / {@link commit} /
 * {@link resume} / {@link rotateTail}.
 */
export class ReactivityMesh {
	private readonly collections = new Map<string, CollectionState>();
	private vtime = 1_700_000_000_000;
	private corr = 0;
	/** Pending one-shot timers armed against the virtual clock (the rotation scheduler's `setTimer` binding). */
	private readonly virtualTimers: { fireAt: number; fn: () => void; cancelled: boolean }[] = [];

	private constructor(
		readonly mesh: CohortMesh,
		readonly members: Member[],
		private readonly wantK: number,
		private readonly minSigs: number,
		private readonly profiles: readonly ("edge" | "core")[],
	) {}

	/** Stand up an N-node reactivity mesh and start every host. */
	static async build(opts: ReactivityMeshOptions = {}): Promise<ReactivityMesh> {
		const nodeCount = opts.nodeCount ?? 12;
		const wantK = opts.wantK ?? Math.min(nodeCount, 8);
		const minSigs = opts.minSigs ?? Math.max(1, wantK - 2);
		const sizeEstimate = opts.sizeEstimate ?? 256;
		const members = await makeMembers(nodeCount);
		const meshOpts: MeshOptions = {
			wantK,
			minSigs,
			sizeEstimate,
			// Single-tier-0 by default (same rationale as the matchmaking harness): test artifacts register
			// many subscribers within a few ms, which would otherwise trip the pre-promotion slope predictor.
			capPromote: opts.capPromote ?? 1_000_000,
			// This mesh is virtual-time: a subscribe batch lands at one fixed virtual instant, but the cohort
			// host stamps each register with real `Date.now()`. The growth-slope pre-promotion is a
			// wall-clock-rate heuristic, so those real-time-separated samples make it fire *before* the
			// `cap_promote` count is reached (redirecting the rest of the batch up a tier-1 tree the
			// single-tier-0 milestone never instantiates). Disable slope here so promotion is driven purely by
			// the count threshold — the same posture the cohort-topic scale specs get by stamping a constant
			// `now` on every `handleRegister`. The slope heuristic itself is covered by the promotion unit specs.
			promotion: { tPromoteLookaheadMs: 0 },
			// Permissive register ceiling — the harness re-probes a cohort across many subscribes/commits.
			// Also widen the replay-guard freshness window. The cohort host stamps each register with real
			// `Date.now()` and evaluates the anti-DoS freshness gate against real `Date.now()` at processing
			// time, but this mesh drives the real participant walk in-process: under full-suite CPU load the
			// event loop can stall for far longer than the production 60 s staleness window between a register
			// being stamped and the deciding cohort processing it. A stalled-but-legitimate register then
			// trips the freshness gate (`no_state`), the cold-start bootstrap walk exhausts, and `register`
			// throws `CohortBackoffError` — a pure load-induced harness flake. The wall-clock freshness
			// defense is meaningless here (same posture as the disabled rate limiter above), so make the
			// window effectively unbounded so test-induced stalls never read as stale/future replays.
			antiDos: { rateLimiter: { ratePerWindow: 1_000_000 }, replayGuard: { maxAgeMs: 86_400_000, maxFutureSkewMs: 86_400_000 } },
			...(opts.profiles === undefined ? {} : { profiles: opts.profiles }),
		};
		const mesh = await buildMesh(members, meshOpts);
		const profiles = Array.from({ length: nodeCount }, (_v, i) => opts.profiles?.[i] ?? "core");
		return new ReactivityMesh(mesh, members, wantK, minSigs, profiles);
	}

	/** The current virtual time (unix ms). */
	get now(): number {
		return this.vtime;
	}

	/**
	 * Advance the virtual clock by `ms` (drives `T_drain` / rotation timing deterministically), then fire any
	 * virtual timers now due. A fired timer may arm another (a chained rotation), so fire one-at-a-time until
	 * the queue is quiescent — the rotation re-registration scheduler's `setTimer` binding rides this.
	 */
	advanceTime(ms: number): void {
		this.vtime += ms;
		for (;;) {
			const idx = this.virtualTimers.findIndex((t) => !t.cancelled && t.fireAt <= this.vtime);
			if (idx === -1) {
				break;
			}
			const [timer] = this.virtualTimers.splice(idx, 1);
			if (!timer!.cancelled) {
				timer!.fn();
			}
		}
	}

	/** Arm a one-shot timer against the virtual clock; the cancel handle drops it (the scheduler's `setTimer`). */
	private armVirtualTimer(fn: () => void, delayMs: number): RotationTimerCancel {
		const timer = { fireAt: this.vtime + Math.max(0, delayMs), fn, cancelled: false };
		this.virtualTimers.push(timer);
		return (): void => { timer.cancelled = true; };
	}

	private profileOf(index: number): NodeProfile {
		return this.profiles[index] === "edge" ? edgeProfile() : coreProfile();
	}

	/**
	 * Register a collection on the mesh: instantiate its tail-anchored tier-0 cohort (+willingness quorum),
	 * install the real origination manager behind the real change-notifier bridge over a fresh `StorageRepo`,
	 * build the tail `PushState` (replay ring + rolling checkpoint + backpressure), and cache the tail
	 * cohort's `MembershipCertV1` into every node's verifier so end-to-end verification is real Ed25519.
	 */
	async registerCollection(name: string, opts: CollectionOptions = {}): Promise<void> {
		const collectionId = utf8.encode(`reactivity:${name}`);
		const collectionIdB64 = bytesToB64url(collectionId);
		const tailId = this.pinTailToCore(`${name}:tail-0`);
		const topicId = reactivityTopicId(tailId);
		const coord0 = addressing.coord0(topicId);
		const setup = await setupTopic(this.mesh, topicId);
		const tailCohort = this.cohortMembersAround(coord0);

		const deltaMaxBytes = opts.deltaMaxBytes ?? deltaMaxForProfile(coreProfile());
		const w = opts.w ?? 256;
		const wCheckpoint = opts.wCheckpoint ?? 4096;
		const queueMax = opts.queueMax ?? 32;

		const rawStorage = new MemoryRawStorage();
		const repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));

		// Origination is the tail cohort primary's responsibility — installed on the node nearest coord_0
		// (the routed tail primary), exactly the node a commit on the tail cluster lands on in production.
		const originationService = setup.deciding.host.service;
		const certByAction = new Map<string, CommitCert>();
		const emitQueue: NotificationV1[] = [];
		const pushState = this.makePushState(collectionIdB64, topicId, tailId, w, wCheckpoint, queueMax, deltaMaxBytes);

		const state: CollectionState = {
			name,
			collectionId,
			collectionIdB64,
			tailId,
			topicId,
			coord0,
			tailCohort,
			setup,
			repo,
			originationService,
			pushState,
			forwarder: createReactivityForwarder({ state: pushState, verifier: this.notificationVerifierFor(originationService) }),
			emitQueue,
			rev: 0,
			blockSeq: 0,
			deltaMaxBytes,
			w,
			wCheckpoint,
			queueMax,
			fillTracker: new BlockFillTracker({
				...(opts.blockFillSize === undefined ? {} : { blockFillSize: opts.blockFillSize }),
				// warm_threshold must be < block_fill_size; clamp the default down for small (test-scaled) blocks.
				warmThreshold: opts.warmThreshold ?? (opts.blockFillSize === undefined ? WARM_THRESHOLD_DEFAULT : Math.min(WARM_THRESHOLD_DEFAULT, Math.max(0, opts.blockFillSize - 1))),
			}),
			subscribers: [],
			certByAction,
		};

		const origination = new ReactivityOriginationManager({
			service: originationService,
			resolveContext: (): { tailId: Uint8Array; deltaMaxBytes: number; rotationHint?: RotationHintV1 } => ({
				tailId: state.tailId,
				deltaMaxBytes: state.deltaMaxBytes,
				...(state.rotationHint === undefined ? {} : { rotationHint: state.rotationHint }),
			}),
			emit: (n): void => { emitQueue.push(n); },
			clock: (): number => this.vtime,
		});
		origination.install();
		state.origination = origination;

		// The real local-change-notifier bridge: a StorageRepo commit → onLocalCommit → origination.
		makeCohortTopicChangeNotifier({
			source: repo,
			service: originationService,
			selfIsCohortMember: (e): boolean => e.collectionId === (collectionIdB64 as unknown as CollectionChangeEvent["collectionId"]),
			extractCommitCert: (e): CommitCert | undefined => certByAction.get(e.actionId),
		});

		this.collections.set(name, state);
		this.cacheTailCert(state);
	}

	/** The reactivity notification verifier over a node's service verifier (real collected-multisig at T3). */
	private notificationVerifierFor(service: CohortTopicService): NotificationVerifier {
		return createNotificationVerifier({ verifier: service.verifier(), tier: Tier.T3 });
	}

	private makePushState(collectionIdB64: string, topicId: Uint8Array, tailId: Uint8Array, w: number, wCheckpoint: number, queueMax: number, deltaMaxBytes: number): PushState {
		return new PushState({
			collectionId: collectionIdB64,
			topicId: bytesToB64url(topicId),
			tailIdAtJoin: bytesToB64url(tailId),
			w,
			wCheckpoint,
			queueMax,
			deltaMaxBytes,
		});
	}

	/** The FRET cohort (the `wantK` nearest members) around a coord. */
	private cohortMembersAround(coord: Uint8Array): Member[] {
		const ids = new Set(this.mesh.assembleCohort(coord, this.wantK));
		return this.members.filter((m) => ids.has(m.idStr));
	}

	/** Whether the node FRET-routes nearest to `coord` (the cohort's routed primary) is an Edge profile. */
	private nearestIsEdge(coord: Uint8Array): boolean {
		const nearest = this.mesh.nearest(coord);
		const idx = this.members.findIndex((m) => m.idStr === nearest.idStr);
		return idx >= 0 && this.profiles[idx] === "edge";
	}

	/**
	 * Choose a reactivity tail id derived from `baseTail` whose `coord_0` routes nearest a **Core** node.
	 * Reactivity topics serve at tier T3, and an Edge node declines a T3 cold-start by design (it serves no
	 * forwarder duty — pinned by `cohort-topic-scale-lifecycle` "Edge serves no T3"), so a topic whose
	 * `coord_0` routes nearest an Edge node can never instantiate its tail cohort: the routed primary returns
	 * `no_state`, the walk exhausts, and `register` throws `CohortBackoffError`. Because {@link makeMembers}
	 * re-randomizes the member ring layout every run, an Edge-profile mesh would otherwise *intermittently*
	 * seat the Edge node as a collection's tail primary (~1/nodeCount of runs) and flake. In production a
	 * reactivity tail cohort IS the Core cluster that served the tail, so pinning the primary to a Core node
	 * models reality. A no-op (returns `utf8(baseTail)` at the first try) when the mesh has no Edge nodes —
	 * the common case — so every all-Core suite is byte-for-byte unaffected.
	 */
	private pinTailToCore(baseTail: string): Uint8Array {
		for (let nonce = 0; ; nonce++) {
			const tailId = utf8.encode(nonce === 0 ? baseTail : `${baseTail}#${nonce}`);
			if (!this.nearestIsEdge(addressing.coord0(reactivityTopicId(tailId)))) {
				return tailId;
			}
		}
	}

	private collection(name: string): CollectionState {
		const c = this.collections.get(name);
		if (c === undefined) {
			throw new Error(`reactivity mesh: collection "${name}" is not registered (call registerCollection first)`);
		}
		return c;
	}

	/**
	 * Cache the tail cohort's `MembershipCertV1` (over the FRET cohort around the current tail's coord_0) into
	 * every node's participant verifier, so a subscriber's notification verify is real Ed25519 against the
	 * tail membership — mirroring `reactivity-real-crypto.spec.ts`, now over the mesh's real cohort members.
	 */
	private cacheTailCert(c: CollectionState): void {
		const members = c.tailCohort.map((m) => bytesToB64url(m.bytes));
		const cert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(c.coord0),
			cohortEpoch: bytesToB64url(utf8.encode(`${c.name}:${bytesToB64url(c.tailId)}`)),
			members,
			stabilizedAt: this.vtime,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: members,
		};
		for (const node of this.mesh.nodes) {
			node.host.service.verifier().cache(cert);
		}
	}

	/** The tail cohort member ids (base64url member bytes) serving a collection's current tail. */
	tailCohortIds(name: string): readonly string[] {
		return this.collection(name).tailCohort.map((m) => bytesToB64url(m.bytes));
	}

	/** This collection's tier-0 cohort registration records carrying a reactivity subscribe payload. */
	cohortSubscriberCount(name: string): number {
		const c = this.collection(name);
		return c.setup.decidingEngine.records(c.topicId).filter((r) => r.appState !== undefined).length;
	}

	/** The current committed revision for a collection. */
	currentRevision(name: string): number {
		return this.collection(name).rev;
	}

	/**
	 * Drive the deciding cohort's membership stabilization (publish its `MembershipCertV1`). Promotion is
	 * fire-and-forget off the register path; stabilizing publishes the cohort cert so a crossed-`cap_promote`
	 * decision lands deterministically (no wall-clock wait) — the same pre-step the cohort-topic scale specs use.
	 */
	async stabilizeCohort(name: string): Promise<void> {
		await this.collection(name).setup.decidingEngine.onStabilized(this.vtime);
	}

	/** Whether a collection's tier-0 cohort has promoted (its direct participants crossed `cap_promote`). */
	isPromoted(name: string): boolean {
		const c = this.collection(name);
		return c.setup.decidingEngine.isPromoted(c.topicId);
	}

	/** Whether a node profile may serve as a reactivity forwarder (T3 producer) — Edge never can. */
	mayForward(nodeIndex: number): boolean {
		return mayServeAsReactivityForwarder(this.profileOf(nodeIndex));
	}

	/**
	 * Register node `nodeIndex` as a reactivity subscriber for `collection` via the **real**
	 * {@link ReactivitySubscriptionManager} → `CohortTopicService.register` walk at tier T3. The subscribe
	 * record lands in the real tier-0 cohort store; the manager owns the real verify/deliver/backfill/resume
	 * path. Returns a handle whose `delivered` array accumulates the surfaced notifications.
	 */
	async subscribe(nodeIndex: number, collection: string, opts: SubscribeOptions = {}): Promise<SubscriptionHandle> {
		const c = this.collection(collection);
		const member = this.members[nodeIndex]!;
		const service = this.mesh.nodes[nodeIndex]!.host.service;
		const profile = opts.profile ?? this.profileOf(nodeIndex);
		const subId = bytesToB64url(member.bytes);

		const handle: SubscriptionHandle = {
			nodeIndex,
			member,
			subId,
			manager: undefined as unknown as ReactivitySubscriptionManager,
			delivered: [],
			attachedTailB64: bytesToB64url(c.tailId),
			collectionName: collection,
			autoDrain: opts.autoDrain ?? true,
			asleep: false,
			backfills: 0,
			chainRead: false,
			checkpointDigests: [],
			rotationNotices: [],
			scheduler: undefined as unknown as RotationReRegistrationScheduler,
		};

		// The host re-registration scheduler bound to this subscriber, driven over the harness virtual clock. On
		// fire it re-attaches the subscriber under the rotated tail — the production move the deferred Quereus
		// `Database.watch` factory performs (`reactivity-rotation-host-wiring-e2e` §C). The single-subscriber
		// `planReRegistration` path draws `fireAt` over `T_rejoin_jitter`, so a `advanceTime` past that window
		// fires it deterministically.
		const scheduler = new RotationReRegistrationScheduler({
			reRegister: (plan): Promise<void> => { this.reAttachToNewTail(handle, plan); return Promise.resolve(); },
			setTimer: (fn, delayMs): RotationTimerCancel => this.armVirtualTimer(fn, delayMs),
			now: (): number => this.vtime,
		});
		handle.scheduler = scheduler;

		const manager = new ReactivitySubscriptionManager({
			service,
			collectionId: c.collectionId,
			tailIdAtAttach: c.tailId,
			deliver: (n): void => { handle.delivered.push(n); },
			profile,
			lastKnownRev: opts.lastKnownRev ?? 0,
			clock: (): number => this.vtime,
			// Backfill RPC served from the tail cohort's live replay buffer (real serveBackfill).
			signBackfill: (req): string => bytesToB64url(utf8.encode(`bf:${req.fromRevision}:${req.toRevision}`)),
			backfillTransport: (req) => { handle.backfills += 1; return Promise.resolve(serveBackfill(c.pushState.replayBuffer, req, c.collectionIdB64)); },
			// Resume RPC served from the tail cohort's stacked windows (real serveResume).
			signResume: (): string => bytesToB64url(utf8.encode("resume")),
			subscriberCoord: subId,
			resumeTransport: (req: ResumeV1): Promise<ResumeReplyV1> => {
				// Model the live recover serve's drain redirect (the running node's `markRotated` →
				// `rotationRedirectFor` → `RotationRedirectError`): a resume whose `latestKnownTailId` anchors a
				// rotated, still-draining tail is bounced to the new tree instead of served stale data.
				const gate = c.rotationGate;
				if (gate !== undefined && req.latestKnownTailId === c.rotatedFromTailB64 && gate.isDraining(this.vtime)) {
					return Promise.reject(new RotationRedirectError(gate.rotationRedirect));
				}
				return Promise.resolve(serveResume(req, {
					buffer: c.pushState.replayBuffer,
					checkpoint: c.pushState.checkpoint,
					// The cross-rotation inherited window the new tail holds after a handoff: a resume below the new
					// ring but within it is served `checkpoint_window` (not `out_of_window`) while it abuts the ring.
					inheritedCheckpoint: c.pushState.inheritedCheckpoint,
					currentTailId: bytesToB64url(c.tailId),
					currentRevision: c.rev,
					rotationRevision: c.rev,
					expectedCollectionId: c.collectionIdB64,
				}));
			},
			onChainRead: (): void => { handle.chainRead = true; },
			onTailRotated: (newTailId, rev): void => { handle.tailRotated = [newTailId, rev]; },
			onCheckpointDigest: (summary): void => { handle.checkpointDigests.push(summary); },
			// Surface the jittered re-registration plan from a delivered rotation pre-announce / hard rotation.
			rejoinJitter: createRejoinJitter({ capPromote: DEFAULT_CAP_PROMOTE_FAST, random: this.deterministicRandom() }),
			onRotation: (notice): void => { handle.rotationNotices.push(notice); scheduler.schedule(notice); },
		});
		handle.manager = manager;

		handle.registration = await manager.register();
		c.subscribers.push(handle);
		return handle;
	}

	/**
	 * Commit `count` transactions to `collection` through the real `StorageRepo` → change-bridge →
	 * origination path, then fan the originated notifications out to current-tail subscribers. Returns the
	 * new current revision. Each commit pre-signs a **real** threshold {@link CommitCert} with the tail
	 * cohort's Ed25519 keys (the bridge's synchronous extractor resolves it by `actionId`).
	 */
	async commit(collection: string, count = 1): Promise<number> {
		const c = this.collection(collection);
		for (let i = 0; i < count; i++) {
			const rev = c.rev + 1;
			const actionId = `rx-${c.collectionIdB64}-${rev}-${this.corr++}`;
			const blockId = `${c.name}-blk-${c.blockSeq++}`;
			// Anticipatory warm-up / block-filling: the filling commit carries the rotation pre-announce.
			const signal = c.fillTracker.onCommit();
			if (signal.kind === "filling") {
				const nextTail = utf8.encode(`${c.name}:tail-${rev}`);
				c.rotationHint = buildRotationHint(bytesToB64url(nextTail), rev);
			}
			const cert = await this.buildTailCert(c, rev);
			c.certByAction.set(actionId, cert);
			await c.repo.pend({ actionId: actionId as ActionId, transforms: this.insertTransforms(blockId, c.collectionIdB64), policy: "c" });
			const result = await c.repo.commit({ actionId: actionId as ActionId, blockIds: [blockId as BlockId], tailId: blockId as BlockId, rev });
			if (!result.success) {
				throw new Error(`reactivity mesh: commit failed for ${collection} rev ${rev}`);
			}
			c.rev = rev;
			// The pre-announce is one-shot: it rode the filling notification; clear it for subsequent commits.
			c.rotationHint = undefined;
		}
		await this.drainFanOut(c);
		return c.rev;
	}

	/** Build a real threshold commit cert: every tail-cohort member signs `utf8(commitHash + ":approve")`. */
	private async buildTailCert(c: CollectionState, rev: number): Promise<CommitCert> {
		const commitHash = `${c.collectionIdB64}:${rev}`;
		const signedPayload = utf8.encode(`${commitHash}:approve`);
		const commits: Record<string, Signature> = {};
		for (const m of c.tailCohort) {
			const sig = await (m.key as PrivateKey).sign(signedPayload);
			commits[m.idStr] = { type: "approve", signature: bytesToB64url(sig) };
		}
		const record: ClusterRecord = {
			messageHash: `mh-${commitHash}`,
			message: { operations: [{ get: { blockIds: [] } }], expiration: this.vtime + 30_000 },
			peers: this.clusterPeers(c.tailCohort),
			promises: {},
			commits,
		};
		return buildCommitCert(record, this.minSigs, signedPayload);
	}

	private clusterPeers(cohort: readonly Member[]): ClusterPeers {
		const peers: ClusterPeers = {};
		for (const m of cohort) {
			peers[m.idStr] = { multiaddrs: ["/ip4/127.0.0.1/tcp/8000"], publicKey: bytesToB64url(m.peerId.publicKey!.raw) };
		}
		return peers;
	}

	private insertTransforms(blockId: string, collectionId: string): Transforms {
		const block: IBlock = { header: { id: blockId as BlockId, type: "test", collectionId: collectionId as BlockId } };
		return { inserts: { [blockId]: block }, updates: {}, deletes: [] };
	}

	/**
	 * Run the originated notifications through the real forwarder receive path (populating the tail replay
	 * ring + rolling checkpoint + dedupe), then fan each out to every current-tail subscriber via its real
	 * per-subscriber bounded queue. A subscriber with `autoDrain` drains immediately; a slow subscriber's
	 * queue accumulates (drop-oldest under pressure) until it is woken.
	 */
	private async drainFanOut(c: CollectionState): Promise<void> {
		const notifs = c.emitQueue.splice(0, c.emitQueue.length);
		const tailB64 = bytesToB64url(c.tailId);
		for (const n of notifs) {
			// Forwarder receive: verify (real) → dedupe → append to the replay ring (and roll the checkpoint).
			await c.forwarder.receive(n, this.vtime);
			for (const s of c.subscribers) {
				if (s.attachedTailB64 !== tailB64 || s.asleep) {
					continue;
				}
				c.pushState.perSubscriberQueue.enqueue(s.subId, n);
				if (s.autoDrain) {
					await this.drainSubscriber(s);
				}
			}
		}
	}

	/** Drain a subscriber's bounded queue (FIFO) through the real manager delivery path. */
	private async drainSubscriber(s: SubscriptionHandle): Promise<void> {
		const c = this.collection(s.collectionName);
		const queue = c.pushState.perSubscriberQueue.peekQueue(s.subId);
		if (queue === undefined) {
			return;
		}
		for (const n of queue.drain()) {
			await s.manager.onNotification(n);
		}
	}

	/** Wake a slow subscriber: drain its accumulated (drop-oldest) queue through the delivery path. */
	async wakeSubscriber(s: SubscriptionHandle): Promise<void> {
		await this.drainSubscriber(s);
	}

	/** Put a subscriber to sleep: fan-out skips it (its tail replay buffer still fills) until it resumes. */
	sleepSubscriber(s: SubscriptionHandle): void {
		s.asleep = true;
	}

	/** The drop counter on a subscriber's bounded queue (drop-oldest under backpressure). */
	droppedFor(s: SubscriptionHandle): number {
		const c = this.collection(s.collectionName);
		return c.pushState.perSubscriberQueue.peekQueue(s.subId)?.dropped ?? 0;
	}

	/** Drive the manager's real `resume()` (one `ResumeV1` → `serveResume` → `applyResumeReply`). */
	async resume(s: SubscriptionHandle): Promise<ResumeApplyOutcome> {
		s.asleep = false;
		return s.manager.resume();
	}

	/**
	 * The re-registration move the scheduler fires on a rotation notice: re-attach the subscriber under the
	 * rotated tail so subsequent fan-out targets it. The production factory builds a *fresh* manager under
	 * `plan.newTopicId`; the harness keeps the same manager (its `lastRevision` is already contiguous and its
	 * `rotationHandledFor` guard dedupes the new-tail deliveries' re-detection), so re-attaching the existing
	 * subscriber is the equivalent move with no gap.
	 */
	private reAttachToNewTail(s: SubscriptionHandle, plan: ReRegistrationPlan): void {
		const c = this.collection(s.collectionName);
		s.attachedTailB64 = bytesToB64url(plan.newTailId);
		// Defensive: the plan's successor must be the collection's current tail (single-rotation harness model).
		if (s.attachedTailB64 !== bytesToB64url(c.tailId)) {
			s.attachedTailB64 = bytesToB64url(c.tailId);
		}
	}

	/**
	 * Rotate a collection's tail: advance `tailId` → new `topicId`/coord/cohort, re-establish the new cohort
	 * (re-seed willingness so a post-rotation subscribe can register), re-cache the tail cert, rebuild the tail
	 * `PushState`, fold the outgoing ring into a handoff checkpoint onto the new tail, and plan the jittered
	 * re-registration wave bounded by `cap_promote_fast`. Async because re-forming the new cohort is (the real
	 * willingness convergence). With `{ autoReattach: false }` it instead models the running node's
	 * `markRotated` (drain gate) so subscribers move via the recover-redirect path. Models §Tail rotation steps 2–5.
	 */
	async rotateTail(collection: string, opts: RotateTailOptions = {}): Promise<RotationResult> {
		const c = this.collection(collection);
		const autoReattach = opts.autoReattach ?? true;
		const rotationRevision = c.rev;
		// Pin the rotated tail's routed primary to a Core node too (Edge nodes decline a T3 cold-start); a
		// no-op for the all-Core rotation suites, matching the initial-tail pinning in `registerCollection`.
		const newTailId = this.pinTailToCore(`${c.name}:tail-${rotationRevision}`);
		const newTailIdB64 = bytesToB64url(newTailId);
		const oldTailB64 = bytesToB64url(c.tailId);

		// Buffer-to-checkpoint handoff — the ONLY state migrated across a rotation (§Tail rotation step 5).
		const handoff = buildRotationHandoffCheckpoint(c.pushState, { rotationRevision });

		// Active subscribers re-register under the new tree, carrying their lastRevision (continuity).
		const live = c.subscribers.filter((s) => s.attachedTailB64 === oldTailB64);
		const jitter = createRejoinJitter({ capPromote: DEFAULT_CAP_PROMOTE_FAST, random: this.deterministicRandom() });
		const plans = planReRegistrationWave({
			hint: { newTailId: newTailIdB64 },
			subscribers: live.map((s) => ({ lastRevision: s.manager.lastRevision })),
			now: this.vtime,
			jitter,
		});

		// Roll the topic to the new tail.
		c.tailId = newTailId;
		c.topicId = reactivityTopicId(newTailId);
		c.coord0 = addressing.coord0(c.topicId);
		c.tailCohort = this.cohortMembersAround(c.coord0);
		// Re-establish the new tail's cohort (re-seed willingness) so a subscriber can register under it after the
		// rotation — the new tree forming, modeled deterministically (the real cohort-topic willingness convergence).
		c.setup = await setupTopic(this.mesh, c.topicId);
		this.cacheTailCert(c);
		c.pushState = this.makePushState(c.collectionIdB64, c.topicId, c.tailId, c.w, c.wCheckpoint, c.queueMax, c.deltaMaxBytes);
		c.forwarder = createReactivityForwarder({ state: c.pushState, verifier: this.notificationVerifierFor(c.originationService) });
		if (handoff !== undefined) {
			applyRotationHandoff(c.pushState, handoff);
		}

		if (autoReattach) {
			// Re-attach the live subscribers under the new tail so subsequent fan-out targets them (the
			// continuity/handoff model — subscribers migrate directly, no redirect involved).
			for (const s of live) {
				s.attachedTailB64 = newTailIdB64;
			}
		} else {
			// Transport-driven: model `markRotated` by arming the outgoing tail's drain gate. Live subscribers
			// stay on the old tail until each resumes, gets the `kind:"rotated"` redirect, and re-attaches via its
			// own onRotation → scheduler → reRegister path (§Tail rotation step 2–3).
			c.rotationGate = new TailDrainGate({ rotatedAt: this.vtime, newTailId: newTailIdB64, effectiveAtRevision: rotationRevision + 1 });
			c.rotatedFromTailB64 = oldTailB64;
		}

		return {
			newTailId,
			newTailIdB64,
			rotationRevision,
			plans,
			peakWindowArrivals: this.peakWindowArrivals(plans),
			...(handoff?.checkpoint === undefined ? {} : { handoff: handoff.checkpoint }),
		};
	}

	/** Peak re-registration arrivals in any `T_rejoin_jitter`-long window of a planned wave. */
	private peakWindowArrivals(plans: readonly ReRegistrationPlan[]): number {
		if (plans.length === 0) {
			return 0;
		}
		const fireAts = plans.map((p) => p.fireAt).sort((a, b) => a - b);
		const window = T_REJOIN_JITTER_MS; // the same jitter span `createRejoinJitter` spreads the wave over
		let peak = 0;
		for (let i = 0; i < fireAts.length; i++) {
			let j = i;
			while (j < fireAts.length && fireAts[j]! - fireAts[i]! < window) {
				j++;
			}
			peak = Math.max(peak, j - i);
		}
		return peak;
	}

	/** A deterministic pseudo-random in [0,1) so the jitter wave is reproducible across runs. */
	private deterministicRandom(): () => number {
		let seed = 0x2545f491;
		return (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
	}

	/**
	 * The tail cohort `PushState` for a collection (its live replay ring / checkpoint / backpressure). Exposed
	 * so a suite can assert the replay/dedupe/partition state directly.
	 */
	pushStateOf(collection: string): PushState {
		return this.collection(collection).pushState;
	}

	/** A real forwarder receive over the tail `PushState` — used to model a forwarder-hop / partition replay. */
	async forwarderReceive(collection: string, n: NotificationV1): Promise<ForwardDecision> {
		const c = this.collection(collection);
		return c.forwarder.receive(n, this.vtime);
	}

	async stop(): Promise<void> {
		// Tear down every subscriber's re-registration scheduler (drops pending virtual timers + the idempotence
		// ledger) before stopping the mesh.
		for (const c of this.collections.values()) {
			for (const s of c.subscribers) {
				s.scheduler?.stop();
			}
		}
		await this.mesh.stop();
	}
}

/** Build and start a reactivity integration mesh. */
export async function buildReactivityMesh(opts: ReactivityMeshOptions = {}): Promise<ReactivityMesh> {
	return ReactivityMesh.build(opts);
}
