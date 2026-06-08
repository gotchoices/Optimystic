/**
 * Cohort-topic substrate — participant-facing service composition.
 *
 * This is the substrate's public contract to applications (`docs/cohort-topic.md` §Application
 * policies): given a `topicId` and a `tier`, reliably find a willing primary (or fail with a clear
 * back-off), keep a registration alive within its TTL, and verify cohort identity/membership. It is
 * the participant half of the substrate; the cohort half is {@link import("./member-engine.js").CohortMemberEngine}.
 *
 * The service is FRET-free: it drives the {@link ITopicRouter} (walk / register / direct-dial) and the
 * other db-core ports by injection. db-p2p binds those ports to FRET + libp2p and constructs the
 * service on the same node it runs the member engine on, so a node is simultaneously a participant and
 * a cohort member (`docs/cohort-topic.md` §FRET integration — all four protocols on one node).
 *
 * Composition wired here: {@link WalkEngine} (lookup / register), the `d_max` computer + tier
 * addressing, the participant-side {@link RenewalParticipant} (the `ttl/3` ping with crash-failover),
 * and the application integration hooks ({@link CohortGossipBus}, {@link MembershipVerifier}). The
 * cohort-side modules (willingness, promotion, traffic, store, membership publisher, anti-DoS) are
 * assembled by the member engine the FRET host wires into the `RouteAndMaybeAct` activity callback.
 */

import { createTierAddressing, type TierAddressing } from "./addressing.js";
import { makeDMaxComputer, type DMaxComputer } from "./dmax.js";
import { DEFAULT_FANOUT } from "./addressing.js";
import type { ISizeEstimator, ITopicRouter, IRingHash, RingCoord } from "./ports.js";
import { createWalkEngine, type RegisterMessageFactory, type WalkEngine, type WalkOutcome } from "./walk.js";
import { createRenewalParticipant, type RenewalParticipant, type RenewalParticipantTransport, type UnsignedRenew } from "./registration/renewal.js";
import type { RegistrationRecord } from "./registration/types.js";
import { DEFAULT_TTL_MS } from "./registration/types.js";
import { recordKey } from "./registration/bytes.js";
import type { CohortGossipBus } from "./gossip/bus.js";
import type { MembershipVerifier } from "./membership/verifier.js";
import type { Tier } from "./tiers.js";
import { bytesToB64url, b64urlToBytes, decodeRenewReplyV1, encodeCohortMessage } from "./wire/codec.js";
import type { RegisterReplyV1, RegisterV1, RenewReplyV1, TopicTrafficV1 } from "./wire/types.js";

/** A resolved cohort for a topic/tier — the return of {@link CohortTopicService.lookup}. */
export interface CohortHint {
	readonly topicId: Uint8Array;
	readonly tier: Tier;
	/** Serving cohort member. */
	readonly primary: Uint8Array;
	/** Warm-failover cohort members (1..2). */
	readonly backups: Uint8Array[];
	readonly cohortEpoch: Uint8Array;
	/** Full cohort member set, for client-side caching. */
	readonly cohortMembers: Uint8Array[];
	/** Coarse traffic barometer, when the cohort attached one. */
	readonly topicTraffic?: TopicTrafficV1;
}

/** A live registration: a {@link CohortHint} plus the participant-side renewal handle behind it. */
export interface RegistrationHandle extends CohortHint {
	/** Internal renewal driver (the `ttl/3` ping loop). Opaque to applications. */
	readonly renewal: RenewalParticipant;
}

/** Application-defined per-commit change folded into cohort gossip by the bridge ticket. */
export interface LocalCommitChange {
	readonly topicId: Uint8Array;
	readonly appPayload?: Uint8Array;
}

/** Hook the reactivity / matchmaking bridge sets to fold local commits into cohort gossip. */
export type LocalChangeHook = (change: LocalCommitChange) => void;

/** Thrown when the substrate cannot place a registration right now; carries the back-off delay. */
export class CohortBackoffError extends Error {
	constructor(readonly afterMs: number) {
		super(`cohort-topic: no willing primary right now; retry after ${afterMs}ms`);
		this.name = "CohortBackoffError";
	}
}

/** A registration request (`docs/cohort-topic.md` §Application policies). */
export interface RegisterRequest {
	readonly topicId: Uint8Array;
	readonly tier: Tier;
	/** Opaque application slot (reactivity / matchmaking define the contents). */
	readonly appPayload?: Uint8Array;
	/** Registration TTL (ms); defaults to the tier default. */
	readonly ttl?: number;
	/** Mark this a cold-root bootstrap request. */
	readonly bootstrap?: boolean;
}

/** The substrate's participant-facing contract. */
export interface CohortTopicService {
	/** Walk → register for `topicId` at `tier`; resolves a live {@link RegistrationHandle} or throws {@link CohortBackoffError}. */
	register(req: RegisterRequest): Promise<RegistrationHandle>;
	/** Run one `ttl/3` renewal cycle for `handle` (handles `primary_moved` + crash-failover). */
	renew(handle: RegistrationHandle): Promise<void>;
	/** Resolve the cohort for `topicId` at `tier` without keeping a live registration. */
	lookup(topicId: Uint8Array, tier: Tier): Promise<CohortHint>;
	/** Stop renewing `handle`; the cohort soft-state TTL-expires. */
	withdraw(handle: RegistrationHandle): Promise<void>;
	/** Bridge-set hook consumed by reactivity + matchmaking. */
	onLocalCommit?: LocalChangeHook;
	/** Cohort gossip bus — applications fold app state into the existing gossip. */
	cohortGossip(): CohortGossipBus;
	/** Membership verifier — applications verify threshold-signed app messages. */
	verifier(): MembershipVerifier;
}

/** Signs the participant's outbound `RegisterV1` / `RenewV1` bodies (db-p2p supplies the peer key). */
export interface ParticipantSigner {
	/** Sign a `RegisterV1` (minus its signature); returns the base64url signature. */
	signRegister(body: Omit<RegisterV1, "signature">): string;
	/** Sign a `RenewV1` (minus its signature); returns the base64url signature. */
	signRenew(body: UnsignedRenew): string;
}

/** Per-service tunables (cohort size, threshold, fan-out, TTL); all optional. */
export interface CohortServiceConfig {
	/** Fan-out per tier `F`. Default {@link DEFAULT_FANOUT}. */
	readonly fanout?: number;
	/** Requested cohort size `wantK`. Default 16. */
	readonly wantK?: number;
	/** Threshold signers `minSigs = k − x`. Default 14. */
	readonly minSigs?: number;
	/** Default registration TTL (ms). Default {@link DEFAULT_TTL_MS}. */
	readonly ttl?: number;
	/** Frame ceiling for encode/decode. Defaults to the codec default. */
	readonly maxMessageBytes?: number;
}

export interface CohortTopicServiceDeps {
	/** This participant's peer id (the `P` in `coord_d(P, topicId)`). */
	readonly self: Uint8Array;
	/** Hash + ring math (db-core's own SHA-256). */
	readonly hash: IRingHash;
	/** FRET-backed router (walk / register / direct-dial). */
	readonly router: ITopicRouter;
	/** FRET-backed network-size estimator feeding `d_max`. */
	readonly sizeEstimator: ISizeEstimator;
	/** Participant body signer. */
	readonly signer: ParticipantSigner;
	/** Cohort gossip bus (the host constructs it for this node's cohort). */
	readonly gossipBus: CohortGossipBus;
	/** Participant-side membership verifier. */
	readonly verifier: MembershipVerifier;
	/** Monotonic-ish wall clock (unix ms); injectable for tests. Default `Date.now`. */
	readonly clock?: () => number;
	readonly config?: CohortServiceConfig;
}

class WalkRegisterService implements CohortTopicService {
	public onLocalCommit?: LocalChangeHook;

	private readonly addressing: TierAddressing;
	private readonly dmax: DMaxComputer;
	private readonly walk: WalkEngine;
	private readonly clock: () => number;
	private readonly ttl: number;
	private readonly maxMessageBytes?: number;
	/** Live renewal drivers, keyed by `(topicId, participantId)` so renew/withdraw find their handle. */
	private readonly renewals = new Map<string, RenewalParticipant>();
	private readonly participantId: Uint8Array;

	constructor(private readonly deps: CohortTopicServiceDeps) {
		const cfg = deps.config ?? {};
		const fanout = cfg.fanout ?? DEFAULT_FANOUT;
		this.clock = deps.clock ?? ((): number => Date.now());
		this.ttl = cfg.ttl ?? DEFAULT_TTL_MS;
		this.maxMessageBytes = cfg.maxMessageBytes;
		this.participantId = deps.hash.H(deps.self);
		this.addressing = createTierAddressing(deps.hash, fanout);
		this.dmax = makeDMaxComputer({ estimator: deps.sizeEstimator, F: fanout });
		this.walk = createWalkEngine({
			router: deps.router,
			addressing: this.addressing,
			dmax: this.dmax,
			self: deps.self,
			factory: this.messageFactory(),
			config: { wantK: cfg.wantK, minSigs: cfg.minSigs, maxMessageBytes: cfg.maxMessageBytes },
		});
	}

	async register(req: RegisterRequest): Promise<RegistrationHandle> {
		const outcome = await this.walk.register(req.topicId, req.tier, req.appPayload);
		return this.handleFromOutcome(req, outcome);
	}

	async lookup(topicId: Uint8Array, tier: Tier): Promise<CohortHint> {
		// Resolution shares the registration walk: the accepted reply carries the cohort fields. The
		// soft-state it leaves TTL-expires if never renewed (a dedicated read-only probe RPC is a
		// documented follow-on — see the implement handoff).
		const outcome = await this.walk.register(topicId, tier);
		if (outcome.kind !== "accepted") {
			throw new CohortBackoffError(outcome.kind === "retry_later" ? outcome.afterMs : 0);
		}
		return this.hintFromReply(topicId, tier, outcome.reply);
	}

	async renew(handle: RegistrationHandle): Promise<void> {
		await handle.renewal.pingLoop();
		this.syncHandle(handle);
	}

	async withdraw(handle: RegistrationHandle): Promise<void> {
		// No explicit withdraw RPC exists on the wire yet; ceasing renewal lets the cohort soft-state
		// TTL-expire (§TTL and renewal). An immediate-tombstone renew is a documented follow-on.
		this.renewals.delete(recordKey(handle.topicId, this.participantId));
	}

	cohortGossip(): CohortGossipBus {
		return this.deps.gossipBus;
	}

	verifier(): MembershipVerifier {
		return this.deps.verifier;
	}

	// --- internals ---

	private handleFromOutcome(req: RegisterRequest, outcome: WalkOutcome): RegistrationHandle {
		if (outcome.kind !== "accepted") {
			throw new CohortBackoffError(outcome.kind === "retry_later" ? outcome.afterMs : 0);
		}
		const hint = this.hintFromReply(req.topicId, req.tier, outcome.reply);
		const renewal = this.startRenewal(req, hint, outcome.reply);
		return { ...hint, renewal };
	}

	private startRenewal(req: RegisterRequest, hint: CohortHint, reply: RegisterReplyV1): RenewalParticipant {
		const ttl = req.ttl ?? this.ttl;
		const initial: RegistrationRecord = {
			topicId: req.topicId,
			participantId: this.participantId,
			tier: req.tier,
			primary: hint.primary,
			backups: hint.backups,
			attachedAt: this.clock(),
			lastPing: this.clock(),
			ttl,
			appState: req.appPayload,
		};
		const transport = this.renewalTransport(req);
		const renewal = createRenewalParticipant(initial, {
			transport,
			clock: this.clock,
			sign: (body: UnsignedRenew): string => this.deps.signer.signRenew(body),
			correlationId: reply.cohortEpoch ?? bytesToB64url(this.participantId),
			initialCohortEpoch: hint.cohortEpoch,
		});
		this.renewals.set(recordKey(req.topicId, this.participantId), renewal);
		return renewal;
	}

	/** Renewal transport: dial the cached primary directly; a full failure re-runs the register walk. */
	private renewalTransport(req: RegisterRequest): RenewalParticipantTransport {
		return {
			send: async (target: Uint8Array, msg): Promise<RenewReplyV1> => {
				const raw = await this.deps.router.dialMember({ id: target }, encodeCohortMessage(msg, this.maxMessageBytes));
				return decodeRenewReplyV1(raw, this.maxMessageBytes);
			},
			relookup: async (): Promise<void> => {
				await this.walk.register(req.topicId, req.tier, req.appPayload);
			},
		};
	}

	private hintFromReply(topicId: Uint8Array, tier: Tier, reply: RegisterReplyV1): CohortHint {
		if (reply.primary === undefined || reply.cohortEpoch === undefined) {
			throw new CohortBackoffError(0);
		}
		return {
			topicId,
			tier,
			primary: b64urlToBytes(reply.primary),
			backups: (reply.backups ?? []).map(b64urlToBytes),
			cohortEpoch: b64urlToBytes(reply.cohortEpoch),
			cohortMembers: (reply.cohortMembers ?? []).map(b64urlToBytes),
			topicTraffic: reply.topicTraffic,
		};
	}

	private syncHandle(handle: RegistrationHandle): void {
		const rec = handle.renewal.record;
		(handle as { primary: Uint8Array }).primary = rec.primary;
		(handle as { backups: Uint8Array[] }).backups = [...rec.backups];
		const epoch = handle.renewal.cohortEpochHint;
		if (epoch !== undefined) {
			(handle as { cohortEpoch: Uint8Array }).cohortEpoch = epoch;
		}
	}

	/** The per-probe `RegisterV1` builder: stamps participant coord/ttl/correlation and signs. */
	private messageFactory(): RegisterMessageFactory {
		const participantCoord = bytesToB64url(this.participantId);
		return {
			build: async (params): Promise<RegisterV1> => {
				const body: Omit<RegisterV1, "signature"> = {
					v: 1,
					topicId: bytesToB64url(params.topicId),
					tier: params.tier,
					treeTier: params.treeTier,
					participantCoord,
					ttl: this.ttl,
					timestamp: this.clock(),
					correlationId: this.freshCorrelationId(),
				};
				if (params.bootstrap) {
					body.bootstrap = true;
				}
				if (params.appPayload !== undefined) {
					body.appPayload = bytesToB64url(params.appPayload);
				}
				return { ...body, signature: this.deps.signer.signRegister(body) };
			},
		};
	}

	/** 16 random bytes, base64url. Derived from the clock + participant when no CSPRNG is injected. */
	private freshCorrelationId(): string {
		const buf = new Uint8Array(16);
		const seed = this.clock();
		for (let i = 0; i < 8; i++) {
			buf[i] = (seed >>> (i * 4)) & 0xff;
			buf[8 + i] = this.participantId[i] ?? 0;
		}
		return bytesToB64url(buf);
	}
}

/** Build the participant-facing {@link CohortTopicService} over the injected ports. */
export function createCohortTopicService(deps: CohortTopicServiceDeps): CohortTopicService {
	return new WalkRegisterService(deps);
}
