/**
 * Cohort-topic substrate — participant-side bootstrap-evidence builder (db-p2p side of the `buildBootstrapEvidence` seam).
 *
 * Implements the db-core `CohortTopicServiceDeps.buildBootstrapEvidence` seam for the node's participant
 * role: on a cold-start `bootstrap: true` re-issue the service calls this with the register's own
 * canonical `(topicId, tier, participantCoord, timestamp)` tuple (base64url wire strings) and attaches the
 * returned bytes — **before** signing — into `RegisterV1.bootstrapEvidence`.
 *
 * - **Tier ≤ maxNoPowTier (T0/T1):** proof-of-work is not the expected evidence. With an `endorse`
 *   capability (a key-ful node) we mint a *self-vouch reputation endorsement* over the bound image so a
 *   configured cohort's referee verifier admits it; without one we return `undefined` (parent-reference
 *   origination is the follow-on `cohort-topic-bootstrap-parent-reference`). A T0/T1 bootstrap with no
 *   evidence is denied by a configured cohort until that lands — but the single-tier-0 milestone's
 *   cohort-side tests construct evidence directly, so this does not block them.
 * - **Tier ≥ maxNoPowTier+1 (T2/T3):** mint a proof-of-work — loop nonces until
 *   `meetsDifficulty(hash.H(powPreimage(reg, nonce)), bits)`. Bound work ≈ `2^bits` hashes (default 20 ≈
 *   ~1 M, sub-second). The loop is capped ({@link DEFAULT_POW_MAX_ITERATIONS}); on cap-exceeded it returns
 *   `undefined` so the register proceeds without evidence rather than ever hanging the register path.
 *
 * Returns the **raw** envelope JSON bytes (`utf8(JSON.stringify(env))`), NOT the already-base64url string
 * from `serializeBootstrapEvidenceEnvelope` — the service base64url-encodes them itself (returning the
 * serialized string's bytes would double-encode the field). We obtain the raw bytes by decoding the
 * canonical serializer output once, so the byte layout matches exactly what a verifier reconstructs.
 */

import {
	serializeBootstrapEvidenceEnvelope,
	bootstrapBoundImage,
	powPreimage,
	meetsDifficulty,
	DEFAULT_POW_DIFFICULTY_BITS,
	DEFAULT_MAX_NO_POW_TIER,
	bytesToB64url,
	b64urlToBytes,
	type IRingHash,
	type BootstrapBoundFields,
	type BootstrapEvidenceEnvelopeV1,
	type ReputationEvidenceV1,
} from "@optimystic/db-core";
import { randomBytes } from "@libp2p/crypto";

/**
 * Defensive cap on the PoW nonce search (~16.7 M hashes). Comfortably above the ~`2^bits` expected for
 * the default 20-bit difficulty (~1 M), so a real miner solves long before the cap; hitting it (a
 * mis-set, very-high `bits`) returns `undefined` rather than hanging the register path.
 */
export const DEFAULT_POW_MAX_ITERATIONS = 1 << 24;

/** The bound tuple the service hands the builder — the same shape a verifier binds via {@link bootstrapBoundImage}. */
export type BootstrapEvidenceBuildParams = BootstrapBoundFields;

/** Inputs to {@link createBootstrapEvidenceBuilder}. */
export interface BootstrapEvidenceBuilderDeps {
	/** The node's ring hash (SHA-256) — the same `H` the PoW verifier checks against. */
	readonly hash: IRingHash;
	/** Difficulty bits to mint at. Default {@link DEFAULT_POW_DIFFICULTY_BITS}. `0` solves on the first nonce (test). */
	readonly bits?: number;
	/** Highest tier exempt from PoW (T0/T1 → 1). Default {@link DEFAULT_MAX_NO_POW_TIER}. */
	readonly maxNoPowTier?: number;
	/** Nonce-search cap. Default {@link DEFAULT_POW_MAX_ITERATIONS}. */
	readonly maxIterations?: number;
	/**
	 * Optional self-vouch endorsement capability for a key-ful node: signs the bound image with the node's
	 * peer key and returns the referee (= self) + signature. Supplied → T0/T1 mints a reputation
	 * endorsement (the interim T0/T1 path until parent-reference origination lands); absent → T0/T1 carries
	 * no evidence.
	 */
	readonly endorse?: (boundImage: Uint8Array) => Promise<ReputationEvidenceV1>;
}

/**
 * Build the {@link import("@optimystic/db-core").CohortTopicServiceDeps.buildBootstrapEvidence} seam:
 * a `(params) => Promise<Uint8Array | undefined>` that mints the cold-start evidence for the node's own
 * register. PoW for T2/T3; a self-vouch reputation endorsement (when `endorse` is supplied) or nothing
 * for T0/T1. Never throws and never hangs (the nonce loop is capped).
 */
export function createBootstrapEvidenceBuilder(
	deps: BootstrapEvidenceBuilderDeps,
): (params: BootstrapEvidenceBuildParams) => Promise<Uint8Array | undefined> {
	const bits = deps.bits ?? DEFAULT_POW_DIFFICULTY_BITS;
	const maxNoPowTier = deps.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;
	const maxIterations = deps.maxIterations ?? DEFAULT_POW_MAX_ITERATIONS;

	return async (params: BootstrapEvidenceBuildParams): Promise<Uint8Array | undefined> => {
		const bound: BootstrapBoundFields = {
			topicId: params.topicId,
			tier: params.tier,
			participantCoord: params.participantCoord,
			timestamp: params.timestamp,
		};

		if (params.tier <= maxNoPowTier) {
			// T0/T1: PoW is not the expected evidence. A key-ful node self-vouches; otherwise no evidence
			// (the parent-reference path is the follow-on ticket — documented deferral).
			if (deps.endorse === undefined) {
				return undefined;
			}
			const reputation = await deps.endorse(bootstrapBoundImage(bound));
			return rawEnvelopeBytes({ v: 1, reputation });
		}

		// T2/T3: mint a proof-of-work — search nonces until the digest meets the difficulty target.
		for (let i = 0; i < maxIterations; i++) {
			const nonce = randomBytes(16); // CSPRNG nonce — bound to the register tuple via the preimage
			if (meetsDifficulty(deps.hash.H(powPreimage(bound, nonce)), bits)) {
				return rawEnvelopeBytes({ v: 1, pow: { nonce: bytesToB64url(nonce) } });
			}
		}
		// Cap exceeded (mis-set difficulty): attach nothing rather than hang. A configured cohort denies it.
		return undefined;
	};
}

/**
 * The raw envelope JSON bytes the service expects (`utf8(JSON.stringify(env))`). Reuses the db-core
 * canonical serializer (fixed field order, deterministic JSON) and decodes its base64url output back to
 * the underlying bytes — so the layout is byte-identical to what a verifier reconstructs, with zero
 * duplicated canonicalization here.
 */
function rawEnvelopeBytes(env: BootstrapEvidenceEnvelopeV1): Uint8Array {
	return b64urlToBytes(serializeBootstrapEvidenceEnvelope(env));
}
