/**
 * Matchmaking **mock-transport mesh harness** — the in-process, many-logical-node substrate for the
 * matchmaking *integration* tier (`docs/matchmaking.md`), layered on the cohort-topic mesh harness
 * ({@link import("./cohort-topic-mesh-harness.js")}) rather than forking it. It drives the **real**
 * provider manager, the **real** cohort-side `QueryV1` handler, and the **real** seeker walk
 * client over a network of real-Ed25519-keyed {@link CohortTopicHost}s — so a matchmaking flow is
 * exercised end-to-end (register → cohort store → query → seeker re-validation) without a live libp2p
 * stack.
 *
 * **What is real vs. modeled.** Provider registration rides the real {@link MatchmakingProviderManager}
 * → `CohortTopicService.register` walk; the seeker walk drives the real {@link SeekerWalkClient} whose
 * per-tier registrations carry the real {@link MatchmakingSeeker} payload and are dispatched through the
 * real cohort engines (the one-shot `MatchmakingSeekerManager` wrapper is not on this path). Either way
 * records land in the real cohort store and carry real peer-key signatures the seeker re-validates with
 * the real `verifyPeerSig`. The cohort `topicTraffic` barometer, however, is
 * **modeled** ({@link MatchmakingMesh.setTraffic}): the hang-out decision is driven by an injected
 * `arrivalsPerMin` / `queriesPerMin` regime because generating a real arrival *rate* (90/min …)
 * deterministically over a virtual clock is infeasible — the same posture the design simulator takes.
 * The decision *math* against that regime is the db-core `seeker-walk.spec.ts` floor; this harness
 * proves the regime drives the real walk over real records.
 *
 * **Single-tier-0 reach (honest).** The underlying cohort-topic substrate serves a single tier-0 cohort
 * (multi-tier promotion to a *serving* tier-`d ≥ 1` cohort, and membership-rotation primary handoff, are
 * the cohort-topic follow-ons `cohort-topic-followon-derivation` / `cohort-topic-parent-child-link` /
 * rotation-handoff). A seeker walk therefore always falls through tiers `d_max…1` as `NoState` and is
 * `Accepted` at the root — the cold/sparse-walk-to-root shape is fully real; "hot topic, a deep tier
 * suffices" (an `Accepted` above the root) is gated on that follow-on and is tagged-unimplemented in the
 * mesh suites, not faked here.
 *
 * **Arrival push.** Every member runs the real cohort-side {@link ArrivalPushDriver}, subscribed to its real
 * host's `onRecordAdded`, and the real seeker-side {@link ArrivalPushReceiver}. A driver's delivery is
 * in-process: the seeker's contact hint is resolved with the production {@link contactHintTarget} and the frame
 * handed to that member's receiver, so no mock libp2p protocol is involved (the same way {@link query} is
 * served in process). Every resolved delivery is recorded in {@link MatchmakingMesh.pushSends}.
 *
 * **Virtual time.** Like the cohort harness this is not a wall-clock simulator. Each {@link seek} runs on its
 * own virtual clock whose sleep advances `now` at once, so a 10 s hang-out resolves instantly and
 * deterministically. A walk that has to interleave with arrivals — every push-path walk, and a poll-path walk
 * compared against one — runs instead on the mesh's shared virtual time ({@link MatchmakingMesh.startSeek}),
 * which also drives the drivers' coalescing timers and the receivers' push waits; nothing on it moves until
 * the test calls {@link MatchmakingMesh.advance}. Cohort TTL sweeps are driven explicitly via {@link sweepTopic}.
 */

import { Tier, providerTtlForProfile } from '@optimystic/db-core';
import {
	DEFAULT_HANG_OUT_CONFIG,
	MatchmakingProvider,
	MatchmakingSeeker,
	matchTopicId,
	coreProfile,
	edgeProfile,
	bytesToB64url,
	registerSigningPayload,
	verifyProviderEntry,
	type CapabilityFilter,
	type EntrySigVerifier,
	type MatchTopicKind,
	type NodeProfile,
	type ProviderEntryV1,
	type QueryReplyV1,
	type QueryV1,
	type RegisterV1,
	type RegistrationRecord,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import type { CohortTopicHost, CoordEngine } from '../cohort-topic/host.js';
import { signPeer, verifyPeerSig } from '../cohort-topic/peer-sig.js';
import { ArrivalPushDriver } from '../matchmaking/arrival-push-driver.js';
import { ArrivalPushReceiver } from '../matchmaking/arrival-push-receiver.js';
import { contactHintTarget } from '../matchmaking/arrival-push-send.js';
import { MatchmakingProviderManager } from '../matchmaking/provider-manager.js';
import { handleMatchmakingQuery } from '../matchmaking/query-handler.js';
import { SeekerWalkClient, type SeekerProbeReply, type SeekerPushChannel, type SeekerWalkTransport } from '../matchmaking/seeker-walk-client.js';
import {
	addressing,
	buildMesh,
	delay,
	makeMembers,
	setupTopic,
	slots,
	type CohortMesh,
	type Member,
	type MeshOptions,
} from './cohort-topic-mesh-harness.js';

export { addressing, delay };
export type { Member };

/** A matchmaking topic reference resolved to a 32-byte anchor `topicId = H(kind ‖ label ‖ "match")`. */
export interface MatchTopicRef {
	readonly kind: MatchTopicKind;
	readonly label: string;
}

/** A live provider registration in the mesh — the manager + the node it registered from. */
export interface ProviderHandle {
	readonly nodeIndex: number;
	readonly member: Member;
	readonly topicId: Uint8Array;
	readonly manager: MatchmakingProviderManager;
	readonly provider: MatchmakingProvider;
}

/** The result of a {@link MatchmakingMesh.seek} — the seeker walk outcome plus the harness walk trace. */
export interface MatchResult {
	/** Matched, re-validated, deduped providers (may be `< wantCount`). */
	readonly providers: ProviderEntryV1[];
	/** Whether `wantCount` was met. */
	readonly metWantCount: boolean;
	/** The tree tier the walk terminated at. */
	readonly terminalTier: number;
	/** Total register hops issued (probes + escalations). */
	readonly hops: number;
	/** Max `topicTraffic.childCohortCount` seen across `Accepted` replies (hot-topic / sweep-escalation signal). */
	readonly maxChildCohortCount: number;
	/** Distinct tree tiers the walk register-probed (the walk depth). */
	readonly tiersVisited: number;
	/** Total virtual time the seeker spent hanging out (sum of poll sleeps; elapsed virtual time for {@link MatchmakingMesh.startSeek}). */
	readonly hungOutMs: number;
	/** `QueryV1`s the walk issued, the immediate one at each accepting tier included. */
	readonly queries: number;
}

/** Per-seek tuning (start tier, patience, filter, push opt). */
export interface SeekOptions {
	/** Walk start tier `d_max`. Default {@link MatchmakingMesh.dMax}. */
	readonly dMax?: number;
	/** Total patience budget (ms). Default 10_000. */
	readonly patienceMs?: number;
	/** Capability filter, re-applied seeker-side. */
	readonly filter?: CapabilityFilter;
	/** Hang-out requery cadence (ms); forwarded to the walk config. */
	readonly requeryIntervalMs?: number;
}

/** Per-seek tuning for a walk on the mesh's shared virtual time ({@link MatchmakingMesh.startSeek}). */
export interface LiveSeekOptions extends SeekOptions {
	/** Register the walk for arrival pushes on its member's receiver (the push path). Default: the poll path. */
	readonly pushOnArrival?: boolean;
}

/** A walk running on the mesh's shared virtual time. */
export interface SeekHandle {
	/** The walk's outcome, once it ends. */
	readonly done: Promise<MatchResult>;
	/** Whether the walk is parked on virtual time — a hang-out sleep or a push wait — so it moves only on {@link MatchmakingMesh.advance} or a push. */
	parked(): boolean;
}

/** One arrival push a member's driver delivered in process: the pushing member and the seeker it reached (peer-id strings). */
export interface PushSend {
	readonly from: string;
	readonly to: string;
}

/** Construction inputs for a {@link MatchmakingMesh}. */
export interface MatchmakingMeshOptions {
	/** Node count. Default 16 (one production-shaped cohort: `wantK = 16`). */
	readonly nodeCount?: number;
	/** Cohort size `wantK`. Default `min(nodeCount, 16)`. */
	readonly wantK?: number;
	/** Threshold signers. Default `wantK - 2`. */
	readonly minSigs?: number;
	/** FRET network-size estimate (drives the default `d_max`). Default 256 → `d_max = 1`. */
	readonly sizeEstimate?: number;
	/** Per-node profile by index (Edge nodes get the shorter provider TTL). Default all Core. */
	readonly profiles?: readonly ('edge' | 'core')[];
}

/** A virtual clock whose `sleep` advances `now` and accumulates total slept time (the hang-out budget). */
function virtualClock(): { clock: () => number; sleep: (ms: number) => Promise<void>; slept: () => number } {
	let now = 0;
	let totalSlept = 0;
	return {
		clock: (): number => now,
		sleep: (ms: number): Promise<void> => {
			now += ms;
			totalSlept += ms;
			return Promise.resolve();
		},
		slept: (): number => totalSlept,
	};
}

/** Real time {@link VirtualTime.advance} gives the work a fired timer starts (a push's sign → deliver → ack, a walk's next query). */
const SETTLE_MS = 10;

/** A one-shot timer on {@link VirtualTime}. */
interface VirtualTimer {
	readonly id: number;
	readonly due: number;
	readonly fn: () => void;
}

/** The mesh's shared virtual time: one-shot timers that fire only when {@link advance} reaches them, in due order. */
class VirtualTime {
	private current = 0;
	private nextId = 0;
	private readonly timers = new Map<number, VirtualTimer>();

	readonly now = (): number => this.current;

	readonly setTimer = (fn: () => void, ms: number): (() => void) => {
		const id = this.nextId++;
		this.timers.set(id, { id, due: this.current + Math.max(0, ms), fn });
		return (): void => {
			this.timers.delete(id);
		};
	};

	readonly sleep = (ms: number): Promise<void> => new Promise((resolve) => {
		this.setTimer(resolve, ms);
	});

	/** Move time forward `ms`, firing each timer that falls due — including ones a fired timer arms — and letting its work settle. */
	async advance(ms: number): Promise<void> {
		const target = this.current + ms;
		for (let next = this.nextDue(target); next !== undefined; next = this.nextDue(target)) {
			this.timers.delete(next.id);
			this.current = next.due;
			next.fn();
			await delay(SETTLE_MS);
		}
		this.current = target;
	}

	/** The earliest timer due at or before `limit`; ties go to the one armed first (map order is arming order). */
	private nextDue(limit: number): VirtualTimer | undefined {
		let earliest: VirtualTimer | undefined;
		for (const timer of this.timers.values()) {
			if (timer.due <= limit && (earliest === undefined || timer.due < earliest.due)) {
				earliest = timer;
			}
		}
		return earliest;
	}
}

/** One member's arrival-push pair: its receiver, and its driver with the host subscription that feeds it. */
interface PushPeer {
	readonly receiver: ArrivalPushReceiver;
	readonly driver: ArrivalPushDriver;
	readonly unsubscribe: () => void;
}

/** A walk's clock, sleep and hang-out measure, and — on the push path — how its push channel is wrapped. */
interface WalkTiming {
	readonly clock: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly hungOutMs: () => number;
	readonly pushes?: (channel: SeekerPushChannel) => SeekerPushChannel;
}

/** What a walk transport records as the walk runs. */
interface WalkTrace {
	readonly tiersVisited: Set<number>;
	queries: number;
}

/**
 * The matchmaking integration mesh. Build with {@link buildMatchmakingMesh}; drive providers/seekers with
 * {@link provide} / {@link seek} / {@link query}; model the hang-out regime with {@link setTraffic}.
 */
export class MatchmakingMesh {
	/** The modeled per-topic traffic regime (keyed by base64url topic id); absent ⇒ a quiet default. */
	private readonly traffic = new Map<string, TopicTrafficV1>();
	/** Monotonic correlation-id counter so each routed register/probe is replay-distinct. */
	private corr = 0;
	/** The shared virtual time {@link startSeek} walks and the arrival-push timers run on. */
	private readonly time = new VirtualTime();
	/** Each member's arrival-push pair, by member index. */
	private readonly pushPeers: PushPeer[];
	/** Every arrival push a member's driver delivered, in delivery order. */
	readonly pushSends: PushSend[] = [];

	private constructor(
		readonly mesh: CohortMesh,
		readonly members: Member[],
		private readonly sizeEstimate: number,
		private readonly profiles: readonly ('edge' | 'core')[],
	) {
		this.pushPeers = mesh.nodes.map((node) => this.attachArrivalPush(node.member, node.host));
	}

	/** Give `member` a receiver and a driver subscribed to its host, both on the shared virtual time. */
	private attachArrivalPush(member: Member, host: CohortTopicHost): PushPeer {
		const driver = new ArrivalPushDriver({
			selfPeerId: member.idStr,
			slots,
			sign: async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(member.key, payload)),
			send: (contactHint: string, frame: Uint8Array): Promise<Uint8Array | undefined> => this.deliverPush(member, contactHint, frame),
			setTimer: this.time.setTimer,
		});
		return {
			receiver: new ArrivalPushReceiver({ setTimer: this.time.setTimer }),
			driver,
			unsubscribe: host.onRecordAdded(driver.onRecordAdded),
		};
	}

	/** The in-process push delivery: the member the hint names takes the frame on its receiver, as sent by `from`. */
	private async deliverPush(from: Member, contactHint: string, frame: Uint8Array): Promise<Uint8Array | undefined> {
		const target = contactHintTarget(contactHint);
		const index = target === undefined ? -1 : this.members.findIndex((m) => m.idStr === target.peerId.toString());
		if (index < 0) {
			return undefined;
		}
		this.pushSends.push({ from: from.idStr, to: this.members[index]!.idStr });
		return this.pushPeers[index]!.receiver.receive(frame, from.idStr);
	}

	/**
	 * Move the shared virtual time forward `ms`: due coalescing timers flush their pushes, and {@link startSeek}
	 * walks wake from their sleeps and push waits.
	 */
	advance(ms: number): Promise<void> {
		return this.time.advance(ms);
	}

	/** Stand up an N-node matchmaking mesh and start every host. */
	static async build(opts: MatchmakingMeshOptions = {}): Promise<MatchmakingMesh> {
		const nodeCount = opts.nodeCount ?? 16;
		const wantK = opts.wantK ?? Math.min(nodeCount, 16);
		const minSigs = opts.minSigs ?? Math.max(1, wantK - 2);
		const sizeEstimate = opts.sizeEstimate ?? 256;
		const members = await makeMembers(nodeCount);
		const meshOpts: MeshOptions = {
			wantK,
			minSigs,
			sizeEstimate,
			// Pin `cap_promote` very high so the topic's tree stays a single tier-0 cohort for the life of a
			// test. Without this, the test artifact of registering several providers within a few
			// milliseconds spikes the growth *slope* and trips the pre-promotion predictor (it extrapolates
			// crossing `cap_promote` within the 30 s lookahead), promoting the cohort and bouncing later
			// registrations in a `promoted`→`no_state` walk loop. Real registrations are spread over time, so
			// this never fires in production; multi-tier promotion is the cohort-topic e2e's concern and the
			// matchmaking scenarios that need a *serving* tier-`d ≥ 1` cohort are tagged-unimplemented here.
			capPromote: 1_000_000,
			// A generous register ceiling: the harness re-probes a cohort across many seeks; the default
			// 4/min would rate-limit repeated probes from one node. Leaving `bootstrapEvidence`/`reputation`
			// unset keeps cold-root instantiation permissive (the policy is "configured" only when one of
			// those is supplied — see `createBootstrapEvidencePolicy`).
			//
			// `powDifficultyBits: 0` disables the cold-start proof-of-work cost. Providers/seekers register at
			// the matchmaking tier (≥ T2), so the participant-side bootstrap-evidence builder otherwise mints a
			// PoW puzzle (default 20 bits ≈ 1 M hashes) on every register/re-probe — the dominant cost in this
			// mesh under full-suite load (~25-30 s sweep/walk cases run right at the mocha ceiling). Since the
			// cohort policy is unconfigured (above) the evidence is never required, so minting it is pure waste;
			// `bits: 0` solves on the first nonce (the documented test escape hatch in `meetsDifficulty`).
			antiDos: { rateLimiter: { ratePerWindow: 1_000_000 }, powDifficultyBits: 0 },
			...(opts.profiles === undefined ? {} : { profiles: opts.profiles }),
		};
		const mesh = await buildMesh(members, meshOpts);
		const profiles = Array.from({ length: nodeCount }, (_v, i) => opts.profiles?.[i] ?? 'core');
		return new MatchmakingMesh(mesh, members, sizeEstimate, profiles);
	}

	/** The default walk start tier `d_max = ⌈log_F(sizeEstimate)⌉ − 1` (clamped to ≥ 0). */
	get dMax(): number {
		return Math.max(0, Math.ceil(Math.log(this.sizeEstimate) / Math.log(16)) - 1);
	}

	/** The seeker-side per-entry verifier: re-validate each forwarded entry's `registrationSig` for real. */
	readonly verifyEntry: EntrySigVerifier = (participantId, payload, signature) =>
		verifyPeerSig(participantId, payload, signature);

	private node(index: number): CohortTopicHost {
		return this.mesh.nodes[index]!.host;
	}

	private profileOf(index: number): NodeProfile {
		return this.profiles[index] === 'edge' ? edgeProfile() : coreProfile();
	}

	/** Resolve `(kind, label)` to its anchor. */
	topicId(kind: MatchTopicKind, label: string): Uint8Array {
		return matchTopicId(kind, label);
	}

	/**
	 * Instantiate the topic's tier-0 cohort and seed its willingness quorum so registrations are admitted
	 * (mirrors {@link setupTopic}). Call once per topic before {@link provide} / {@link seek}.
	 */
	async registerTopic(kind: MatchTopicKind, label: string): Promise<void> {
		await setupTopic(this.mesh, this.topicId(kind, label));
	}

	/** The coord-0 cohort engine for a topic (the node nearest `coord_0`, where tier-0 registrations land). */
	private rootEngine(topicId: Uint8Array): { engine: CoordEngine; signer: (p: Uint8Array) => Promise<string> } {
		const coord0 = addressing.coord0(topicId);
		const node = this.mesh.nodeNearest(coord0);
		const engine = node.host.registry.forCoord(coord0, 0 as Tier, this.members[0]!.bytes);
		const signer = async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(node.member.key, payload));
		return { engine, signer };
	}

	/** This cohort's locally-held provider/seeker registration records for a topic (the query-handler read). */
	cohortRecords(kind: MatchTopicKind, label: string): readonly RegistrationRecord[] {
		return this.rootEngine(this.topicId(kind, label)).engine.records(this.topicId(kind, label));
	}

	/** The topic's tier-0 cohort epoch (the aggregate-count / query signing-image input). */
	cohortEpochFor(kind: MatchTopicKind, label: string): Uint8Array {
		return this.rootEngine(this.topicId(kind, label)).engine.cohort().cohortEpoch;
	}

	/** Serve the topic's tier-0 provider set as a flat `ProviderEntryV1[]` (the sweep `queryShard` read). */
	async providerEntries(requesterIndex: number, kind: MatchTopicKind, label: string, filter?: CapabilityFilter): Promise<readonly ProviderEntryV1[]> {
		return (await this.query(requesterIndex, kind, label, filter)).providers ?? [];
	}

	/**
	 * Register node `nodeIndex` as a provider at `(kind, label)` via the real provider manager (cohort-topic
	 * tier T2). The record lands in the topic's tier-0 cohort store with the provider's real peer-key
	 * signature. Returns a handle whose manager drives renew / setCapacity / signalFull / withdraw.
	 */
	async provide(nodeIndex: number, kind: MatchTopicKind, label: string, capabilities: readonly string[], capacityBudget: number, contactHint?: string): Promise<ProviderHandle> {
		const member = this.members[nodeIndex]!;
		const topicId = this.topicId(kind, label);
		const provider = new MatchmakingProvider({
			topicId,
			capabilities,
			capacityBudget,
			contactHint: contactHint ?? `/ip4/127.0.0.1/tcp/4001/p2p/${member.idStr}`,
			sign: async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(member.key, payload)),
		});
		const manager = new MatchmakingProviderManager({ service: this.node(nodeIndex).service, provider, profile: this.profileOf(nodeIndex) });
		await manager.register();
		return { nodeIndex, member, topicId, manager, provider };
	}

	/** Replicate the topic's tier-0 records to the rest of the cohort via one gossip round. */
	async gossipReplicate(kind: MatchTopicKind, label: string): Promise<void> {
		await this.rootEngine(this.topicId(kind, label)).engine.gossipRound(Date.now());
		await delay(20);
	}

	/**
	 * Sweep the topic's tier-0 cohort at `now` (TTL eviction). Use after a provider {@link ProviderHandle}
	 * stops renewing (withdraw) to make the record's expiry observable to a subsequent {@link query}.
	 */
	sweepTopic(kind: MatchTopicKind, label: string, now: number): void {
		this.rootEngine(this.topicId(kind, label)).engine.engine.sweepStale(now);
	}

	/** A provider's profile TTL (ms) — the wall-clock after which an un-renewed record is sweepable. */
	providerTtlMs(nodeIndex: number): number {
		return providerTtlForProfile(this.profileOf(nodeIndex));
	}

	/**
	 * Model the hang-out regime for a topic: the `topicTraffic` the cohort attaches to its `Accepted`
	 * probe reply and query reply (`docs/matchmaking.md` §Hang-out vs. continue — Decision inputs). The
	 * provider/seeker *population* is real; only the arrival/query *rates* are injected.
	 */
	setTraffic(topicId: Uint8Array, traffic: Partial<TopicTrafficV1>): void {
		this.traffic.set(bytesToB64url(topicId), {
			windowSeconds: 30,
			arrivalsPerMin: 0,
			queriesPerMin: 0,
			directParticipants: 0,
			childCohortCount: 0,
			...traffic,
		});
	}

	/** The modeled regime for a topic, or a quiet default whose `directParticipants` reflects the real count. */
	private trafficFor(topicId: Uint8Array, realDirectParticipants: number): TopicTrafficV1 {
		const modeled = this.traffic.get(bytesToB64url(topicId));
		if (modeled !== undefined) {
			return modeled;
		}
		return { windowSeconds: 30, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: realDirectParticipants, childCohortCount: 0 };
	}

	/** Build a one-shot `QueryV1` against the tier-0 cohort and serve it from the real cohort store. */
	async query(requesterIndex: number, kind: MatchTopicKind, label: string, filter?: CapabilityFilter, opts?: { includeSeekers?: boolean; limit?: number }): Promise<QueryReplyV1> {
		const topicId = this.topicId(kind, label);
		return this.queryCohort(topicId, this.members[requesterIndex]!, filter, opts);
	}

	/** Serve a `QueryV1` from the topic's tier-0 cohort store (real records, real primary signature). */
	private async queryCohort(topicId: Uint8Array, requester: Member, filter?: CapabilityFilter, opts?: { includeSeekers?: boolean; limit?: number }): Promise<QueryReplyV1> {
		const { engine, signer } = this.rootEngine(topicId);
		const records = engine.records(topicId);
		const includeSeekers = opts?.includeSeekers ?? false;
		const query: QueryV1 = {
			v: 1,
			topicId: bytesToB64url(topicId),
			includeProviders: true,
			includeSeekers,
			limit: opts?.limit ?? 256,
			requesterId: requester.idStr,
			timestamp: Date.now(),
			signature: 'AA',
			...(filter !== undefined ? { filter } : {}),
		};
		const directParticipants = engine.records(topicId).filter((r) => r.appState !== undefined).length;
		return handleMatchmakingQuery(query, {
			records,
			topicTraffic: this.trafficFor(topicId, directParticipants),
			cohortEpoch: engine.cohort().cohortEpoch,
			sign: signer,
		});
	}

	/** Build a signed seeker `RegisterV1` at `treeTier` carrying the seeker app payload (op-tier T2). */
	private async buildSeekerRegister(seeker: Member, topicId: Uint8Array, treeTier: number, appPayload: Uint8Array): Promise<RegisterV1> {
		const body: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(topicId),
			tier: Tier.T2,
			treeTier,
			participantCoord: bytesToB64url(seeker.bytes),
			ttl: 10_000,
			// A tier-0 probe is the cold-root instantiation (bootstrap); a tier-`d>0` probe is a plain walk
			// step that falls through `NoState` on a cohort that does not serve the topic.
			bootstrap: treeTier === 0,
			timestamp: Date.now(),
			correlationId: bytesToB64url(new TextEncoder().encode(`mm-seek-${this.corr++}`)),
			appPayload: bytesToB64url(appPayload),
		};
		return { ...body, signature: bytesToB64url(await signPeer(seeker.key, registerSigningPayload(body))) };
	}

	/** Map a real `RegisterReplyV1` probe to the seeker walk's {@link SeekerProbeReply}, modeling the regime. */
	private toProbeReply(topicId: Uint8Array, reply: { result: SeekerProbeReply['result']; topicTraffic?: TopicTrafficV1; targetTier?: number }): SeekerProbeReply {
		const out: { result: SeekerProbeReply['result']; topicTraffic?: TopicTrafficV1; targetTier?: number } = { result: reply.result };
		if (reply.result === 'accepted' || reply.result === 'promoted') {
			const real = reply.topicTraffic;
			out.topicTraffic = this.traffic.get(bytesToB64url(topicId)) ?? real ?? { windowSeconds: 30, arrivalsPerMin: 0, queriesPerMin: 0, directParticipants: 0, childCohortCount: 0 };
		}
		if (reply.targetTier !== undefined) {
			out.targetTier = reply.targetTier;
		}
		return out as SeekerProbeReply;
	}

	/**
	 * The walk transport: real per-tier register probes + real cohort queries over the mesh. With
	 * `timing.pushes`, the seeker registers with `pushOnArrival` and the walk listens on its member's receiver.
	 */
	private buildWalkTransport(topicId: Uint8Array, seekerIndex: number, wantCount: number, filter: CapabilityFilter | undefined, trace: WalkTrace, timing: WalkTiming): SeekerWalkTransport {
		const seeker = this.members[seekerIndex]!;
		const seekerState = new MatchmakingSeeker({
			topicId,
			wantCount,
			contactHint: `/ip4/127.0.0.1/tcp/4002/p2p/${seeker.idStr}`,
			sign: async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(seeker.key, payload)),
			...(filter !== undefined ? { filter } : {}),
			...(timing.pushes !== undefined ? { pushOnArrival: true } : {}),
		});
		const subscription = timing.pushes === undefined
			? undefined
			: this.pushPeers[seekerIndex]!.receiver.subscribe(topicId, bytesToB64url(seekerState.correlationId));
		return {
			register: async (treeTier: number): Promise<SeekerProbeReply> => {
				trace.tiersVisited.add(treeTier);
				const coord = treeTier === 0 ? addressing.coord0(topicId) : addressing.coord(treeTier, seeker.bytes, topicId);
				const target = this.mesh.nodeNearest(coord);
				const engine = target.host.registry.forCoord(coord, treeTier as Tier, seeker.bytes);
				const now = Date.now();
				const reg = await this.buildSeekerRegister(seeker, topicId, treeTier, await seekerState.appPayloadBytes());
				const parentCoord = treeTier > 0 ? addressing.coord(treeTier - 1, seeker.bytes, topicId) : undefined;
				const reply = await engine.engine.handleRegister(reg, { followOn: false, treeTier, ...(parentCoord !== undefined ? { parentCoord } : {}) }, now);
				return this.toProbeReply(topicId, reply);
			},
			query: async (_treeTier: number): Promise<QueryReplyV1> => {
				trace.queries++;
				return this.queryCohort(topicId, seeker, filter);
			},
			renew: async (): Promise<void> => {
				// The hang-out keep-alive: a real seeker would renew its registration; the record already
				// lives in the cohort store for the seek's virtual duration, so this is a no-op touch.
			},
			withdraw: async (): Promise<void> => {
				// Polite escalation withdrawal (`RenewV1` TTL = 0) is an optimization; the brief seeker record
				// ages out by TTL. Single-tier-0 walks reach the root and never escalate past it.
			},
			...(subscription !== undefined && timing.pushes !== undefined ? { pushes: timing.pushes(subscription.channel) } : {}),
			close: async (): Promise<void> => {
				subscription?.unsubscribe();
			},
		};
	}

	/**
	 * Run the real seeker hang-out walk for node `seekerIndex` at `(kind, label)`. The walk uses a virtual
	 * clock (instant, deterministic); the hang-out decision is driven by the modeled {@link setTraffic}
	 * regime over the real cohort query results.
	 *
	 * Pick a seeker node that is **not** a provider at this topic — a seeker register and a provider
	 * register from the same node collide on `(topicId, participantId)` in the cohort store.
	 */
	async seek(seekerIndex: number, kind: MatchTopicKind, label: string, wantCount: number, opts: SeekOptions = {}): Promise<MatchResult> {
		const vt = virtualClock();
		return this.runWalk(seekerIndex, kind, label, wantCount, opts, { clock: vt.clock, sleep: vt.sleep, hungOutMs: vt.slept });
	}

	/**
	 * Start the real seeker walk on the mesh's shared virtual time and return at once. The walk registers and
	 * runs its immediate query, then parks on a hang-out sleep or — with `pushOnArrival` — on its member's push
	 * receiver, and moves on only when the test calls {@link advance} or a member's driver pushes to it. The seek
	 * to use whenever arrivals must land while the walk hangs out; the same seeker-index rule as {@link seek}.
	 */
	startSeek(seekerIndex: number, kind: MatchTopicKind, label: string, wantCount: number, opts: LiveSeekOptions = {}): SeekHandle {
		let parked = 0;
		const whileParked = async (wait: Promise<void>): Promise<void> => {
			parked++;
			try {
				await wait;
			} finally {
				parked--;
			}
		};
		const startedAt = this.time.now();
		const timing: WalkTiming = {
			clock: this.time.now,
			sleep: (ms: number): Promise<void> => whileParked(this.time.sleep(ms)),
			hungOutMs: (): number => this.time.now() - startedAt,
			...(opts.pushOnArrival === true
				? { pushes: (channel: SeekerPushChannel): SeekerPushChannel => ({ take: () => channel.take(), wait: (ms: number) => whileParked(channel.wait(ms)) }) }
				: {}),
		};
		return { done: this.runWalk(seekerIndex, kind, label, wantCount, opts, timing), parked: (): boolean => parked > 0 };
	}

	/** Run one seeker walk under `timing`. */
	private async runWalk(seekerIndex: number, kind: MatchTopicKind, label: string, wantCount: number, opts: SeekOptions, timing: WalkTiming): Promise<MatchResult> {
		const topicId = this.topicId(kind, label);
		const trace: WalkTrace = { tiersVisited: new Set<number>(), queries: 0 };
		const client = new SeekerWalkClient({
			transport: this.buildWalkTransport(topicId, seekerIndex, wantCount, opts.filter, trace, timing),
			topicId,
			wantCount,
			dMax: opts.dMax ?? this.dMax,
			patienceMs: opts.patienceMs ?? 10_000,
			verifyEntry: this.verifyEntry,
			clock: timing.clock,
			sleep: timing.sleep,
			...(opts.filter !== undefined ? { filter: opts.filter } : {}),
			...(opts.requeryIntervalMs !== undefined ? { config: { ...DEFAULT_HANG_OUT_CONFIG, requeryIntervalMs: opts.requeryIntervalMs } } : {}),
		});
		const result = await client.run();
		return {
			providers: result.providers,
			metWantCount: result.metWantCount,
			terminalTier: result.terminalTier,
			hops: result.hops,
			maxChildCohortCount: result.maxChildCohortCount,
			tiersVisited: trace.tiersVisited.size,
			hungOutMs: timing.hungOutMs(),
			queries: trace.queries,
		};
	}

	/** Project a {@link MatchResult}'s walk trace (`docs/matchmaking.md` §Worked example trace). */
	walkTrace(r: MatchResult): { tiersVisited: number; hungOutMs: number; matched: number } {
		return { tiersVisited: r.tiersVisited, hungOutMs: r.hungOutMs, matched: r.providers.length };
	}

	/** Re-validate a forwarded provider entry the way a seeker does (real `registrationSig` check). */
	verifyEntryFor(topicId: Uint8Array, entry: ProviderEntryV1): boolean {
		return verifyProviderEntry(topicId, entry, this.verifyEntry);
	}

	async stop(): Promise<void> {
		for (const peer of this.pushPeers) {
			peer.unsubscribe();
			peer.driver.stop();
		}
		await this.mesh.stop();
	}
}

/** Build and start a matchmaking integration mesh. */
export async function buildMatchmakingMesh(opts: MatchmakingMeshOptions = {}): Promise<MatchmakingMesh> {
	return MatchmakingMesh.build(opts);
}
