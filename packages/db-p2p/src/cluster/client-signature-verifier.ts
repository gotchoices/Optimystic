/**
 * The p2p-backed {@link ClientSignatureVerifier}: the closure a cluster member's
 * {@link TransactionValidator} uses to decide whether a client transaction was really signed by the
 * identity its stamp claims.
 *
 * Lives here — one exported factory rather than a closure inlined at each wiring site — because two
 * consumers must agree byte-for-byte or the tests stop proving anything about production: the
 * Quereus plugin's `createQuereusValidator` (the real deployment path once a composition root
 * supplies `NodeOptions.validator`) and `db-p2p`'s own signature specs, whose whole claim is that
 * they drive "the exact closure production binds".
 */

import type { ClientSignatureVerifier } from '@optimystic/db-core';
import { b64urlToBytes } from '@optimystic/db-core';
import { verifyPeerSig } from '../cohort-topic/peer-sig.js';

/**
 * Derive the signer's Ed25519 public key from the peer-id string embedded in `stamp.peerId` and
 * verify the base64url signature over the canonical payload.
 *
 * TOTAL on adversarial input, which the {@link ClientSignatureVerifier} port requires: a throw here
 * escapes `ClusterMember.validatePendOperations` instead of becoming a signed reject vote.
 * `verifyPeerSig` already returns `false` rather than throwing on a non-Ed25519 or malformed
 * peer-id; the try/catch adds the same guarantee for the base64url decode.
 */
export function createPeerClientSignatureVerifier(): ClientSignatureVerifier {
	return (peerId: string, payload: Uint8Array, signature: string): boolean => {
		try {
			return verifyPeerSig(peerId, payload, b64urlToBytes(signature));
		} catch {
			return false;
		}
	};
}
