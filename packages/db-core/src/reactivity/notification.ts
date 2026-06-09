/**
 * Reactivity — notification origination (`docs/reactivity.md` §Notification origination).
 *
 * The tail cohort's primary for a collection is, by construction, the transaction-layer tail-cluster:
 * the cohort-topic primary at `coord_0(_, topicId)` where `topicId = H(tailId ‖ "reactivity")`. As soon
 * as the commit's threshold signature is assembled, it emits a {@link NotificationV1} whose `sig` is
 * **bit-for-bit** the commit certificate's threshold signature — reactivity never re-signs.
 *
 * This module is the pure assembler. The local-change-notifier bridge ([local-change-notifier-bridge])
 * supplies the {@link CollectionChangeEvent} and the pass-through {@link CommitCert}; db-p2p's
 * origination manager calls {@link buildNotificationV1} with those plus the per-emission context
 * (`tailId`, `timestamp`, the per-collection `deltaMaxBytes`) and fans the result out. Crypto-free: it
 * copies `commitCert.thresholdSig` and `commitCert.signers` through unchanged.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import { bytesToB64url } from "../cohort-topic/wire/codec.js";
import type { IRingHash } from "../cohort-topic/ports.js";
import type { CollectionChangeEvent, CommitCert } from "../transactor/change-notifier.js";
import type { NotificationV1, RotationHintV1 } from "./wire.js";

const utf8 = new TextEncoder();

/** Per-emission context the origination point supplies alongside the bridge's event + cert. */
export interface OriginationContext {
	/** Current tail block id (base64url) the reactivity topic is anchored on. */
	readonly tailId: string;
	/** Emission timestamp (unix ms). */
	readonly timestamp: number;
	/**
	 * Per-collection delta budget (bytes). `0` ⇒ omit `delta` entirely (Edge profile, or a collection
	 * that declines deltas). Origination MUST respect a `deltaMaxBytes` of `0` by omitting the field.
	 */
	readonly deltaMaxBytes: number;
	/** Optional bounded delta (raw bytes); included only when within `deltaMaxBytes` and `> 0`. */
	readonly delta?: Uint8Array;
	/** Tail-rotation pre-announce to embed (rotation ticket supplies it). */
	readonly rotationHint?: RotationHintV1;
	/**
	 * Map a {@link CommitCert} signer (the cluster's peer-id string keying its commit vote) to the
	 * base64url cohort member-id bytes the subscriber's membership verifier compares against. Default:
	 * identity (the signer is already base64url) — db-p2p supplies `s ⇒ bytesToB64url(peerIdToBytes(s))`.
	 */
	readonly encodeSigner?: (signer: string) => string;
}

/**
 * Assemble the {@link NotificationV1} for one committed change, reusing the commit cert's threshold
 * signature unchanged.
 *
 * `digest` carries the commit identifier from the transaction layer (`event.actionId`, encoded
 * base64url). The threshold signature in `commitCert` is the cluster's per-member commit votes over the
 * commit hash; aligning that signed-hash byte image with this `digest` so a subscriber's *cryptographic*
 * threshold-verify over `digest` succeeds is the cluster↔reactivity integration seam (the cluster
 * `CommitCert` would expose the signed payload). The hint-only contract holds regardless: the digest is
 * the authoritative commit identifier, deltas are advisory.
 */
export function buildNotificationV1(event: CollectionChangeEvent, commitCert: CommitCert, ctx: OriginationContext): NotificationV1 {
	const encodeSigner = ctx.encodeSigner ?? ((s: string): string => s);
	const notification: NotificationV1 = {
		v: 1,
		collectionId: event.collectionId,
		tailId: ctx.tailId,
		revision: event.rev,
		digest: bytesToB64url(utf8.encode(event.actionId)),
		timestamp: ctx.timestamp,
		sig: bytesToB64url(commitCert.thresholdSig),
		signers: commitCert.signers.map(encodeSigner),
	};
	if (ctx.deltaMaxBytes > 0 && ctx.delta !== undefined && ctx.delta.length <= ctx.deltaMaxBytes) {
		notification.delta = bytesToB64url(ctx.delta);
	}
	if (ctx.rotationHint !== undefined) {
		notification.rotationHint = ctx.rotationHint;
	}
	return notification;
}

/**
 * Compact, stable digest of a notification's signature for the dedupe key `(revision, sigDigest)`
 * (`docs/reactivity.md` §Per-revision dedupe). Hashing the signature bytes keeps the key bounded and
 * distinguishes two distinct threshold sigs that legitimately share a revision during partition merge.
 */
export function sigDigest(sig: string, hash: IRingHash = createRingHash()): string {
	return bytesToB64url(hash.H(utf8.encode(sig)));
}

/** The dedupe-set key for a notification: `${revision}:${sigDigest(sig)}`. */
export function dedupeKey(revision: number, sig: string, hash?: IRingHash): string {
	return `${revision}:${sigDigest(sig, hash)}`;
}
