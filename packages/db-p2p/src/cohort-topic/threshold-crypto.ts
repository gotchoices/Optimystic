/**
 * Cohort-topic `k − x` threshold-signature crypto — real collected Ed25519 multi-signature.
 *
 * Closes gap 1 (the interim single-signer `sha256(payload)` digest, which could never satisfy
 * `CohortSigner.verifyThreshold`'s `≥ minSigs` distinct-member rule at `minSigs = 14`). The scheme is
 * a **collected multisig**: `thresholdSig` is the aligned concatenation of fixed-width 64-byte Ed25519
 * signatures, one per `signers[i]`, each produced by that member's libp2p peer key over the *exact*
 * canonical payload. It needs **no trusted setup, no new crypto dependency, and no aggregation round**
 * (unlike BLS or FROST), maps directly onto the existing `(thresholdSig, signers)` contract, and reuses
 * the per-member peer-key signing primitive (`peer-sig.ts`) the codebase already uses for cluster-repo
 * commit signatures. Size is O(k) (≤ ~14 × 64 = 896 bytes at production `minSigs`) — negligible for
 * k ≤ 16; if size ever matters at larger k the scheme can be swapped behind the unchanged
 * {@link ICohortThresholdCrypto} port.
 *
 * **Coord-scoped.** `assemble(payload, minSigs)` carries no coord, so the adapter is constructed per
 * served coord (one per {@link import("./host.js").CoordEngine}): it knows the cohort around its coord,
 * the node's peer key (to add self's own signature without an RPC), and a `dialSign` seam over the
 * `/sign` protocol to collect the other members' endorsements.
 *
 * **Verify is synchronous** — `ICohortThresholdCrypto.verify` is called from the sync
 * `CohortSigner.verifyThreshold` on the participant path. {@link verifyCollectedMultisig} splits the
 * blob into `signers.length` 64-byte chunks and {@link verifyPeerSig}-checks each against the
 * corresponding signer's embedded Ed25519 key (noble, sync). Do not make it async.
 */

import type { PrivateKey } from "@libp2p/interface";
import type { ICohortThresholdCrypto, RingCoord, SignKind, SignReplyV1, SignRequestV1 } from "@optimystic/db-core";
import { bytesToB64url, b64urlToBytes, compareBytes } from "@optimystic/db-core";
import { signPeer, verifyPeerSig } from "./peer-sig.js";
import { bytesToPeerIdString } from "./peer-codec.js";

/** Width of an Ed25519 signature in bytes — the fixed stride of the concatenated `thresholdSig`. */
export const ED25519_SIG_BYTES = 64;

/** Default per-round deadline for collecting cohort endorsements (ms). */
export const DEFAULT_SIGN_COLLECT_TIMEOUT_MS = 5_000;

/**
 * Verify a collected Ed25519 multi-signature: `thresholdSig` must be exactly `signers.length × 64`
 * bytes, and chunk `i` must be a valid peer-key signature by `signers[i]` over `payload`. Pure and
 * synchronous; total (returns `false`, never throws). The db-core `CohortSigner.verifyThreshold` layer
 * adds the distinct-signer / `signers ⊆ cert.members` / `≥ minSigs` checks on top of this.
 */
export function verifyCollectedMultisig(payload: Uint8Array, thresholdSig: Uint8Array, signers: readonly Uint8Array[]): boolean {
	if (signers.length === 0) {
		return false;
	}
	if (thresholdSig.length !== signers.length * ED25519_SIG_BYTES) {
		return false;
	}
	for (let i = 0; i < signers.length; i++) {
		const chunk = thresholdSig.subarray(i * ED25519_SIG_BYTES, (i + 1) * ED25519_SIG_BYTES);
		if (!verifyPeerSig(signers[i]!, payload, chunk)) {
			return false;
		}
	}
	return true;
}

/**
 * Dependencies for a coord-scoped {@link FretCohortThresholdCrypto}. The host supplies these per
 * {@link import("./host.js").CoordEngine}; the `kind` selects the endorsement policy the dialed
 * members apply (membership cert vs promotion / demotion notice).
 */
export interface CohortThresholdCryptoDeps {
	/** What this signer assembles — sent in each {@link SignRequestV1} so members apply the right policy. */
	readonly kind: SignKind;
	/** The node's libp2p Ed25519 private key — signs self's own chunk locally (no RPC to self). */
	readonly privateKey: PrivateKey;
	/** Self's dialable member id (UTF-8 of the peer-id string); self is always a signer. */
	readonly selfMember: Uint8Array;
	/** The served coord whose cohort threshold-signs. */
	readonly coord: () => RingCoord;
	/** Current cohort epoch (raw bytes) for {@link coord}. */
	readonly cohortEpoch: () => Uint8Array;
	/** Current cohort member peer-id strings around {@link coord} (self may be included; excluded internally). */
	readonly cohortMembers: () => string[];
	/** Dial one cohort member's `/sign` RPC and return its reply. */
	readonly dialSign: (peerIdStr: string, request: SignRequestV1) => Promise<SignReplyV1>;
	/** Per-round collection deadline (ms). Default {@link DEFAULT_SIGN_COLLECT_TIMEOUT_MS}. */
	readonly collectTimeoutMs?: number;
}

/** A collected, verified per-member signature awaiting concatenation. */
interface CollectedSig {
	readonly signer: Uint8Array;
	readonly sig: Uint8Array;
}

/**
 * Real coord-scoped {@link ICohortThresholdCrypto}. `assemble` signs locally, concurrently dials the
 * rest of the cohort over the `/sign` protocol, verifies each returned signature before counting it,
 * and concatenates `≥ minSigs` distinct signatures into the threshold blob — or throws if a quorum is
 * unreachable (it must **never** fabricate a single-signer sig, the interim bug). `verify` is the pure
 * split-and-check.
 */
export class FretCohortThresholdCrypto implements ICohortThresholdCrypto {
	constructor(private readonly deps: CohortThresholdCryptoDeps) {}

	async assemble(payload: Uint8Array, minSigs: number): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> {
		const collected = new Map<string, CollectedSig>();

		// Self is always a signer — it is the acting member, even if a stale table omits it from its own
		// assembly. Sign locally (no RPC to self).
		const selfSig = await signPeer(this.deps.privateKey, payload);
		if (selfSig.length !== ED25519_SIG_BYTES) {
			throw new Error(`cohort threshold sign: self produced a ${selfSig.length}-byte signature (expected ${ED25519_SIG_BYTES}); non-Ed25519 identity?`);
		}
		collected.set(bytesToB64url(this.deps.selfMember), { signer: this.deps.selfMember, sig: selfSig });

		// Concurrently collect endorsements from the rest of the cohort, up to the deadline.
		const selfStr = bytesToPeerIdString(this.deps.selfMember);
		const others = this.deps.cohortMembers().filter((m) => m !== selfStr);
		if (others.length > 0 && collected.size < minSigs) {
			const request: SignRequestV1 = {
				v: 1,
				kind: this.deps.kind,
				coord: bytesToB64url(this.deps.coord()),
				cohortEpoch: bytesToB64url(this.deps.cohortEpoch()),
				payload: bytesToB64url(payload),
			};
			const timeoutMs = this.deps.collectTimeoutMs ?? DEFAULT_SIGN_COLLECT_TIMEOUT_MS;
			await Promise.all(others.map((peerStr) => this.collectFrom(peerStr, request, payload, collected, timeoutMs)));
		}

		if (collected.size < minSigs) {
			// Quorum unreachable / unwilling: no notice this round. The promotion / cert path re-fires next
			// tick. NEVER fabricate a single-signer sig — that is exactly the interim bug this replaces.
			throw new Error(`cohort threshold sign: gathered ${collected.size} of ${minSigs} required signatures`);
		}

		// Deterministic order (ascending by signer id) so the concatenation is reproducible and aligns
		// signers[i] ↔ chunk i for the verifier.
		const ordered = [...collected.values()].sort((a, b) => compareBytes(a.signer, b.signer));
		const signers = ordered.map((e) => e.signer);
		const thresholdSig = concatSigs(ordered.map((e) => e.sig));
		return { thresholdSig, signers };
	}

	verify(payload: Uint8Array, thresholdSig: Uint8Array, signers: readonly Uint8Array[]): boolean {
		return verifyCollectedMultisig(payload, thresholdSig, signers);
	}

	/** Dial one member, verify-before-count its endorsement, and add it to `collected` (dropping bad/dupe). */
	private async collectFrom(
		peerStr: string,
		request: SignRequestV1,
		payload: Uint8Array,
		collected: Map<string, CollectedSig>,
		timeoutMs: number,
	): Promise<void> {
		try {
			const reply = await withTimeout(this.deps.dialSign(peerStr, request), timeoutMs);
			if (reply === undefined || "refused" in reply) {
				return; // unreachable (timed out) or the member declined to endorse
			}
			const signerBytes = b64urlToBytes(reply.signer);
			const sigBytes = b64urlToBytes(reply.signature);
			if (sigBytes.length !== ED25519_SIG_BYTES) {
				return; // a malformed chunk would desync the fixed-stride concatenation
			}
			// Verify before counting: a member must not be able to poison the blob with a bad signature.
			if (!verifyPeerSig(signerBytes, payload, sigBytes)) {
				return;
			}
			const key = bytesToB64url(signerBytes);
			if (collected.has(key)) {
				return; // a duplicate signer cannot pad the count toward minSigs
			}
			collected.set(key, { signer: signerBytes, sig: sigBytes });
		} catch {
			// Unreachable member or malformed reply — drop it; collection continues with the rest.
		}
	}
}

/**
 * A verify-only {@link ICohortThresholdCrypto} for the participant-side verifier, which never assembles
 * (it only checks inbound threshold-signed messages). `assemble` rejects so a misuse surfaces loudly
 * rather than fabricating a signature.
 */
export function createVerifyOnlyThresholdCrypto(): ICohortThresholdCrypto {
	return {
		assemble: (): Promise<{ thresholdSig: Uint8Array; signers: Uint8Array[] }> =>
			Promise.reject(new Error("verify-only cohort threshold crypto cannot assemble signatures")),
		verify: verifyCollectedMultisig,
	};
}

/** Concatenate equal-width signature chunks into one fixed-stride blob aligned with the signer order. */
function concatSigs(sigs: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(sigs.length * ED25519_SIG_BYTES);
	for (let i = 0; i < sigs.length; i++) {
		out.set(sigs[i]!, i * ED25519_SIG_BYTES);
	}
	return out;
}

/** Resolve `p`, or `undefined` if `timeoutMs` elapses first (bounds wall-clock against an unreachable peer). */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(undefined);
			}
		}, timeoutMs);
		void p.then(
			(value) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(value);
				}
			},
			() => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(undefined);
				}
			},
		);
	});
}
