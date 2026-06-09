/**
 * Reactivity — forwarder receive path (`docs/reactivity.md` §Propagation).
 *
 * A receiving forwarder primary, for each inbound notification:
 *  1. **verifies** the threshold signature against the tail cohort's `MembershipCertV1`;
 *  2. runs the **dedupe** check (sliding `(revision, sigDigest)` window);
 *  3. **appends** to the replay buffer;
 *  4. **forwards the unmodified notification** to its own direct subscribers and child cohorts.
 *
 * This module owns steps 1–3 and the forward *decision* (step 4's transport — dialing each subscriber's
 * primary and each child cohort — is the db-p2p binding). Forwarders never re-sign: a compromised
 * forwarder can drop or delay, but cannot forge. An unverifiable notification is dropped **before**
 * touching the dedupe set or buffer, so a forged payload can neither poison dedupe nor occupy a ring
 * slot. The buffer + dedupe set are gossiped across the cohort by the host's gossip cadence (see
 * {@link PushState}), so any member can serve a replay.
 */

import { dedupeKey, sigDigest } from "./notification.js";
import type { PushState } from "./push-state.js";
import type { NotificationV1 } from "./wire.js";
import type { NotificationVerifier } from "./verify.js";
import type { IRingHash } from "../cohort-topic/ports.js";

/** The forwarder's decision for one inbound notification. */
export type ForwardDecision =
	/** Verified, fresh: append to buffer and fan out unmodified. */
	| "forward"
	/** Already in the dedupe set: drop silently (an honest retransmit or merge duplicate). */
	| "duplicate"
	/** Signature did not verify against the tail cohort: drop without buffering. */
	| "untrusted";

/** Drives the forwarder receive path over one collection's {@link PushState}. */
export interface ReactivityForwarder {
	/** The per-collection push state this forwarder serves. */
	readonly state: PushState;
	/**
	 * Run verify → dedupe → append for one inbound notification, returning the forward decision. The
	 * caller fans the *unmodified* notification out only on `"forward"`.
	 */
	receive(n: NotificationV1, now: number): Promise<ForwardDecision>;
}

/** Construction inputs for a {@link ReactivityForwarder}. */
export interface ReactivityForwarderDeps {
	readonly state: PushState;
	readonly verifier: NotificationVerifier;
	/** Ring hash for the `sigDigest` dedupe key (must match the verifier's). Default db-core SHA-256. */
	readonly hash?: IRingHash;
}

class PushStateForwarder implements ReactivityForwarder {
	readonly state: PushState;

	constructor(private readonly deps: ReactivityForwarderDeps) {
		this.state = deps.state;
	}

	async receive(n: NotificationV1, now: number): Promise<ForwardDecision> {
		// 1. Verify end-to-end before any state mutation — a forged notification touches nothing.
		const verdict = await this.deps.verifier.verify(n);
		if (verdict !== "verified") {
			return "untrusted";
		}
		// 2. Dedupe on `(revision, sigDigest)`. Already-seen → drop silently.
		const digest = sigDigest(n.sig, this.deps.hash);
		if (this.state.dedupe.observe(n.revision, digest) === "duplicate") {
			return "duplicate";
		}
		// 3. Append the full signed notification to the replay ring (gossiped across the cohort).
		this.state.replayBuffer.append({ revision: n.revision, payload: n, receivedAt: now });
		if (n.revision > this.state.lastRevision) {
			this.state.lastRevision = n.revision;
		}
		return "forward";
	}
}

/** Build a {@link ReactivityForwarder} over a collection's {@link PushState} and a verifier. */
export function createReactivityForwarder(deps: ReactivityForwarderDeps): ReactivityForwarder {
	return new PushStateForwarder(deps);
}

/** The dedupe key a forwarder would compute for a notification (exposed for tests/diagnostics). */
export function notificationDedupeKey(n: NotificationV1, hash?: IRingHash): string {
	return dedupeKey(n.revision, n.sig, hash);
}
