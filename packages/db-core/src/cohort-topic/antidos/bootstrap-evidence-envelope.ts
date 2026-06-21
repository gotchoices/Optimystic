/**
 * Cohort-topic substrate — bootstrap-evidence envelope (anti-DoS, crypto-free).
 *
 * The on-the-wire structure a participant attaches to a cold-start `bootstrap: true` register, and the
 * byte-level canonicalization both sides agree on. This module owns only the **format** — the versioned
 * envelope, the canonical anti-replay bound image, and the proof-of-work puzzle's preimage/difficulty.
 * It embeds **no cryptography**: the actual PoW hashing, reputation-signature checks, and parent-topic
 * verification live in db-p2p (which binds the node's `RingHash` and peer-key crypto). The sibling
 * discipline of `wire/payloads.ts` / `sig/payloads.ts` — explicitly-ordered arrays, deterministic UTF-8
 * JSON, base64url without padding — so a participant who *mints* evidence and a cohort that *verifies*
 * it never re-canonicalize bytes independently.
 *
 * The envelope rides in the dedicated, signature-covered {@link RegisterV1.bootstrapEvidence} field
 * (not `appPayload`). A verifier reads only the kind its tier accepts; an absent kind, a malformed
 * envelope, or a wrong/future version all surface as "this kind not offered" (the parse is **total** —
 * like `verifyPeerSig`, any decode error yields `undefined`, never a throw), so a verifier fails its
 * check (→ `unwilling_cohort`) rather than crashing on attacker-supplied input.
 */

import { b64urlToBytes, bytesToB64url } from "../wire/codec.js";
import type { RegisterV1 } from "../wire/types.js";

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Proof-of-work evidence (T2/T3 path). `nonce` is base64url, bound via {@link powPreimage}. */
export interface PowEvidenceV1 {
	/** Base64url nonce; `hash(powPreimage(reg, nonce))` must satisfy {@link meetsDifficulty}. */
	nonce: string;
}

/** Signed parent-topic reference (all tiers). Both base64url; `sig` is over {@link parentRefSigningImage}. */
export interface ParentRefEvidenceV1 {
	/** The committed parent topic id, base64url. */
	parentTopicId: string;
	/** Participant peer-key signature over {@link parentRefSigningImage} (the bound tuple extended with `parentTopicId`), base64url. */
	sig: string;
}

/**
 * Reputation endorsement (T2/T3 path). `referee` is the endorsing peer-id-string bytes (base64url) and
 * `sig` is that referee's peer-key signature over the bound image. The referee MAY equal the
 * participant (a reputable participant self-vouches).
 */
export interface ReputationEvidenceV1 {
	/** Endorsing peer-id-string bytes, base64url. */
	referee: string;
	/** Referee's peer-key signature over the bound image, base64url. */
	sig: string;
}

/** V1 bootstrap-evidence envelope, base64url-encoded into {@link RegisterV1.bootstrapEvidence}. */
export interface BootstrapEvidenceEnvelopeV1 {
	v: 1;
	/** Proof-of-work (T2/T3 path). Absent → no PoW offered. */
	pow?: PowEvidenceV1;
	/** Signed parent-topic reference (all tiers). Absent → none offered. */
	parentRef?: ParentRefEvidenceV1;
	/** Reputation endorsement (T2/T3 path). Absent → none offered. */
	reputation?: ReputationEvidenceV1;
}

/**
 * The four register fields every bootstrap-evidence kind is bound to (the anti-replay tuple). The full
 * {@link RegisterV1} satisfies this, so a verifier passes its decoded register directly; the
 * participant-side builder passes just these fields (it has no full register yet).
 */
export type BootstrapBoundFields = Pick<RegisterV1, "topicId" | "tier" | "participantCoord" | "timestamp">;

/** Default PoW difficulty: leading zero bits required. ~2^bits hashes to mint, one hash to verify. */
export const DEFAULT_POW_DIFFICULTY_BITS = 20;

/**
 * The canonical bytes every bootstrap-evidence kind is bound to: `(topicId, tier, participantCoord,
 * timestamp)`. `topicId`/`participantCoord` are bound as their base64url wire strings verbatim (matching
 * `sig/payloads.ts`) so signer and verifier never re-canonicalize bytes independently. Binding all four
 * means evidence minted for one (topic, tier, peer, time) cannot be replayed for another; binding
 * `timestamp` additionally bounds a captured proof's reuse window, since the register replay guard drops
 * a `timestamp` older than its acceptance window.
 */
export function bootstrapBoundImage(reg: BootstrapBoundFields): Uint8Array {
	return utf8.encode(JSON.stringify([
		"BootstrapEvidenceV1",
		reg.topicId,
		reg.tier,
		reg.participantCoord,
		reg.timestamp,
	]));
}

/**
 * The canonical bytes a **signed parent-topic reference** binds: the {@link bootstrapBoundImage} tuple
 * `(topicId, tier, participantCoord, timestamp)` **extended with the referenced `parentTopicId`**, under a
 * distinct discriminator tag (`"BootstrapParentRefV1"`). Extending the image with `parentTopicId` means a
 * reference minted for one `(topic, tier, peer, time, parent)` cannot be lifted onto another register —
 * including onto a register naming a *different* parent; the distinct tag keeps it from colliding with a
 * {@link bootstrapBoundImage} reputation/PoW signature (domain separation). `topicId`/`participantCoord`/
 * `parentTopicId` are bound as their base64url wire strings verbatim, like {@link bootstrapBoundImage}, so
 * the participant who *signs* the reference and the cohort that *verifies* it never re-canonicalize bytes.
 */
export function parentRefSigningImage(reg: BootstrapBoundFields, parentTopicId: string): Uint8Array {
	return utf8.encode(JSON.stringify([
		"BootstrapParentRefV1",
		reg.topicId,
		reg.tier,
		reg.participantCoord,
		reg.timestamp,
		parentTopicId,
	]));
}

/**
 * The proof-of-work hash preimage: {@link bootstrapBoundImage} concatenated with `nonce`. db-p2p hashes
 * this (via the node's `RingHash`) and checks the digest against {@link meetsDifficulty}. Bound to the
 * register tuple ⇒ no cross-topic / cross-peer replay; cheap to verify (one hash + bit check), tunably
 * costly to produce.
 */
export function powPreimage(reg: BootstrapBoundFields, nonce: Uint8Array): Uint8Array {
	const image = bootstrapBoundImage(reg);
	const out = new Uint8Array(image.length + nonce.length);
	out.set(image, 0);
	out.set(nonce, image.length);
	return out;
}

/**
 * True iff the first `bits` most-significant bits of `hash` are zero (the PoW difficulty target). Bits
 * are read MSB-first per byte (mirroring `addressing.ts`'s `prefixBits`). `bits = 0` is trivially met
 * (lets a config disable PoW cost for tests); a non-finite `bits` is a guard-failure (never met); a
 * negative `bits` clamps to 0; `bits` larger than `hash.length * 8` requires every bit of `hash` to be
 * zero and so is effectively unsatisfiable for a random hash.
 */
export function meetsDifficulty(hash: Uint8Array, bits: number): boolean {
	if (!Number.isFinite(bits)) {
		return false; // NaN / ±Infinity → defensive guard, never satisfiable
	}
	let remaining = Math.floor(bits);
	if (remaining <= 0) {
		return true; // 0 (or clamped-negative) leading zero bits is trivially met
	}
	for (let i = 0; i < hash.length && remaining > 0; i++) {
		const byte = hash[i]!;
		if (remaining >= 8) {
			if (byte !== 0) {
				return false;
			}
			remaining -= 8;
		} else {
			// Check only the top `remaining` MSBs of this partial final byte (MSB-first).
			const mask = (0xff << (8 - remaining)) & 0xff;
			if ((byte & mask) !== 0) {
				return false;
			}
			remaining = 0;
		}
	}
	// Exhausted the hash before satisfying `bits` (oversize target) → unsatisfiable.
	return remaining === 0;
}

/** Serialize an envelope to the base64url JSON string carried in {@link RegisterV1.bootstrapEvidence}. */
export function serializeBootstrapEvidenceEnvelope(env: BootstrapEvidenceEnvelopeV1): string {
	// Rebuild in a fixed field order so serialization is a pure function of the logical content
	// (serialize∘parse is stable regardless of how a caller ordered the source object's keys).
	const out: BootstrapEvidenceEnvelopeV1 = { v: 1 };
	if (env.pow !== undefined) {
		out.pow = { nonce: env.pow.nonce };
	}
	if (env.parentRef !== undefined) {
		out.parentRef = { parentTopicId: env.parentRef.parentTopicId, sig: env.parentRef.sig };
	}
	if (env.reputation !== undefined) {
		out.reputation = { referee: env.reputation.referee, sig: env.reputation.sig };
	}
	return bytesToB64url(utf8.encode(JSON.stringify(out)));
}

/**
 * Decode {@link RegisterV1.bootstrapEvidence} (base64url → JSON), structurally validate it, and return
 * the {@link BootstrapEvidenceEnvelopeV1}. **Total**: returns `undefined` on an absent/empty field, a
 * non-base64url or non-JSON body, a wrong/future `v`, or a structurally-invalid kind — never throws. A
 * verifier treats `undefined` as "this kind not offered" and fails its check (fails closed).
 */
export function parseBootstrapEvidenceEnvelope(reg: Pick<RegisterV1, "bootstrapEvidence">): BootstrapEvidenceEnvelopeV1 | undefined {
	const raw = reg.bootstrapEvidence;
	if (raw === undefined || raw === "") {
		return undefined; // not offered
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8Decoder.decode(b64urlToBytes(raw)));
	} catch {
		return undefined; // not base64url / not UTF-8 / not JSON → fail closed
	}
	return narrowEnvelope(parsed);
}

/** Structurally narrow an already-parsed value to a v1 envelope, or `undefined`. */
function narrowEnvelope(value: unknown): BootstrapEvidenceEnvelopeV1 | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const obj = value as Record<string, unknown>;
	if (obj["v"] !== 1) {
		return undefined; // wrong / future version → fail closed under the v1 reader
	}
	const out: BootstrapEvidenceEnvelopeV1 = { v: 1 };

	if (obj["pow"] !== undefined) {
		const nonce = b64urlSubfield(obj["pow"], "nonce");
		if (nonce === undefined) {
			return undefined;
		}
		out.pow = { nonce };
	}

	if (obj["parentRef"] !== undefined) {
		const parentTopicId = b64urlSubfield(obj["parentRef"], "parentTopicId");
		const sig = b64urlSubfield(obj["parentRef"], "sig");
		if (parentTopicId === undefined || sig === undefined) {
			return undefined;
		}
		out.parentRef = { parentTopicId, sig };
	}

	if (obj["reputation"] !== undefined) {
		const referee = b64urlSubfield(obj["reputation"], "referee");
		const sig = b64urlSubfield(obj["reputation"], "sig");
		if (referee === undefined || sig === undefined) {
			return undefined;
		}
		out.reputation = { referee, sig };
	}

	return out;
}

/** A required base64url sub-field: a non-empty string that decodes cleanly, else `undefined`. */
function b64urlSubfield(container: unknown, key: string): string | undefined {
	if (typeof container !== "object" || container === null || Array.isArray(container)) {
		return undefined;
	}
	const value = (container as Record<string, unknown>)[key];
	if (typeof value !== "string" || value === "") {
		return undefined; // missing, non-string, or empty → treat as absent
	}
	try {
		b64urlToBytes(value); // structural: must decode as base64url
	} catch {
		return undefined;
	}
	return value;
}
