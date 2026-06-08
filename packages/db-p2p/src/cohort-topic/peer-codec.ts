/**
 * Cohort-topic peer-id ↔ bytes bridge.
 *
 * db-core's substrate logic references peers as opaque `Uint8Array` ids ({@link PeerRef}`.id`); FRET +
 * libp2p reference them as `PeerId` / peer-id strings. The cohort-member ids the substrate carries on
 * the wire (a reply's `primary` / `backups` / `cohortMembers`) must round-trip back to a *dialable*
 * libp2p peer, so this module pins one unambiguous encoding for them: the UTF-8 bytes of the canonical
 * peer-id string. (The participant's own addressing coordinate `P` is a separate ring-coord value — see
 * the host — so this encoding never needs to feed the ring hash.)
 */

import { peerIdFromString } from "@libp2p/peer-id";
import type { PeerId } from "@libp2p/interface";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** A cohort-member id as the substrate's opaque bytes: UTF-8 of the canonical peer-id string. */
export function peerIdToBytes(peerId: PeerId | string): Uint8Array {
	return utf8Encoder.encode(typeof peerId === "string" ? peerId : peerId.toString());
}

/** Reverse of {@link peerIdToBytes}: decode member bytes back to the canonical peer-id string. */
export function bytesToPeerIdString(bytes: Uint8Array): string {
	return utf8Decoder.decode(bytes);
}

/** Reverse of {@link peerIdToBytes}: decode member bytes back to a dialable {@link PeerId}. */
export function bytesToPeerId(bytes: Uint8Array): PeerId {
	return peerIdFromString(bytesToPeerIdString(bytes));
}
