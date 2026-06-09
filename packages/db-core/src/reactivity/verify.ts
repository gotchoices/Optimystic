/**
 * Reactivity — subscriber/forwarder notification verification seam
 * (`docs/reactivity.md` §Propagation, §Delivery, §Authentication).
 *
 * A forwarder and a subscriber both verify a notification's threshold signature against the **tail
 * cohort's** `MembershipCertV1` before trusting it — forwarders never re-sign, so the same end-to-end
 * signature is verified regardless of hop count. The standard cohort-topic membership-snapshot path
 * ({@link MembershipVerifier}) already provides the **one fetch-and-retry** on a stale/missing cached
 * cert, so this module is a thin adapter: derive the tail cohort's `coord_0(_, topicId)` from the
 * notification's `tailId`, then hand `(signers, coord, tier, digest, sig)` to the verifier.
 *
 * The signed payload is the commit `digest` (the commit cert's threshold signature is over the commit
 * hash — see {@link import("./notification.js").buildNotificationV1}). `signers` arrive base64url-encoded
 * as the cohort member-id bytes the verifier compares against `cert.members`; a custom `signersToBytes`
 * seam is exposed for bindings that carry signers in a different encoding.
 */

import { createTierAddressing, DEFAULT_FANOUT } from "../cohort-topic/addressing.js";
import { createRingHash } from "../cohort-topic/ring-hash.js";
import { b64urlToBytes } from "../cohort-topic/wire/codec.js";
import { Tier } from "../cohort-topic/tiers.js";
import type { IRingHash } from "../cohort-topic/ports.js";
import type { MembershipVerifier, VerifyResult } from "../cohort-topic/membership/verifier.js";
import { reactivityTopicId } from "./topic-anchor.js";
import type { NotificationV1 } from "./wire.js";

/** Verifies a {@link NotificationV1}'s threshold signature against the tail cohort's membership. */
export interface NotificationVerifier {
	/** `"verified"` iff `sig` is a valid `≥ minSigs` cohort signature over the commit digest. */
	verify(n: NotificationV1): Promise<VerifyResult>;
}

/** Construction inputs for the default {@link NotificationVerifier}. */
export interface NotificationVerifierDeps {
	/** The cohort-topic participant-side membership verifier (owns the one fetch-and-retry). */
	readonly verifier: MembershipVerifier;
	/** Ring hash for `topicId` / `coord_0` derivation. Default db-core 256-bit SHA-256. */
	readonly hash?: IRingHash;
	/** Fan-out `F` for tier addressing. Default {@link DEFAULT_FANOUT}. */
	readonly fanout?: number;
	/** Reactivity runs at T3; overridable for tests. */
	readonly tier?: Tier;
	/** Map a wire signer string to the verifier's member-id bytes. Default base64url decode. */
	readonly signersToBytes?: (signer: string) => Uint8Array;
}

class MembershipNotificationVerifier implements NotificationVerifier {
	private readonly addressing: ReturnType<typeof createTierAddressing>;
	private readonly hash: IRingHash;
	private readonly tier: Tier;
	private readonly signersToBytes: (signer: string) => Uint8Array;

	constructor(private readonly deps: NotificationVerifierDeps) {
		this.hash = deps.hash ?? createRingHash();
		this.addressing = createTierAddressing(this.hash, deps.fanout ?? DEFAULT_FANOUT);
		this.tier = deps.tier ?? Tier.T3;
		this.signersToBytes = deps.signersToBytes ?? b64urlToBytes;
	}

	async verify(n: NotificationV1): Promise<VerifyResult> {
		const topicId = reactivityTopicId(b64urlToBytes(n.tailId), this.hash);
		const expectedCoord = this.addressing.coord0(topicId);
		const signers = n.signers.map(this.signersToBytes);
		const payload = b64urlToBytes(n.digest);
		const sig = b64urlToBytes(n.sig);
		return this.deps.verifier.verifyMessage(signers, expectedCoord, this.tier, payload, sig);
	}
}

/** Build the default {@link NotificationVerifier} over the cohort-topic {@link MembershipVerifier}. */
export function createNotificationVerifier(deps: NotificationVerifierDeps): NotificationVerifier {
	return new MembershipNotificationVerifier(deps);
}
