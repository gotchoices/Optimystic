/**
 * Cohort-topic substrate — real bootstrap-evidence verifiers (db-p2p side of the anti-DoS gate).
 *
 * db-core owns the *policy* (which evidence kinds satisfy which tier) and the crypto-free envelope /
 * bound-image / PoW-preimage helpers (`antidos/bootstrap-evidence-envelope.ts`); it deliberately embeds
 * no specific PoW or reputation scheme. This module supplies the **self-contained cryptographic checks**
 * the host injects into `createBootstrapEvidence`, binding the node's `RingHash` (the same SHA-256 the
 * addressing uses) and the cohort-topic peer-key `verifyPeerSig` — no new crypto dependency.
 *
 * Both verifiers are **synchronous** (one hash, or one signature verify + two reputation-map reads) and
 * **total** — any parse / decode / verify failure on attacker-supplied input yields `false`, never a
 * throw — because `BootstrapEvidence.verify` runs inside `member-engine.ts`'s `runGuards` on every
 * register and must do no network I/O (that would itself be a DoS amplifier).
 */

import {
	parseBootstrapEvidenceEnvelope,
	powPreimage,
	bootstrapBoundImage,
	meetsDifficulty,
	DEFAULT_POW_DIFFICULTY_BITS,
	b64urlToBytes,
	type IRingHash,
	type RegisterV1,
} from "@optimystic/db-core";
import { DEFAULT_THRESHOLDS } from "../reputation/types.js";
import { verifyPeerSig } from "./peer-sig.js";
import { bytesToPeerIdString } from "./peer-codec.js";

/**
 * The slice of a peer-reputation service the bootstrap-evidence referee verifier consults — a subset of
 * {@link import("../reputation/types.js").IPeerReputation} that `PeerReputationService` satisfies
 * directly. "Sufficient reputation" is **stronger than mere non-ban**: the referee must be *both* not
 * banned *and* below the deprioritize threshold.
 */
export interface BootstrapReputationView {
	/** True when `peerId` (a peer-id string) is banned / excluded from operations. */
	isBanned(peerId: string): boolean;
	/** Effective reputation score for `peerId` (0 = a clean, unseen peer). Lower is better. */
	getScore(peerId: string): number;
}

/**
 * The default "sufficient reputation" cutoff: a referee with `score < deprioritize` is reputable enough
 * to endorse a bootstrap. Mirrors the reputation service's default `deprioritize` threshold (20) so a
 * default-configured node and the gate agree on "sufficient". Strict `<`, so a referee *at* the
 * threshold is not sufficient.
 */
export const DEFAULT_DEPRIORITIZE_THRESHOLD = DEFAULT_THRESHOLDS.deprioritize;

/** Inputs to {@link createPoWVerifier}. */
export interface PoWVerifierDeps {
	/** The node's ring hash (SHA-256) — the same `H` the addressing uses; hashes the PoW preimage. */
	readonly hash: IRingHash;
	/** Required leading-zero bits. Default {@link DEFAULT_POW_DIFFICULTY_BITS}. `0` admits any nonce (test). */
	readonly bits?: number;
}

/**
 * A real proof-of-work verifier for the T2/T3 evidence path. Self-contained — no subsystem, one hash.
 *
 * ```
 * env = parseBootstrapEvidenceEnvelope(reg); if (!env?.pow) return false
 * h = hash.H(powPreimage(reg, b64urlToBytes(env.pow.nonce)))
 * return meetsDifficulty(h, bits)
 * ```
 *
 * The preimage binds `(topicId, tier, participantCoord, timestamp)` (via {@link bootstrapBoundImage}),
 * so a PoW minted for one topic / peer / time cannot bootstrap another. Any absent `pow`, malformed
 * envelope, or non-base64url nonce → `false` (fails closed).
 */
export function createPoWVerifier(deps: PoWVerifierDeps): (reg: RegisterV1) => boolean {
	const bits = deps.bits ?? DEFAULT_POW_DIFFICULTY_BITS;
	return (reg: RegisterV1): boolean => {
		try {
			const env = parseBootstrapEvidenceEnvelope(reg);
			if (env?.pow === undefined) {
				return false; // not offered / not a PoW envelope
			}
			const nonce = b64urlToBytes(env.pow.nonce);
			return meetsDifficulty(deps.hash.H(powPreimage(reg, nonce)), bits);
		} catch {
			return false; // any decode / hash failure on attacker input → fail closed
		}
	};
}

/** Inputs to {@link createReputationVerifier}. */
export interface ReputationVerifierDeps {
	/** Local reputation view the referee is scored against (not banned + below the threshold). */
	readonly reputation: BootstrapReputationView;
	/** Strict "sufficient reputation" cutoff. Default {@link DEFAULT_DEPRIORITIZE_THRESHOLD}. */
	readonly deprioritizeThreshold?: number;
}

/**
 * A real reputation-endorsement verifier: a *referee* peer endorses the bootstrap by peer-key-signing
 * the {@link bootstrapBoundImage}, and the cohort checks the signature **and** that the referee is
 * sufficiently reputable in the **local** reputation view.
 *
 * ```
 * env = parseBootstrapEvidenceEnvelope(reg); if (!env?.reputation) return false
 * refereeBytes = b64urlToBytes(env.reputation.referee)
 * if (!verifyPeerSig(refereeBytes, bootstrapBoundImage(reg), b64urlToBytes(env.reputation.sig))) return false
 * refereeId = bytesToPeerIdString(refereeBytes)
 * return !reputation.isBanned(refereeId) && reputation.getScore(refereeId) < deprioritizeThreshold
 * ```
 *
 * The `referee` MAY equal the participant (a reputable participant self-vouches with its own peer key).
 * An unknown referee scores `0` (a clean, unseen peer) and so is sufficient; a referee exactly *at* the
 * threshold is not (strict `<`). Bad sig / banned / over-threshold / malformed → `false` (fails closed).
 */
export function createReputationVerifier(deps: ReputationVerifierDeps): (reg: RegisterV1) => boolean {
	const threshold = deps.deprioritizeThreshold ?? DEFAULT_DEPRIORITIZE_THRESHOLD;
	return (reg: RegisterV1): boolean => {
		try {
			const env = parseBootstrapEvidenceEnvelope(reg);
			if (env?.reputation === undefined) {
				return false; // not offered / not a reputation envelope
			}
			const refereeBytes = b64urlToBytes(env.reputation.referee);
			const sig = b64urlToBytes(env.reputation.sig);
			if (!verifyPeerSig(refereeBytes, bootstrapBoundImage(reg), sig)) {
				return false; // signature does not bind this register's tuple to the referee key
			}
			const refereeId = bytesToPeerIdString(refereeBytes);
			return !deps.reputation.isBanned(refereeId) && deps.reputation.getScore(refereeId) < threshold;
		} catch {
			return false; // any decode / verify failure on attacker input → fail closed
		}
	};
}
