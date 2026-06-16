/**
 * Reactivity — per-cohort Edge/Core policy (`docs/reactivity.md` §Per-cohort policy).
 *
 * Reactivity is **T3 (luxury)** at the cohort-topic layer. Two consequences are enforced here, the
 * authoritative home for the reactivity producer-side policy:
 *
 *  1. **Edge nodes never serve as reactivity forwarders** — only as subscribers. A T3 *consumer* is fine
 *     on Edge (a phone wants notifications); a T3 *producer* is off in the Edge profile. The willingness
 *     check ({@link import("../cohort-topic/willingness.js")}) already declines T3 admission on an Edge
 *     node because `edgeProfile().willingTiers` excludes {@link Tier.T3}; this module adds the *reactivity*
 *     gate at the point a node decides whether to instantiate a {@link PushState} / become a forwarder, so
 *     the decision is explicit and testable rather than implicit in cohort admission.
 *  2. **`delta_max` is Edge 0 / Core 4096** — the authoritative plumbing the origination ticket only
 *     *consumed*. Re-exported here from {@link import("./config.js")} so the policy surface is singular.
 *
 * The per-cohort topic budget (`topics_max`) bounds the collections a cohort serves; reactivity needs no
 * admission policy beyond the cohort-topic default, so it is not re-implemented here.
 */

import { Tier, type NodeProfile } from "../cohort-topic/tiers.js";
import { deltaMaxForProfile } from "./config.js";
import { PushState, type PushStateInit } from "./push-state.js";

/**
 * Whether a node with `profile` may serve as a reactivity **forwarder** (T3 producer). `true` only when
 * the profile is willing to forward T3 — Core by default, an operator-narrowable Core, never Edge.
 * Equivalent to `profile.willingTiers.has(Tier.T3)`: Edge's willing set is `{T0, T1}`, so this is `false`
 * on every Edge node and on a Core node an operator has restricted away from T3.
 */
export function mayServeAsReactivityForwarder(profile: NodeProfile): boolean {
	return profile.willingTiers.has(Tier.T3);
}

/** A subscriber-only node (Edge, or a Core narrowed off T3) attempted to instantiate a reactivity forwarder. */
export class ReactivityForwarderForbiddenError extends Error {
	constructor(readonly profileKind: NodeProfile["kind"]) {
		super(`reactivity: a ${profileKind} node that does not forward T3 cannot instantiate a forwarder (subscriber-only)`);
		this.name = "ReactivityForwarderForbiddenError";
	}
}

/**
 * Instantiate a forwarder {@link PushState} **only if** `profile` may forward T3. Returns `undefined` for a
 * subscriber-only node (Edge, or a Core narrowed off T3) — the caller does not become a forwarder, leaving
 * it a pure subscriber. This is the explicit gate the §Per-cohort policy "Edge nodes never serve as
 * reactivity forwarders" rule names; a node consults it before allocating any per-collection push state.
 */
export function instantiateForwarderPushState(profile: NodeProfile, init: PushStateInit): PushState | undefined {
	return mayServeAsReactivityForwarder(profile) ? new PushState(init) : undefined;
}

/**
 * Like {@link instantiateForwarderPushState} but **throws** {@link ReactivityForwarderForbiddenError} on a
 * subscriber-only node, for call sites that treat an Edge forwarder attempt as a programming error rather
 * than a silent no-op (e.g. a host wiring that should never route forwarder duty to an Edge node).
 */
export function requireForwarderPushState(profile: NodeProfile, init: PushStateInit): PushState {
	if (!mayServeAsReactivityForwarder(profile)) {
		throw new ReactivityForwarderForbiddenError(profile.kind);
	}
	return new PushState(init);
}

/**
 * The effective reactivity producer policy for a node profile: whether it may forward, and its `delta_max`
 * budget (Edge 0 — reject inbound `delta`, re-read the chain; Core 4096). The single struct a host reads to
 * configure reactivity on a node (`docs/reactivity.md` §Per-cohort policy, §Delta payloads).
 */
export interface ReactivityNodePolicy {
	/** Whether this node may instantiate a forwarder / become a T3 producer. */
	readonly mayForward: boolean;
	/** `delta_max` (bytes): Core 4096, Edge 0 (declines deltas). */
	readonly deltaMaxBytes: number;
}

/** Resolve the {@link ReactivityNodePolicy} for a profile (forwarder eligibility + `delta_max`). */
export function reactivityNodePolicy(profile: NodeProfile): ReactivityNodePolicy {
	return { mayForward: mayServeAsReactivityForwarder(profile), deltaMaxBytes: deltaMaxForProfile(profile) };
}
