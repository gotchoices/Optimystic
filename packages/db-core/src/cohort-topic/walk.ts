/**
 * Cohort-topic substrate — walk-toward-root lookup / registration.
 *
 * Transcribed from `docs/cohort-topic.md` §Tree growth and lookup (§Lookup loop) and folded back
 * from the simulator-validated `packages/substrate-simulator/src/walk.ts`. A participant resolves a
 * topic by walking **toward the root** from `d_max`, probing one tier coordinate per RPC. The walk's
 * single-direction discipline is the anti-flood backbone: it only ever moves inward (toward the root)
 * on `NoState`, and the *only* outward move is following an explicit `Promoted` redirect.
 *
 * Reply handling (§Lookup):
 * - **`accepted`** → done; return the reply (carries `primary`/`backups`/`cohortEpoch` to cache).
 * - **`no_state`** at tier `d` → step one tier toward the root (`d − 1`); no traffic signal. At the
 *   root (`d − 1 < 0`) re-issue once at tier 0 with `bootstrap: true` (cold-start request). **If this
 *   `no_state` is the redirect target of a `Promoted` this walk just followed** (`followedPromoted`),
 *   the deeper child is cold: a register re-issues **once** at the same tier with `followOn: true` (a
 *   deeper-tier cold-start, gated by the same evidence a `bootstrap` pays), then backs off if that too
 *   returns `no_state`; a probe never instantiates, so it backs off immediately. This is what lets a
 *   join that lands on a freshly-promoted-but-not-yet-grown branch converge instead of oscillating.
 * - **`promoted(targetTier)`** → recompute `coord_targetTier(self, topicId)` and register there — the
 *   one outward move, taken only on this explicit redirect.
 * - **`unwilling_member(candidates)`** → retry the **same** coord at a named alternative member
 *   (spatial move within the cohort), via a direct dial.
 * - **`unwilling_cohort(retryAfter)`** → back off in **time**; the walk terminates with
 *   {@link RetryLaterOutcome} and the caller restarts a fresh {@link WalkEngine.register} after
 *   `afterMs` — which begins again at `d_max`, decorrelating retries across the ring (§Anti-flood
 *   claim 4: never re-hit the declined coord immediately).
 *
 * This module is FRET-free: it drives the {@link ITopicRouter} port (db-p2p binds it to FRET's
 * `RouteAndMaybeAct` / direct dial) and the {@link TierAddressing} math, and delegates building +
 * signing the {@link RegisterV1} to the injected {@link RegisterMessageFactory} (participant identity
 * and crypto live there, not here).
 */

import type { ITopicRouter, PeerRef } from "./ports.js";
import type { TierAddressing } from "./addressing.js";
import type { DMaxComputer } from "./dmax.js";
import { DEFAULT_D_MAX_CAP } from "./dmax.js";
import { backoffRetryMs } from "./willingness.js";
import { b64urlToBytes, decodeRegisterReplyV1, encodeCohortMessage } from "./wire/codec.js";
import type { RegisterReplyV1, RegisterV1 } from "./wire/types.js";

/** The walk landed: the cohort accepted the registration. `reply` carries the cohort cache fields. */
export interface AcceptedWalkOutcome {
	readonly kind: "accepted";
	readonly reply: RegisterReplyV1;
	/**
	 * The accepted register probe's own `correlationId`. The participant echoes it on every renew for this
	 * registration so `RenewV1.correlationId` "matches original `RegisterV1`" (docs §Wire, RenewV1). Each
	 * probe carries a distinct correlationId; this is the one the cohort admitted.
	 */
	readonly correlationId: string;
}

/**
 * The walk hit a `Promoted` redirect and the engine was configured **not** to follow it
 * ({@link WalkConfig.followPromoted} `= false`): the caller recomputes `coord_targetTier` and
 * registers there itself. With the default (`followPromoted = true`) the engine follows the redirect
 * internally and this outcome never surfaces.
 */
export interface PromotedWalkOutcome {
	readonly kind: "promoted";
	readonly targetTier: number;
}

/**
 * The walk backed off in time (`unwilling_cohort`, exhausted sibling retries, a failed cold-start, or
 * the safety step cap). The caller waits `afterMs` then calls {@link WalkEngine.register} again, which
 * restarts at `d_max`.
 */
export interface RetryLaterOutcome {
	readonly kind: "retry_later";
	readonly afterMs: number;
}

export type WalkOutcome = AcceptedWalkOutcome | PromotedWalkOutcome | RetryLaterOutcome;

/** Builds (and signs) the {@link RegisterV1} for one probe; owns participant identity + crypto. */
export interface RegisterMessageFactory {
	/**
	 * Produce a signed `RegisterV1` for this participant at walk position `treeTier`. `bootstrap` is set
	 * only on the root cold-start re-issue; `followOn` only on the dedicated re-issue after a `Promoted`
	 * redirect target answered `NoState` (§Cold-start). `appPayload` is the opaque application slot. On
	 * either cold-start re-issue the factory mints and attaches the signed `bootstrapEvidence` envelope
	 * (§Anti-DoS — a follow-on is gated identically to a bootstrap) via the injected builder seam before
	 * signing — keyed off `bootstrap`/`followOn`, so no extra parameter is needed (the walk decides both
	 * internally, not the application). `bootstrap`, `followOn`, and `probe` are mutually exclusive.
	 */
	build(params: {
		topicId: Uint8Array;
		tier: number;
		treeTier: number;
		bootstrap: boolean;
		/** Follow-on cold-start re-issue after a `Promoted` redirect target answered `NoState` (`treeTier >= 1`). */
		followOn: boolean;
		/** Read-only lookup probe: the factory stamps `RegisterV1.probe` and never mints cold-start evidence. */
		probe: boolean;
		appPayload?: Uint8Array;
	}): Promise<RegisterV1>;
}

export interface WalkConfig {
	/** Cohort size requested from the router (`wantK`). Default 16. */
	wantK?: number;
	/** Threshold signers requested from the router (`minSigs = k − x`). Default 14. */
	minSigs?: number;
	/** Max `unwilling_member` sibling retries at one coord before treating it as a cohort decline. Default `wantK`. */
	maxMemberRetries?: number;
	/**
	 * Whether to follow a `Promoted` redirect internally (recompute coord + continue) or surface it as
	 * a {@link PromotedWalkOutcome} for the caller to drive. Default `true` (self-contained walk).
	 */
	followPromoted?: boolean;
	/**
	 * Hard cap on probe RPCs in one walk — a safety valve against pathological oscillation between an
	 * inward `NoState` step and an outward `Promoted` redirect in a malformed tree. Default scales with
	 * `d_max`. Exceeding it yields a {@link RetryLaterOutcome}.
	 */
	maxSteps?: number;
	/** `max_message_bytes` ceiling for the encoded register frame. Defaults to the codec default. */
	maxMessageBytes?: number;
}

export interface WalkEngineDeps {
	router: ITopicRouter;
	addressing: TierAddressing;
	/** Computes the walk start tier `d_max` from the current network-size estimate. */
	dmax: DMaxComputer;
	/** This participant's peer id — the `P` in `coord_d(P, topicId)`. */
	self: Uint8Array;
	/** Builds + signs the per-probe `RegisterV1`. */
	factory: RegisterMessageFactory;
	config?: WalkConfig;
}

/** Drives a participant's walk-toward-root registration over the injected router + addressing. */
export interface WalkEngine {
	/**
	 * Walk from `d_max` toward the root registering for `topicId` at op `tier`, following `Promoted`
	 * redirects outward. Resolves with the terminal {@link WalkOutcome}. With `opts.probe` the walk is a
	 * **read-only lookup**: identical routing discipline, but the terminal cohort classifies rather than
	 * admits and the root `no_state` branch backs off instead of issuing a `bootstrap: true` cold-start
	 * (a probe never instantiates a cold root).
	 */
	register(topicId: Uint8Array, tier: number, appPayload?: Uint8Array, opts?: { probe?: boolean }): Promise<WalkOutcome>;
}

/**
 * A walk tier is valid iff it is an integer in `0..DEFAULT_D_MAX_CAP` — the substrate's own walk-depth
 * ceiling. A `promoted` reply's explicit `targetTier` is untrusted: an out-of-range value (non-integer,
 * negative, or above the ceiling) cannot name a real cohort and would reach `addressing.coord()` →
 * `coordD`, which throws a raw `RangeError`. Matches the range the wire `treeTier` validator enforces.
 */
function isValidTreeTier(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= DEFAULT_D_MAX_CAP;
}

class RouterWalkEngine implements WalkEngine {
	private readonly wantK: number;
	private readonly minSigs: number;
	private readonly maxMemberRetries: number;
	private readonly followPromoted: boolean;
	private readonly configuredMaxSteps?: number;
	private readonly maxMessageBytes?: number;

	constructor(private readonly deps: WalkEngineDeps) {
		const cfg = deps.config ?? {};
		this.wantK = cfg.wantK ?? 16;
		this.minSigs = cfg.minSigs ?? 14;
		this.maxMemberRetries = cfg.maxMemberRetries ?? this.wantK;
		this.followPromoted = cfg.followPromoted ?? true;
		this.configuredMaxSteps = cfg.maxSteps;
		this.maxMessageBytes = cfg.maxMessageBytes;
	}

	async register(topicId: Uint8Array, tier: number, appPayload?: Uint8Array, opts?: { probe?: boolean }): Promise<WalkOutcome> {
		const dMax = this.deps.dmax.dMax();
		const maxSteps = this.configuredMaxSteps ?? 2 * (dMax + 2) + this.maxMemberRetries + 8;
		const probe = opts?.probe ?? false;

		let d = dMax;
		let bootstrap = false;
		let followOn = false;
		// Member ids (base64url) already dialed on this walk's `unwilling_member` retries. Tracking WHICH
		// members were tried — not a positional counter — lets each fresh candidate list be consumed from
		// its best (index-0) member; a counter would permanently skip index 0 of every list after the first.
		const triedMembers = new Set<string>();
		let dialTarget: PeerRef | undefined;
		let steps = 0;
		// True once this walk has followed a `Promoted` redirect outward (either mode). On a subsequent
		// `NoState` the redirect target is cold: a probe backs off (never instantiates), a register
		// re-issues once with `followOn: true` to instantiate the child, then backs off.
		let followedPromoted = false;
		// True once the register path has spent its single `followOn: true` re-issue at the cold child.
		let followOnReissued = false;

		for (;;) {
			if (++steps > maxSteps) {
				// Safety valve: a well-formed tree converges well within this bound. Surface a temporal
				// back-off rather than spin.
				return { kind: "retry_later", afterMs: backoffRetryMs(0) };
			}

			const reg = await this.deps.factory.build({ topicId, tier, treeTier: d, bootstrap, followOn, probe, appPayload });
			const activity = encodeCohortMessage(reg, this.maxMessageBytes);
			const raw = dialTarget !== undefined
				? await this.deps.router.dialMember(dialTarget, activity)
				: await this.deps.router.routeAndAct(this.deps.addressing.coord(d, this.deps.self, topicId), activity, {
					wantK: this.wantK,
					minSigs: this.minSigs,
				});
			const reply = decodeRegisterReplyV1(raw, this.maxMessageBytes);

			switch (reply.result) {
				case "accepted": {
					// Surface the accepted probe's correlationId so the participant's renewals can echo it
					// (RenewV1 correlationId "matches original RegisterV1"). `reg` is the frame just admitted.
					return { kind: "accepted", reply, correlationId: reg.correlationId };
				}
				case "no_state": {
					// Step toward the root. The cohort served nothing here; no spatial sibling state.
					dialTarget = undefined;
					triedMembers.clear(); // a spatial move to a new coord starts sibling retries fresh
					if (followedPromoted) {
						// The `Promoted` redirect target is cold (not yet instantiated). Walking inward to the
						// promoting ancestor would just re-trigger the redirect and oscillate, so handle it here.
						if (probe) {
							// A probe never instantiates — back off immediately (mirror of the register re-issue).
							return { kind: "retry_later", afterMs: backoffRetryMs(0) };
						}
						if (!followOnReissued) {
							// Re-issue ONCE at the SAME child tier as a follow-on cold-start: RegisterV1{ followOn:
							// true } + minted evidence. The mirror of the root NoState → bootstrap:true re-issue.
							followOn = true;
							followOnReissued = true;
							break; // re-register at the same coord/tier, now carrying followOn
						}
						// The follow-on re-issue still got NoState → the cold child's quorum is unwilling to
						// instantiate. Back off in time; do NOT loop inward.
						return { kind: "retry_later", afterMs: backoffRetryMs(0) };
					}
					const next = d - 1;
					if (next < 0) {
						if (bootstrap) {
							// Already re-issued at the root as a bootstrap and still nothing — no cohort
							// anywhere will instantiate right now. Back off in time.
							return { kind: "retry_later", afterMs: backoffRetryMs(0) };
						}
						if (probe) {
							// A read-only probe never instantiates a cold root: the topic exists nowhere, so
							// resolve "not found / back off" rather than re-issuing with bootstrap:true.
							return { kind: "retry_later", afterMs: backoffRetryMs(0) };
						}
						// Root returned NoState → cold-start: re-issue once at tier 0 with bootstrap:true.
						d = 0;
						bootstrap = true;
						break;
					}
					d = next;
					bootstrap = false;
					break;
				}
				case "promoted": {
					dialTarget = undefined;
					triedMembers.clear(); // spatial move to the redirect target: sibling retries start fresh
					bootstrap = false;
					const targetTier = reply.targetTier ?? d + 1;
					// The cohort names the tier to jump outward to. When it supplied `targetTier` EXPLICITLY it is
					// untrusted: an out-of-range value would reach `coord()` → `coordD` and throw a raw RangeError,
					// an unclassified crash out of register()/lookup() rather than a clean outcome. Bound it before
					// BOTH adoption sites (the followPromoted-false surface below and the `d = targetTier` hop) and
					// back off in time instead. Only the EXPLICIT attacker value is the hazard; the `d + 1`
					// fallback is left unchecked because `d` is walk-bounded to `dMax + maxSteps` (≈190 under the
					// default `maxSteps`), comfortably under coordD's 255 range.
					// NOTE: `maxSteps` is operator-configurable — a value above ~195 plus an adversarial chain of
					// no-`targetTier` `promoted` replies (each bumps `d` by +1) could push the `d + 1` fallback
					// past coordD's range and reintroduce the RangeError. If maxSteps is ever raised that high,
					// bound the fallback here too.
					if (reply.targetTier !== undefined && !isValidTreeTier(targetTier)) {
						return { kind: "retry_later", afterMs: backoffRetryMs(0) };
					}
					// Following a (fresh) redirect: mark it, and reset the follow-on latch so a cold child at
					// THIS target gets its own single follow-on re-issue. The honest flow re-registers the
					// child with a PLAIN frame first (followOn false) and only escalates to followOn on its
					// NoState — so clear the flag here; the NoState branch re-arms it.
					followedPromoted = true;
					followOn = false;
					followOnReissued = false;
					if (!this.followPromoted) {
						return { kind: "promoted", targetTier };
					}
					d = targetTier; // the one outward move — recompute coord at the redirect target
					break;
				}
				case "unwilling_member": {
					const candidates = reply.candidateMembers ?? [];
					// Consume this (possibly fresh) list from its best (index-0) member: pick the FIRST
					// candidate not already dialed on this walk. A positional `memberAttempts % len` offset
					// would skip index 0 of every list after the first, permanently starving the best member.
					const next = candidates.find((c) => !triedMembers.has(c));
					if (next === undefined || triedMembers.size >= this.maxMemberRetries) {
						// No untried candidate offered (or the retry cap is spent) → fall through to a
						// cohort-level temporal back-off, restarting at d_max on the caller's retry.
						return { kind: "retry_later", afterMs: backoffRetryMs(0) };
					}
					// Retry the SAME coord at a named alternative member (spatial move within the cohort).
					triedMembers.add(next);
					dialTarget = { id: b64urlToBytes(next) };
					break;
				}
				case "unwilling_cohort": {
					// Back off in TIME, no spatial move; the caller restarts at d_max after the delay.
					return { kind: "retry_later", afterMs: reply.retryAfterMs ?? backoffRetryMs(0) };
				}
				default: {
					// Exhaustive over RegisterResult; an unknown result is treated as a temporal decline.
					return { kind: "retry_later", afterMs: backoffRetryMs(0) };
				}
			}
		}
	}
}

/** Build a {@link WalkEngine} over the injected router, addressing, `d_max`, and message factory. */
export function createWalkEngine(deps: WalkEngineDeps): WalkEngine {
	return new RouterWalkEngine(deps);
}
