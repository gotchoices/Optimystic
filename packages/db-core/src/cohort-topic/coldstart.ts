/**
 * Cohort-topic substrate — cold-start instantiation.
 *
 * Transcribed from `docs/cohort-topic.md` §Cold-start instantiation and folded back from the
 * simulator-validated `packages/substrate-simulator/src/walk.ts` (the `followOn` / `bootstrap`
 * instantiation paths). A **cold** cohort — one holding no forwarder state for a topic — instantiates
 * as a forwarder for `T` when:
 *
 * - it receives a `RegisterV1` for `T` it does not yet serve, AND
 * - the registration is a legitimate growth point: its `bootstrap: true` flag is set (the root
 *   cold-start case) **or** it arrived as a follow-on to a parent cohort's `Promoted` redirect, AND
 * - a quorum of cohort members is willing to serve `T` at the registration's tier.
 *
 * The `followOn` signal **is** carried on the wire (`RegisterV1.followOn`), set only on the dedicated
 * re-issue a participant sends after a parent cohort's `Promoted` redirect target answered `NoState`
 * (the deeper child is cold). A cold high-tier cohort still returns `NoState` to a *speculative* `d_max`
 * probe (neither flag set), but the single-direction walk means the only registrations that reach a cold
 * tier-`(d+1)` cohort carrying `followOn: true` are those that followed the parent's `Promoted` redirect.
 * The db-p2p cohort host derives `ctx.followOn` from the wire flag (`followOn: reg.followOn === true`) and
 * db-core takes it as an explicit input to {@link shouldInstantiate}, keeping this module FRET-free. Because
 * the flag is participant-forgeable, a `followOn: true` register is gated by the **same** tier-dependent
 * bootstrap-evidence policy a `bootstrap: true` cold-root register passes (§Anti-DoS), so an unbacked
 * follow-on never reaches this instantiation decision.
 *
 * Once instantiated, the new forwarder **registers itself with its tier-`(d − 1)` parent at first
 * opportunity** by sending a child-link the parent authenticates + records; until that link is acked
 * (`linked`) it {@link Forwarder.acceptsParticipants | accepts participants} but
 * {@link Forwarder.servesParentOps | holds} notifications/queries that need parent involvement. The root
 * (tree tier 0) has no parent and is serving immediately.
 *
 * **Just-promoted burst (GROUNDING-resolved: bounce, don't buffer).** A cohort that has just promoted
 * but whose tier-`(d+1)` isn't fully instantiated yet, on a burst of new same-tier registrations,
 * replies `Promoted(d+1)` ({@link promotedRedirectReply}) — a cheap single RPC. It does **not** buffer
 * the registrations and does **not** decline with `UnwillingCohort`; the promotion sticky window
 * (`T_promote_sticky`) keeps it in promoted mode through the burst.
 */

import { attachTopicTraffic } from "./traffic.js";
import { bytesKey } from "./registration/bytes.js";
import type { RegisterReplyV1, TopicTrafficV1 } from "./wire/types.js";

/** Inputs to the cold-start admission gate. */
export interface ColdStartTrigger {
	/** `RegisterV1.bootstrap` — the root cold-start request flag. */
	readonly bootstrap: boolean;
	/** This register arrived as a follow-on to a parent's `Promoted` redirect (db-p2p-determined). */
	readonly followOn: boolean;
	/** A quorum of cohort members is willing to serve the topic at this tier. */
	readonly quorumWilling: boolean;
}

/**
 * Whether a cold cohort should instantiate forwarder state for an inbound register: it must be a
 * legitimate growth point (`bootstrap` root case **or** a `Promoted` follow-on) **and** have a willing
 * quorum. A speculative `d_max` probe (neither flag set) yields `false`, so the walk gets `NoState`
 * and steps toward the root instead of forking a parallel branch (§Cold-start; §Why the caller
 * doesn't walk on UnwillingCohort).
 */
export function shouldInstantiate(trigger: ColdStartTrigger): boolean {
	return (trigger.bootstrap || trigger.followOn) && trigger.quorumWilling;
}

/** Lifecycle phase of a freshly-instantiated forwarder. */
export type ForwarderPhase =
	/** Instantiated, registering with the parent; accepts participants, holds parent-involving ops. */
	| "awaiting_parent"
	/** Fully linked (parent acked, or root with no parent); serves everything. */
	| "serving";

/**
 * A freshly cold-started forwarder for one topic at this cohort. Holds the "registered with parent
 * yet?" state that gates parent-involving operations during the link-up window.
 */
export interface Forwarder {
	/** Tree tier `d` this forwarder serves the topic at. */
	readonly tier: number;
	/** Current lifecycle phase. */
	phase(): ForwarderPhase;
	/** Accept new participants? True from instantiation onward (even before the parent ack). */
	acceptsParticipants(): boolean;
	/** Serve an operation needing parent involvement (notifications/queries)? Only once `serving`. */
	servesParentOps(): boolean;
	/** Mark the parent-registration RPC acked → transition to `serving`. Idempotent; no-op at the root. */
	onParentAck(): void;
}

class ForwarderState implements Forwarder {
	private serving: boolean;

	constructor(readonly tier: number, hasParent: boolean) {
		// The root (tree tier 0 / no parent) has nothing to hand off to — it serves immediately.
		this.serving = !hasParent;
	}

	phase(): ForwarderPhase {
		return this.serving ? "serving" : "awaiting_parent";
	}

	acceptsParticipants(): boolean {
		return true;
	}

	servesParentOps(): boolean {
		return this.serving;
	}

	onParentAck(): void {
		this.serving = true;
	}
}

/**
 * Construct a forwarder. A tier-`0` forwarder (the root) has no parent and starts `serving`; a deeper
 * forwarder starts `awaiting_parent` until {@link Forwarder.onParentAck} fires.
 */
export function createForwarder(tier: number): Forwarder {
	if (!Number.isInteger(tier) || tier < 0) {
		throw new RangeError(`forwarder tier must be a non-negative integer, got ${tier}`);
	}
	return new ForwarderState(tier, tier > 0);
}

/**
 * Build a `Promoted(targetTier)` redirect reply — used both for the normal promotion redirect and for
 * the just-promoted-burst bounce (the registrations arriving at a promoted cohort while its child tier
 * is still instantiating). The outgoing cohort's `topicTraffic` is attached when supplied, so the
 * redirected participant can estimate whether the target tier is hot (§Topic traffic signal).
 */
export function promotedRedirectReply(targetTier: number, traffic?: TopicTrafficV1): RegisterReplyV1 {
	if (!Number.isInteger(targetTier) || targetTier < 1) {
		throw new RangeError(`promoted targetTier must be an integer ≥ 1, got ${targetTier}`);
	}
	const reply: RegisterReplyV1 = { v: 1, result: "promoted", targetTier };
	return traffic !== undefined ? attachTopicTraffic(reply, traffic) : reply;
}

/**
 * Registers a newly-instantiated forwarder with its tier-`(d − 1)` parent; resolves only when the parent
 * authenticates + records the child and returns a `linked` ack. A `rejected` reply (bad coord binding /
 * failed threshold verify) or an unreachable parent rejects the promise, so the forwarder stays
 * `awaiting_parent` for a later retry.
 */
export interface ParentRegistrar {
	/**
	 * Register the forwarder for `topicId` (served at tree tier `tier`, i.e. `d`) with the cohort at
	 * `parentCoord`; resolves on a `linked` ack. `opTier` is the topic's *capacity* tier (T0–T3), threaded so
	 * the transport can stamp a well-formed child-link frame; absent when the caller has no op-tier context
	 * (the cohort host always supplies it from the instantiating `RegisterV1`).
	 */
	registerWithParent(topicId: Uint8Array, parentCoord: Uint8Array, tier: number, opTier?: number): Promise<void>;
}

export interface ColdStartManagerDeps {
	/** Drives the parent-registration RPC (db-p2p binds it to the router). */
	parentRegistrar: ParentRegistrar;
}

/**
 * Tracks cold-started forwarders for a cohort and drives each one's parent registration. Keyed by
 * `topicId`; idempotent per topic (a second instantiate for an already-tracked topic returns the
 * existing forwarder).
 */
export interface ColdStartManager {
	/**
	 * Instantiate (or return the existing) forwarder for `topicId` at tree tier `tier` (`d`). For a
	 * deeper-than-root forwarder this kicks off parent registration in the background and flips the
	 * forwarder to `serving` on ack. The returned forwarder accepts participants immediately. `opTier`
	 * (the topic's T0–T3 capacity tier) is forwarded to the parent registrar for the link frame.
	 */
	instantiate(topicId: Uint8Array, tier: number, parentCoord?: Uint8Array, opTier?: number): Forwarder;
	/** The tracked forwarder for `topicId`, or `undefined`. */
	get(topicId: Uint8Array): Forwarder | undefined;
	/**
	 * Drop the forwarder for `topicId` (budget eviction / teardown). Idempotent; a no-op if the topic is
	 * not tracked. After this, {@link get} returns `undefined` for `topicId`, so the cohort no longer
	 * reports serving it via cold-start state.
	 */
	remove(topicId: Uint8Array): void;
	/**
	 * Whether this manager currently tracks any forwarder. The host's idle-engine eviction reads this to
	 * avoid reclaiming a cohort that holds a live (possibly `awaiting_parent`) cold-start forwarder.
	 */
	hasForwarders(): boolean;
}

class TrackingColdStartManager implements ColdStartManager {
	private readonly forwarders = new Map<string, Forwarder>();

	constructor(private readonly deps: ColdStartManagerDeps) {}

	instantiate(topicId: Uint8Array, tier: number, parentCoord?: Uint8Array, opTier?: number): Forwarder {
		const key = bytesKey(topicId);
		const existing = this.forwarders.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const forwarder = createForwarder(tier);
		this.forwarders.set(key, forwarder);
		if (tier > 0) {
			if (parentCoord === undefined) {
				throw new Error(`cold-start of a tier-${tier} forwarder requires a parentCoord`);
			}
			// Register with the parent at first opportunity; flip to serving on ack. A failed parent
			// registration leaves the forwarder accepting participants but holding parent-involving ops,
			// so a later retry (driven by the host) can complete the link-up — surfaced, not swallowed.
			void this.deps.parentRegistrar
				.registerWithParent(topicId, parentCoord, tier, opTier)
				.then(() => forwarder.onParentAck())
				.catch((err: unknown) => {
					console.warn(`cohort-topic cold-start: parent registration for tier-${tier} forwarder failed`, err);
				});
		}
		return forwarder;
	}

	get(topicId: Uint8Array): Forwarder | undefined {
		return this.forwarders.get(bytesKey(topicId));
	}

	remove(topicId: Uint8Array): void {
		// Idempotent: `Map.delete` on an absent key is a safe no-op, so a double-remove (or a remove of a
		// never-instantiated topic) does nothing.
		this.forwarders.delete(bytesKey(topicId));
	}

	hasForwarders(): boolean {
		return this.forwarders.size > 0;
	}
}

/** Build a {@link ColdStartManager} over the injected parent registrar. */
export function createColdStartManager(deps: ColdStartManagerDeps): ColdStartManager {
	return new TrackingColdStartManager(deps);
}
