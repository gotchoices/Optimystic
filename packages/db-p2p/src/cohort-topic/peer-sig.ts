/**
 * Cohort-topic shared Ed25519 sign/verify primitive (libp2p peer keys).
 *
 * Mirrors the established peer-key signing pattern in `cluster-repo.ts` / `dispute-service.ts`
 * (`PrivateKey.sign` → base64url; verify against the peer's public key), specialized for the
 * cohort-topic substrate:
 *
 * - **Signing** uses the node's libp2p `PrivateKey.sign` (async — fine on the participant outbound
 *   path) and is the seam the threshold-assembly ticket reuses for per-member partial signatures.
 * - **Verification is SYNCHRONOUS**, because the db-core verify ports (e.g. the participant-signature
 *   predicates and `ICohortThresholdCrypto.verify`) are synchronous. libp2p's
 *   `publicKeyFromRaw(raw).verify` is async, so this verifies with `@noble/curves/ed25519` directly
 *   over the raw 32-byte key. noble's `ed25519.verify` (ZIP215) is a strict superset of the RFC8032
 *   signatures the libp2p signer (Node/WebCrypto Ed25519) produces, so it accepts them.
 *
 * The signer id on the cohort wire is the UTF-8 bytes of the peer-id string (see `peer-codec.ts`).
 * For an Ed25519 identity the public key is embedded in the identity multihash, so no network lookup
 * is needed — `peerIdFromString(str).publicKey.raw` yields the raw key. Verification is **total**: any
 * non-Ed25519 id, missing key, or malformed input returns `false` (it never throws). The cohort-topic
 * substrate therefore assumes Ed25519 identities (the libp2p default; `generateKeyPair('Ed25519')`).
 */

import type { PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToPeerIdString } from "./peer-codec.js";

/** Sign `payload` with the node's libp2p peer key. Async — libp2p `PrivateKey.sign` is async. */
export async function signPeer(privateKey: PrivateKey, payload: Uint8Array): Promise<Uint8Array> {
	return privateKey.sign(payload);
}

/**
 * Sign `payload` with a libp2p Ed25519 peer key **synchronously** — the mirror of the synchronous
 * {@link verifyPeerSig}. Use this where the signer seam is synchronous and the async {@link signPeer}
 * cannot be awaited: e.g. the reactivity recover `signBackfill` / `signResume` `(unsigned) => string`
 * ports, whose db-core driver builds the unsigned image internally (so a pre-signed value is impossible)
 * and whose seam shape is `=> string`, not `=> Promise<string>`.
 *
 * libp2p's own `PrivateKey.sign` is async (Node / WebCrypto Ed25519), so this signs directly with
 * `@noble/curves/ed25519` over the raw 32-byte seed. libp2p stores an Ed25519 private key as 64 bytes
 * (`raw` = 32-byte seed ‖ 32-byte public key); noble's `ed25519.sign(message, secretKey)` takes the
 * 32-byte seed. noble's signatures are RFC8032-compliant and deterministic, so both verify paths accept
 * them: the libp2p `publicKeyFromRaw(raw).verify` (Node / WebCrypto) and the synchronous
 * {@link verifyPeerSig} (noble, ZIP215) — symmetric with the verify direction's cross-acceptance, and
 * byte-identical to what the async {@link signPeer} would produce for the same key + payload.
 *
 * Assumes an Ed25519 identity (the cohort-topic substrate's standing assumption). Throws on a
 * non-Ed25519 key or an unexpected raw length — a programming error on the node's own key, never
 * attacker-reachable input (the verify side, by contrast, is total and returns `false`).
 */
export function signPeerSig(privateKey: PrivateKey, payload: Uint8Array): Uint8Array {
	if (privateKey.type !== "Ed25519") {
		throw new Error(`signPeerSig: expected an Ed25519 private key, got "${privateKey.type}"`);
	}
	const raw = privateKey.raw;
	// 64-byte libp2p form = seed ‖ public key; accept a bare 32-byte seed too.
	const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
	if (seed.length !== 32) {
		throw new Error(`signPeerSig: expected a 32- or 64-byte Ed25519 raw key, got ${raw.length} bytes`);
	}
	return ed25519.sign(payload, seed);
}

/**
 * Verify an Ed25519 peer-key signature synchronously. `signer` is the cohort-wire member id — the
 * UTF-8 bytes of the peer-id string (see {@link bytesToPeerIdString}) — or that peer-id string
 * directly. Returns `false` (never throws) on a non-Ed25519 id, a missing/short key, a malformed
 * signature, or any decode failure.
 */
export function verifyPeerSig(signer: string | Uint8Array, payload: Uint8Array, sig: Uint8Array): boolean {
	try {
		const peerIdStr = typeof signer === "string" ? signer : bytesToPeerIdString(signer);
		const peerId = peerIdFromString(peerIdStr);
		if (peerId.type !== "Ed25519" || peerId.publicKey === undefined) {
			return false;
		}
		const rawPub = peerId.publicKey.raw;
		if (rawPub.length !== 32) {
			return false;
		}
		return ed25519.verify(sig, payload, rawPub);
	} catch {
		return false;
	}
}
