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

import { randomBytes } from "@noble/hashes/utils.js";
import { createTierAddressing, type TierAddressing } from "./addressing.js";
import { makeDMaxComputer, type DMaxComputer } from "./dmax.js";
import { DEFAULT_FANOUT } from "./addressing.js";
import type { ISizeEstimator, ITopicRouter, IRingHash } from "./ports.js";
import { createWalkEngine, type AcceptedWalkOutcome, type RegisterMessageFactory, type WalkEngine, type WalkOutcome } from "./walk.js";
import { createRenewalParticipant, type RenewalParticipant, type RenewalParticipantTransport, type UnsignedRenew } from "./registration/renewal.js";
import type { RegistrationRecord } from "./registration/types.js";
import { DEFAULT_TTL_MS } from "./registration/types.js";
import { recordKey } from "./registration/bytes.js";
import type { CohortGossipBus } from "./gossip/bus.js";
import type { MembershipVerifier } from "./membership/verifier.js";
import type { Tier } from "./tiers.js";
import { bytesToB64url, b64urlToBytes, decodeRenewReplyV1, encodeCohortMessage } from "./wire/codec.js";
import { MAX_ROOT_KEY_BYTES } from "./wire/validate.js";
import type { RegisterV1, RenewReplyV1, TopicTrafficV1 } from "./wire/types.js";
import type { CollectionChangeEvent, CommitCert } from "../transactor/change-notifier.js";

/** A resolved cohort for a topic/tier — the return of {@link CohortTopicService.lookup}. */
export interface CohortHint {
	readonly topicId: Uint8Array;
	readonly tier: Tier;
	/**
	 * The tree tier `d` the walk landed at: `0` is the topic's root cohort, `d ≥ 1` a cohort below it. A
	 * root-placed topic's root can move while the tiers below it stay put, so a caller following a moved
	 * root reads this to choose between {@link CohortTopicService.moveRoot} and registering again.
	 */
	readonly treeTier: number;
	/** Serving cohort member. */
	readonly primary: Uint8Array;
	/** Warm-failover cohort members (1..2). */
	readonly backups: Uint8Array[];
	readonly cohortEpoch: Uint8Array;
	/** Full cohort member set, for client-side caching. */
	readonly cohortMembers: Uint8Array[];
	/** Coarse traffic barometer, when the cohort attached one. */
	readonly topicTraffic?: TopicTrafficV1;
	/**
	 * The root key the topic was resolved under, when it is root-placed (its tier-0 cohort sits at
	 * `H(rootKey)`) — on a handle, the key {@link CohortTopicService.moveRoot} last named, which a handle at
	 * the root (`treeTier` 0) holds before it has registered there. Absent for the default addressing. A
	 * caller verifying a message signed by that root needs it to know the root's threshold rule applies.
	 */
	readonly rootKey?: Uint8Array;
}

/** A live registration: a {@link CohortHint} plus the participant-side renewal handle behind it. */
export interface RegistrationHandle extends CohortHint {
	/** Internal renewal driver (the `ttl/3` ping loop). Opaque to applications. */
	readonly renewal: RenewalParticipant;
}

/**
 * The substrate's **origination hook**: a commit that lands on a node which is a cohort member for the
 * collection's reactivity topic is delivered here by the local change-notifier bridge
 * (`local-change-notifier-bridge`), carrying the raw {@link CollectionChangeEvent} and the
 * pass-through {@link CommitCert} (extracted from cluster consensus, forwarded UNCHANGED). Reactivity
 * (and later matchmaking) set this hook to fan the event out — reusing `commitCert.thresholdSig`
 * directly, never re-signing. The bridge swallows + logs any throw so origination can never break the
 * commit.
 */
export type LocalChangeHook = (event: CollectionChangeEvent, commitCert: CommitCert) => void;

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
	/**
	 * Place this topic's root at a routing key: raw key bytes (1..`MAX_ROOT_KEY_BYTES`), e.g. a block's
	 * routing key. The topic's tier-0 cohort is then the group responsible for that key, at `H(rootKey)`,
	 * instead of the cohort at `H(0x00 ‖ topicId)` (§Tier addressing → Root placement at a routing key).
	 * Every participant of one topic must name the same key. Absent → the default addressing.
	 */
	readonly rootKey?: Uint8Array;
}

/** The substrate's participant-facing contract. */
export interface CohortTopicService {
	/** Walk → register for `topicId` at `tier`; resolves a live {@link RegistrationHandle} or throws {@link CohortBackoffError}. */
	register(req: RegisterRequest): Promise<RegistrationHandle>;
	/** Run one `ttl/3` renewal cycle for `handle` (handles `primary_moved` + crash-failover). */
	renew(handle: RegistrationHandle): Promise<void>;
	/**
	 * Resolve the cohort for `topicId` at `tier` without keeping a live registration. `rootKey` names the
	 * root of a root-placed topic (see {@link RegisterRequest.rootKey}).
	 */
	lookup(topicId: Uint8Array, tier: Tier, rootKey?: Uint8Array): Promise<CohortHint>;
	/** Stop renewing `handle` and send a best-effort signed withdraw tombstone so the cohort frees the
	 * record immediately (TTL expiry remains the fallback if the primary is unreachable). */
	withdraw(handle: RegistrationHandle): Promise<void>;
	/**
	 * The topic's root moved to `rootKey` (a root-placed topic only — a handle registered without a root key
	 * throws). Nothing is sent: a registration at a tier below the root stays where it is. A later re-walk of
	 * this registration (renewal failover) names the new key, so it lands at the new root rather than the old
	 * one. A registration AT the root (`handle.treeTier === 0`) is left at the old root by this call and must
	 * be re-registered instead — `register` with the new key displaces it (see the NOTE at `startRenewal`).
	 * A stale handle (no longer the live registration for its topic) is a no-op.
	 */
	moveRoot(handle: RegistrationHandle, rootKey: Uint8Array): void;
	/** Origination hook the change-notifier bridge invokes per local member commit; see {@link LocalChangeHook}. */
	onLocalCommit?: LocalChangeHook;
	/** Cohort gossip bus — applications fold app state into the existing gossip. */
	cohortGossip(): CohortGossipBus;
	/** Membership verifier — applications verify threshold-signed app messages. */
	verifier(): MembershipVerifier;
}

/**
 * Signs the participant's outbound `RegisterV1` / `RenewV1` bodies (db-p2p supplies the peer key).
 *
 * Async because the underlying libp2p `PrivateKey.sign` is async; both call sites already `await`
 * (`messageFactory.build` and the renewal `sign` hook). The signature is over the canonical body
 * image ({@link import("./wire/payloads.js").registerSigningPayload} /
 * {@link import("./wire/payloads.js").renewSigningPayload}) so a cohort member can recompute and
 * verify it against the participant's peer key.
 */
export interface ParticipantSigner {
	/** Sign a `RegisterV1` (minus its signature); resolves the base64url signature. */
	signRegister(body: Omit<RegisterV1, "signature">): Promise<string>;
	/** Sign a `RenewV1` (minus its signature); resolves the base64url signature. */
	signRenew(body: UnsignedRenew): Promise<string>;
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
	/**
	 * Optional cold-start bootstrap-evidence builder (db-p2p supplies it). Invoked on **either** cold-start
	 * re-issue — the root `bootstrap: true` or the deeper-tier `followOn: true` (both gated by the same
	 * evidence policy) — with the register's own canonical fields, the same
	 * `(topicId, tier, participantCoord, timestamp)` tuple a verifier binds via
	 * `bootstrapBoundImage`. It returns the **raw** envelope JSON bytes — `utf8(JSON.stringify(env))`,
	 * NOT the already-base64url string from `serializeBootstrapEvidenceEnvelope` — or `undefined` to
	 * attach none; the service base64url-encodes those bytes into `RegisterV1.bootstrapEvidence`
	 * **before** the body is signed, so the participant signature covers them and a MITM cannot strip or
	 * swap the proof. (Returning the `serialize()` string's bytes would double-encode the field.)
	 * Absent (default) → no evidence is attached, exactly today's behavior. The minting logic (PoW
	 * search, reputation/parent-ref signing) is the db-p2p follow-on.
	 */
	readonly buildBootstrapEvidence?: (params: {
		readonly topicId: string;
		readonly tier: number;
		readonly participantCoord: string;
		readonly timestamp: number;
	}) => Promise<Uint8Array | undefined>;
	readonly config?: CohortServiceConfig;
}

/** The root key a renewal's re-walk names — mutable, so {@link CohortTopicService.moveRoot} can re-point it. */
interface RootKeySlot {
	key: Uint8Array | undefined;
}

/** A live registration's renewal driver and the root key its re-walk reads. */
interface LiveRenewal {
	readonly renewal: RenewalParticipant;
	readonly root: RootKeySlot;
}

class WalkRegisterService implements CohortTopicService {
	public onLocalCommit?: LocalChangeHook;

	private readonly addressing: TierAddressing;
	private readonly dmax: DMaxComputer;
	private readonly walk: WalkEngine;
	private readonly clock: () => number;
	private readonly ttl: number;
	private readonly maxMessageBytes?: number;
	/** Live renewals, keyed by `(topicId, participantId)` so renew/withdraw/moveRoot find their handle. */
	private readonly renewals = new Map<string, LiveRenewal>();
	private readonly participantId: Uint8Array;

	constructor(private readonly deps: CohortTopicServiceDeps) {
		const cfg = deps.config ?? {};
		const fanout = cfg.fanout ?? DEFAULT_FANOUT;
		this.clock = deps.clock ?? ((): number => Date.now());
		this.ttl = cfg.ttl ?? DEFAULT_TTL_MS;
		this.maxMessageBytes = cfg.maxMessageBytes;
		// The participant identity carried on the wire (`participantCoord` on register, `participantId`
		// on renew) IS `self` — the dialable peer id db-p2p supplies via its peer-codec. It is the
		// record key the cohort stores AND the signer id its peer-key signature verifies against, so it
		// must round-trip back to a peer id rather than being re-hashed here (§Tier addressing names the
		// routing coord `P = self` directly; slot assignment hashes it internally for uniformity).
		this.participantId = deps.self;
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
		assertRootKey(req.rootKey);
		const outcome = await this.walk.register(req.topicId, req.tier, req.appPayload, { rootKey: req.rootKey });
		return this.handleFromOutcome(req, outcome);
	}

	async lookup(topicId: Uint8Array, tier: Tier, rootKey?: Uint8Array): Promise<CohortHint> {
		assertRootKey(rootKey);
		// A read-only probe: it walks to the responsible cohort exactly as a register would and returns the
		// same cohort snapshot, but admits NOTHING — no soft-state record, no arrival, no promotion trigger,
		// no topic-budget touch, and never a cold-start instantiation. A topic served nowhere resolves to a
		// `CohortBackoffError` (the probe never bootstraps a cold root), so a lookup leaves no throwaway
		// registration behind to TTL-expire (§Application policies; the lookup-as-register interim is gone).
		const outcome = await this.walk.register(topicId, tier, undefined, { probe: true, rootKey });
		if (outcome.kind !== "accepted") {
			throw new CohortBackoffError(outcome.kind === "retry_later" ? outcome.afterMs : 0);
		}
		return this.hintFromReply(topicId, tier, outcome, rootKey);
	}

	async renew(handle: RegistrationHandle): Promise<void> {
		// Act only if this handle is still the live entry. A stale handle (superseded by a second
		// register() for the same pair) must not drive the new registration's ping loop, and a
		// withdrawn handle must not silently re-start it.
		if (this.liveRenewal(handle) === undefined) {
			return;
		}
		await handle.renewal.pingLoop();
		this.syncHandle(handle);
	}

	moveRoot(handle: RegistrationHandle, rootKey: Uint8Array): void {
		assertRootKey(rootKey);
		if (handle.rootKey === undefined) {
			throw new Error("cohort-topic: moveRoot needs a root-placed registration; this one was registered without a rootKey");
		}
		const live = this.liveRenewal(handle);
		if (live === undefined) {
			return;
		}
		live.root.key = rootKey;
		(handle as { rootKey?: Uint8Array }).rootKey = rootKey;
	}

	async withdraw(handle: RegistrationHandle): Promise<void> {
		// Two halves: (1) drop the handle from the live set so further renew() pings no-op (see renew()),
		// stopping the local ping loop; (2) fire a best-effort signed withdraw tombstone to the current
		// primary so the cohort frees the record immediately instead of holding it for up to a full TTL.
		// The delete happens FIRST so a concurrent renew() already no-ops before the tombstone is sent. If
		// the tombstone send fails (primary unreachable), the cohort soft-state TTL-expires as the
		// fallback — withdraw never throws on a transport failure. Idempotent: a second withdraw finds no
		// live entry for the handle and no-ops.
		// Guard: act only if this handle is still the live entry. A stale handle must not evict the
		// new registration or send a tombstone on its behalf.
		const live = this.liveRenewal(handle);
		if (live === undefined) {
			return;
		}
		this.renewals.delete(recordKey(handle.topicId, this.participantId));
		await live.renewal.withdraw();
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
		const hint = this.hintFromReply(req.topicId, req.tier, outcome, req.rootKey);
		const renewal = this.startRenewal(req, hint, outcome.correlationId);
		return { ...hint, renewal };
	}

	/** The live renewal `handle` drives, or `undefined` when a later register displaced it or it was withdrawn. */
	private liveRenewal(handle: RegistrationHandle): LiveRenewal | undefined {
		const live = this.renewals.get(recordKey(handle.topicId, this.participantId));
		return live?.renewal === handle.renewal ? live : undefined;
	}

	private startRenewal(req: RegisterRequest, hint: CohortHint, correlationId: string): RenewalParticipant {
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
		const root: RootKeySlot = { key: req.rootKey };
		const transport = this.renewalTransport(req, root);
		const renewal = createRenewalParticipant(initial, {
			transport,
			clock: this.clock,
			sign: (body: UnsignedRenew): Promise<string> => this.deps.signer.signRenew(body),
			// Echo the accepted RegisterV1's correlationId: RenewV1 `correlationId` "matches original
			// RegisterV1" (docs §Wire, RenewV1), so a future renew-path freshness/replay guard can correlate
			// a renew back to the registration it renews.
			// NOTE: every periodic renew for this registration shares this ONE correlationId (as it always
			// has — this only makes the shared id equal the register's, not an independent nonce). A future
			// renew replay guard must therefore key renews by (correlationId, timestamp-window), NOT "drop
			// any repeated correlationId" — else it would reject the 2nd+ legitimate renew.
			correlationId,
			initialCohortEpoch: hint.cohortEpoch,
		});
		// NOTE: accepted — a second register() for the same (topicId, participantId) displaces the first:
		// renew()/withdraw()/moveRoot() on the displaced handle no-op (identity guard), and NO tombstone is
		// sent for the displaced record, by design. A participant re-registers at a moved root while its old
		// record still lives at the old one, and a machine in both roots' storage groups holds both; a
		// tombstone resolves through the host's `findHolder`, which picks the newer record there, so it would
		// evict the live registration. The displaced record expires by TTL at its cohort.
		this.renewals.set(recordKey(req.topicId, this.participantId), { renewal, root });
		return renewal;
	}

	/**
	 * Renewal transport: dial the cached primary directly; a full failure re-runs the register walk. The
	 * re-walk reads the root key from `root` when it runs, so after {@link CohortTopicService.moveRoot} it
	 * lands at the topic's current root rather than the one it registered under.
	 */
	private renewalTransport(req: RegisterRequest, root: RootKeySlot): RenewalParticipantTransport {
		return {
			send: async (target: Uint8Array, msg): Promise<RenewReplyV1> => {
				const raw = await this.deps.router.dialMember({ id: target }, encodeCohortMessage(msg, this.maxMessageBytes));
				return decodeRenewReplyV1(raw, this.maxMessageBytes);
			},
			relookup: async (): Promise<void> => {
				await this.walk.register(req.topicId, req.tier, req.appPayload, { rootKey: root.key });
			},
		};
	}

	private hintFromReply(topicId: Uint8Array, tier: Tier, outcome: AcceptedWalkOutcome, rootKey: Uint8Array | undefined): CohortHint {
		const reply = outcome.reply;
		if (reply.primary === undefined || reply.cohortEpoch === undefined) {
			throw new CohortBackoffError(0);
		}
		return {
			topicId,
			tier,
			treeTier: outcome.treeTier,
			primary: b64urlToBytes(reply.primary),
			backups: (reply.backups ?? []).map(b64urlToBytes),
			cohortEpoch: b64urlToBytes(reply.cohortEpoch),
			cohortMembers: (reply.cohortMembers ?? []).map(b64urlToBytes),
			topicTraffic: reply.topicTraffic,
			...(rootKey === undefined ? {} : { rootKey }),
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
				if (params.probe) {
					// A read-only lookup probe. Mutually exclusive with bootstrap/followOn (the walk never sets
					// either on a probe), so the cold-start-evidence branch below cannot run for a probe.
					body.probe = true;
				}
				// A cold-start re-issue — root (`bootstrap`) or deeper-tier follow-on (`followOn`). Both are
				// gated by the identical evidence policy (§Anti-DoS), so both mint and attach the same envelope
				// bound to the body's own canonical fields. Mutually exclusive with each other and with probe.
				if (params.bootstrap || params.followOn) {
					if (params.followOn) {
						body.followOn = true;
					} else {
						body.bootstrap = true;
					}
					// Attach cold-start evidence BEFORE signing (so the signature covers it). Bind the
					// builder to the body's own canonical fields — the exact tuple a verifier reconstructs.
					const evidence = await this.deps.buildBootstrapEvidence?.({
						topicId: body.topicId,
						tier: body.tier,
						participantCoord: body.participantCoord,
						timestamp: body.timestamp,
					});
					if (evidence !== undefined && evidence.length > 0) {
						body.bootstrapEvidence = bytesToB64url(evidence);
					}
				}
				if (params.appPayload !== undefined) {
					body.appPayload = bytesToB64url(params.appPayload);
				}
				if (params.rootKey !== undefined) {
					body.rootKey = bytesToB64url(params.rootKey);
				}
				return { ...body, signature: await this.deps.signer.signRegister(body) };
			},
		};
	}

	/** 16 fresh CSPRNG bytes, base64url. A correlation id must be unique per probe — the replay guard
	 * keys on it — so it cannot be derived from the clock (two probes in the same ms would collide). */
	private freshCorrelationId(): string {
		return bytesToB64url(randomBytes(16));
	}
}

/**
 * Reject a root key no cohort would accept. The wire validator refuses an empty or over-long `rootKey`,
 * so sending one would only surface as a remote decode failure; it is a caller error, raised here.
 */
function assertRootKey(rootKey: Uint8Array | undefined): void {
	if (rootKey !== undefined && (rootKey.length === 0 || rootKey.length > MAX_ROOT_KEY_BYTES)) {
		throw new RangeError(`cohort-topic: rootKey must be 1..${MAX_ROOT_KEY_BYTES} bytes, got ${rootKey.length}`);
	}
}

/** Build the participant-facing {@link CohortTopicService} over the injected ports. */
export function createCohortTopicService(deps: CohortTopicServiceDeps): CohortTopicService {
	return new WalkRegisterService(deps);
}
