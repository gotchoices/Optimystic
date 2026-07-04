/**
 * Key ↔ peer-id binding predicate for the cluster/dispute vote paths.
 *
 * For a libp2p Ed25519 identity the peer-id **is** the multihash of the public key, so a public key
 * that a record self-asserts for a peer id can be checked against the id itself — no network lookup.
 * Both the cluster two-phase-commit path (`cluster-repo.ts`) and the dispute path (`dispute-service.ts`)
 * read a signing key straight from the record they are handed; without this check a coordinator could
 * attach a key it controls under an honest peer's id and have a forged vote verify. This predicate is
 * the gate that ties a self-asserted key back to the identity it claims.
 *
 * Mirrors the binding logic already used by the cohort-topic substrate in `cohort-topic/peer-sig.ts`
 * (`peerIdFromString(str).publicKey.raw`); intentionally NOT importing that module, which is
 * specialized for its own wire encoding.
 *
 * NOTE: this proves only that a vote attributed to peer id `X` was signed by the key `X` names. It does
 * NOT decide whether `X` is legitimately a cohort member — a coordinator that mints fresh keypairs and
 * uses each key's own derived id passes this check for every one of them. Sybil/membership is a separate
 * layer (cohort-topic membership certificates); do not assume it is solved here.
 */

import { peerIdFromString } from "@libp2p/peer-id";

/**
 * True iff `rawKey` is the Ed25519 public key that `peerIdStr` names. Total: returns `false` on a
 * non-Ed25519 id, a missing/mismatched key, or any malformed input — never throws.
 */
export function peerIdBindsPublicKey(peerIdStr: string, rawKey: Uint8Array): boolean {
	try {
		const peerId = peerIdFromString(peerIdStr);
		if (peerId.type !== 'Ed25519' || peerId.publicKey === undefined) return false;
		const expected = peerId.publicKey.raw; // 32 bytes for Ed25519
		if (expected.length !== rawKey.length) return false;
		return expected.every((b, i) => b === rawKey[i]);
	} catch {
		return false;
	}
}
