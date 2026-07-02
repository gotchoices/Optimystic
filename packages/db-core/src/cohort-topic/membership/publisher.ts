/**
 * Cohort-topic substrate — cohort-side `MembershipCertV1` publication.
 *
 * Per `docs/cohort-topic.md` §Membership snapshots: the cohort publishes a threshold-signed
 * `MembershipCertV1`
 *
 * - at stabilization, and on any change to the cohort identity — the epoch `H(sorted all members)`,
 *   so *any* member change (head or tail) forces a fresh publish ({@link MembershipCertPublisher.onStabilized});
 * - refreshed every `T_membership_refresh` (default 5 min) ({@link MembershipCertPublisher.tick}).
 *
 * The publisher is db-core logic over the {@link CohortSigner} (threshold sign) and the
 * {@link IMembershipPublishSink} (serve/advertise). It never imports FRET. Members are sorted
 * ascending for the cert (matching the sharding order); the snapshot's `cohortEpoch` is the full
 * cohort identity, and a change to it across a publish forces a fresh publish.
 */

import type { IMembershipPublishSink } from "../ports.js";
import { bytesToB64url, encodeCohortMessage } from "../wire/codec.js";
import type { MembershipCertV1 } from "../wire/types.js";
import { compareBytes } from "../registration/bytes.js";
import { type CohortSigner } from "../sig/threshold.js";
import { membershipCertSigningPayload, type MembershipCertSignable } from "../sig/payloads.js";

/** Default membership-cert refresh interval (`T_membership_refresh`). */
export const DEFAULT_T_MEMBERSHIP_REFRESH_MS = 5 * 60_000;

/**
 * The canonical {@link MembershipCertSignable} for a stabilized snapshot: members sorted ascending (the
 * cert / sharding order), byte fields base64url-encoded, over exactly the threshold-signed fields. The
 * publisher signs `membershipCertSigningPayload` of this; a rotation-attestation **producer** (db-p2p,
 * `cohort-topic-trust-anchor-rotation-production`) signs the *successor* cert's image through the SAME
 * helper, so signer and verifier never canonicalize the cert independently (signature-image agreement —
 * a mismatch makes the db-core chain check fail).
 */
export function membershipCertSignable(snapshot: CohortSnapshot): MembershipCertSignable {
	const sorted = [...snapshot.members].sort(compareBytes);
	return {
		cohortCoord: bytesToB64url(snapshot.coord),
		cohortEpoch: bytesToB64url(snapshot.cohortEpoch),
		members: sorted.map(bytesToB64url),
		stabilizedAt: snapshot.stabilizedAt,
	};
}

/** A stabilized cohort snapshot the publisher attests. */
export interface CohortSnapshot {
	/** Cohort coord (32 bytes). */
	coord: Uint8Array;
	/** Cohort epoch for this snapshot. */
	cohortEpoch: Uint8Array;
	/** Cohort members (any order; the cert sorts them ascending). */
	members: readonly Uint8Array[];
	/** Unix ms this membership stabilized. */
	stabilizedAt: number;
	/** Optional FRET stabilization proof. */
	fretAttestation?: Uint8Array;
}

/**
 * A predecessor-cohort rotation attestation to attach to a fresh cert (an epoch rotation). The
 * predecessor cohort threshold-signs the **successor** cert's `membershipCertSigningPayload`; that
 * `(prevEpoch, rotationSig, rotationSigners)` triple lets a participant holding a trusted predecessor
 * verify the rotation is legitimate. Producing this triple is the db-p2p ticket
 * `cohort-topic-trust-anchor-rotation-production`; the publisher only attaches a provided one.
 */
export interface RotationAttestation {
	/** Predecessor cohort epoch this cert rotates from (32 bytes). */
	prevEpoch: Uint8Array;
	/** Predecessor cohort's threshold signature over the successor cert's signing payload. */
	rotationSig: Uint8Array;
	/** Predecessor cohort signers that produced {@link rotationSig}; `>= minSigs`. */
	rotationSigners: readonly Uint8Array[];
}

/** Cohort-side membership-cert publisher. */
export interface MembershipCertPublisher {
	/**
	 * Drive publication on a stabilization event. Publishes (and returns the cert) when the cohort identity
	 * (`cohortEpoch = H(sorted members)`) changed since the last publish — i.e. on **any** member change,
	 * head or tail — or on the first call; otherwise returns `undefined`. Pass `rotation` to attach a
	 * predecessor-cohort rotation attestation (an epoch rotation); omit it for the default non-rotation
	 * publish (no rotation fields are emitted).
	 */
	onStabilized(snapshot: CohortSnapshot, now: number, rotation?: RotationAttestation): Promise<MembershipCertV1 | undefined>;
	/**
	 * Periodic tick. Re-publishes (and returns the cert) when `T_membership_refresh` has elapsed since
	 * the last publish; otherwise returns `undefined`. Pass `rotation` to attach a rotation attestation.
	 */
	tick(snapshot: CohortSnapshot, now: number, rotation?: RotationAttestation): Promise<MembershipCertV1 | undefined>;
}

export interface MembershipCertPublisherDeps {
	signer: CohortSigner;
	sink: IMembershipPublishSink;
	refreshMs?: number;
	/**
	 * Accepted for call-site compatibility but no longer read by the publisher: the republish gate now keys
	 * on the full `cohortEpoch`, not the first `k − x` members, and the threshold-sign quorum lives in the
	 * {@link CohortSigner}. Kept so existing callers (host + db-p2p tests) compile unchanged.
	 */
	minSigs?: number;
	maxMessageBytes?: number;
}

class SigningMembershipCertPublisher implements MembershipCertPublisher {
	private readonly refreshMs: number;
	/** base64url of the last published snapshot's `cohortEpoch` — the full cohort-identity republish key. */
	private lastEpoch: string | undefined;
	private lastPublishedAt: number | undefined;

	constructor(private readonly deps: MembershipCertPublisherDeps) {
		this.refreshMs = deps.refreshMs ?? DEFAULT_T_MEMBERSHIP_REFRESH_MS;
	}

	async onStabilized(snapshot: CohortSnapshot, now: number, rotation?: RotationAttestation): Promise<MembershipCertV1 | undefined> {
		// NOTE: republish (and the caller's rotation attestation) now fire on ANY epoch change — any member
		// change, head or tail — not just first-(k − x) churn. Gated on an actual epoch change, never per
		// tick, so cost is bounded by real churn. If a high-churn cohort ever shows excess `/sign` or publish
		// load, reconsider a short debounce / batching here.
		const epoch = bytesToB64url(snapshot.cohortEpoch);
		if (this.lastEpoch !== undefined && this.lastEpoch === epoch) {
			return undefined; // cohort identity unchanged — no republish needed
		}
		return this.publish(snapshot, now, rotation);
	}

	async tick(snapshot: CohortSnapshot, now: number, rotation?: RotationAttestation): Promise<MembershipCertV1 | undefined> {
		if (this.lastPublishedAt !== undefined && now - this.lastPublishedAt < this.refreshMs) {
			return undefined;
		}
		return this.publish(snapshot, now, rotation);
	}

	private async publish(snapshot: CohortSnapshot, now: number, rotation?: RotationAttestation): Promise<MembershipCertV1> {
		const signable = membershipCertSignable(snapshot);
		const { thresholdSig, signers } = await this.deps.signer.thresholdSign(membershipCertSigningPayload(signable));
		const cert: MembershipCertV1 = {
			v: 1,
			...signable,
			thresholdSig: bytesToB64url(thresholdSig),
			signers: signers.map(bytesToB64url),
		};
		if (snapshot.fretAttestation !== undefined) {
			cert.fretAttestation = bytesToB64url(snapshot.fretAttestation);
		}
		// A rotation attestation (when given) signs *over* the cert's signing payload, so it is attached to the
		// envelope after signing and is not part of `membershipCertSigningPayload`. Omitted → no rotation fields.
		if (rotation !== undefined) {
			cert.prevEpoch = bytesToB64url(rotation.prevEpoch);
			cert.rotationSig = bytesToB64url(rotation.rotationSig);
			cert.rotationSigners = rotation.rotationSigners.map(bytesToB64url);
		}
		this.deps.sink.publish(encodeCohortMessage(cert, this.deps.maxMessageBytes));
		this.lastEpoch = bytesToB64url(snapshot.cohortEpoch);
		this.lastPublishedAt = now;
		return cert;
	}
}

/** Build a cohort-side {@link MembershipCertPublisher}. */
export function createMembershipCertPublisher(deps: MembershipCertPublisherDeps): MembershipCertPublisher {
	return new SigningMembershipCertPublisher(deps);
}
