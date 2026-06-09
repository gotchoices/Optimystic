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
