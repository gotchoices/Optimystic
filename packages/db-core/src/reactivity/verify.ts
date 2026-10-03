/**
 * Reactivity — subscriber/forwarder notification verification seam
 * (`docs/reactivity.md` §Propagation, §Delivery, §Authentication).
 *
 * A forwarder and a subscriber both verify a notification's threshold signature against the **root
 * group's** `MembershipCertV1` before trusting it — forwarders never re-sign, so the same end-to-end
 * signature is verified regardless of hop count. The standard cohort-topic membership-snapshot path
 * ({@link MembershipVerifier}) already provides the **one fetch-and-retry** on a stale/missing cached
 * cert, so this module is a thin adapter: derive the root coordinate from the notification's `tailId`,
 * then hand `(signers, coord, tier, digest, sig)` to the verifier under the root placement rule.
 *
 * **The root group is the tail's storage group** (`docs/reactivity.md` §Origination point). The
 * notification's `tailId` is the base64url of the tail's routing key bytes, so `reactivityRootCoord`
 * of those bytes is the ring position the key network stores the tail block at, and the group there is
 * the one whose commit certificate the notification reuses as its signature. The signature threshold is
 * therefore the **verifier's own** `ceil(|root group| × quorumRatio)` — the formula the commit certificate
 * was captured under — never the cohort-topic `minSigs`, and never a value read from the notification.
 *
 * The signed payload is the commit `digest` (the commit cert's threshold signature is over the commit
 * hash — see {@link import("./notification.js").buildNotificationV1}). `signers` arrive base64url-encoded
 * as the cohort member-id bytes the verifier compares against `cert.members`; a custom `signersToBytes`
 * seam is exposed for bindings that carry signers in a different encoding.
 *
 * **The placement names the tail.** Every `verifyMessage` call carries a {@link RootPlacement} whose
 * `rootKey` is the notification's tail bytes — the same bytes the root coordinate is derived from — so a
 * direct anchor that can fetch the tail's own commit proof (db-p2p's commit-log anchor) knows which block to
 * ask the root group about. Without the key that anchor answers `"unknown"` and a distant verifier is back
 * to trusting the group's certificate on first use, with no other symptom; the verify spec pins the key.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import { b64urlToBytes } from "../cohort-topic/wire/codec.js";
import { Tier } from "../cohort-topic/tiers.js";
import { createRootPlacement } from "../cohort-topic/sig/threshold.js";
import type { IRingHash, RootPlacement } from "../cohort-topic/ports.js";
import type { MembershipVerifier, VerifyResult } from "../cohort-topic/membership/verifier.js";
import { reactivityRootCoord } from "./topic-anchor.js";
import type { NotificationV1 } from "./wire.js";

/** Verifies a {@link NotificationV1}'s threshold signature against the root group's membership. */
export interface NotificationVerifier {
	/** `"verified"` iff `sig` is a valid root-group signature over the commit digest, at the placement threshold. */
	verify(n: NotificationV1): Promise<VerifyResult>;
}

/** Construction inputs for the default {@link NotificationVerifier}. */
export interface NotificationVerifierDeps {
	/** The cohort-topic participant-side membership verifier (owns the one fetch-and-retry). */
	readonly verifier: MembershipVerifier;
	/**
	 * The ratio the root group's commit certificates are signed under — this node's own consensus
	 * `superMajorityThreshold`, never a value off a message. The threshold applied to a notification is
	 * `ceil(|root group| × quorumRatio)`; a ratio outside `(0, 1]` throws here, at construction.
	 */
	readonly quorumRatio: number;
	/** Ring hash for the root-coordinate derivation. Default db-core 256-bit SHA-256. */
	readonly hash?: IRingHash;
	/** Reactivity runs at T3; overridable for tests. */
	readonly tier?: Tier;
	/** Map a wire signer string to the verifier's member-id bytes. Default base64url decode. */
	readonly signersToBytes?: (signer: string) => Uint8Array;
}

class MembershipNotificationVerifier implements NotificationVerifier {
	private readonly hash: IRingHash;
	private readonly tier: Tier;
	private readonly placement: RootPlacement;
	private readonly signersToBytes: (signer: string) => Uint8Array;

	constructor(private readonly deps: NotificationVerifierDeps) {
		this.hash = deps.hash ?? createRingHash();
		this.tier = deps.tier ?? Tier.T3;
		this.placement = createRootPlacement(deps.quorumRatio);
		this.signersToBytes = deps.signersToBytes ?? b64urlToBytes;
	}

	async verify(n: NotificationV1): Promise<VerifyResult> {
		const tailBytes = b64urlToBytes(n.tailId);
		const expectedCoord = reactivityRootCoord(tailBytes, this.hash);
		const signers = n.signers.map(this.signersToBytes);
		const payload = b64urlToBytes(n.digest);
		const sig = b64urlToBytes(n.sig);
		// The ratio was validated once at construction; the key is per notification, so spread it per call.
		const placement: RootPlacement = { ...this.placement, rootKey: tailBytes };
		return this.deps.verifier.verifyMessage(signers, expectedCoord, this.tier, payload, sig, { placement });
	}
}

/** Build the default {@link NotificationVerifier} over the cohort-topic {@link MembershipVerifier}. */
export function createNotificationVerifier(deps: NotificationVerifierDeps): NotificationVerifier {
	return new MembershipNotificationVerifier(deps);
}
