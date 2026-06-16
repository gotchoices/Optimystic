/**
 * Reactivity — parent checkpoint summaries (`docs/reactivity.md` §Parent checkpoint summaries).
 *
 * A `W`-revision replay buffer is too shallow for a phone asleep overnight. To extend recoverable range
 * without ballooning replay memory, every parent forwarder cohort (and the tail cohort) maintains a
 * rolling {@link CheckpointSummary} over the `W_checkpoint` revisions sitting **immediately below** the
 * replay ring's low edge — the two windows *stack*, so a single round trip recovers `W + W_checkpoint`
 * revisions (the authoritative stacked semantics, `docs/reactivity.md` §Replay window). As revisions
 * retire from the ring, the forwarder feeds them to {@link RollingCheckpoint.retire}; the checkpoint
 * rolls its `toRevision` forward and trims its low edge to span `W_checkpoint`.
 *
 * The checkpoint is a **hint summary, not a chain replacement**. Two design questions the ticket asks to
 * resolve, decided here:
 *
 *  - **`mergedDigest` semantics (resolved → system-level deterministic fold, per-collection override).**
 *    `NotificationV1.digest` carries the commit-vote signed payload `utf8(commitHash + ":approve")` —
 *    the exact bytes the commit threshold signature was computed over (see
 *    `packages/db-core/src/reactivity/notification.ts`). It is per-revision deterministic and identical
 *    across cohort members, so the default `mergedDigest` — a deterministic running fold over the
 *    per-revision digests in revision order ({@link defaultDigestFold}) — converges under gossip and the
 *    application can compare it against its own expectation. A collection MAY override the fold
 *    ({@link RollingCheckpointInit.fold}, e.g. a KV collection folding changed-key sets). The merged
 *    digest is **not** cryptographically verified — it is a hint; the cryptographic anchor is the
 *    bracketing endpoints (below).
 *
 *  - **`mergedDelta` vs `delta_max` (resolved → omit when oversize, never split).** The per-revision
 *    deltas are coalesced ({@link RollingCheckpointInit.coalesceDeltas}, default concatenation) only when
 *    the coalesced result fits within `delta_max`; otherwise `mergedDelta` is omitted entirely and the
 *    subscriber relies on `mergedDigest` + the resume's `recentEntries`, or falls back to a chain read. No
 *    multi-frame splitting — a checkpoint is a bounded hint.
 *
 * The **bracketing endpoints** are carried as the two full endpoint {@link NotificationV1}s
 * ({@link CheckpointSummary.bracketingEntries}). A bare signature is not independently verifiable — to
 * verify an endpoint is a real committed revision a subscriber needs the signed payload (the commit
 * digest) and the signers, which the full notification carries. {@link verifyCheckpointEndpoints} runs
 * the standard {@link NotificationVerifier} over both endpoints (proving they are real committed
 * revisions) and checks their revisions equal `fromRevision`/`toRevision`; a forged endpoint is rejected.
 */

import { createRingHash } from "../cohort-topic/ring-hash.js";
import { bytesToB64url, b64urlToBytes } from "../cohort-topic/wire/codec.js";
import type { IRingHash } from "../cohort-topic/ports.js";
import type { VerifyResult } from "../cohort-topic/membership/verifier.js";
import { W_CHECKPOINT_DEFAULT } from "./config.js";
import type { RevisionEntry } from "./replay-buffer.js";
import type { NotificationVerifier } from "./verify.js";
import { asObject, b64urlField, failWire, reqIntInRange, reqString } from "./wire-validate.js";
import { validateNotificationV1, type NotificationV1 } from "./wire.js";

/**
 * A parent checkpoint summary over `[fromRevision, toRevision]` (`docs/reactivity.md`
 * §Parent checkpoint summaries). All byte fields base64url; `bracketingEntries` is exactly the two
 * endpoint notifications, the verifiable anchor.
 */
export interface CheckpointSummary {
	/** Collection id, base64url. */
	readonly collectionId: string;
	/** Inclusive low edge of the summarized range. */
	readonly fromRevision: number;
	/** Inclusive high edge of the summarized range (`toRevision - fromRevision + 1 ≈ W_checkpoint`). */
	readonly toRevision: number;
	/** Deterministic fold of the per-revision commit digests across the range, base64url (a hint). */
	readonly mergedDigest: string;
	/** Optional coalesced delta, base64url; omitted when the coalesced size exceeds `delta_max`. */
	readonly mergedDelta?: string;
	/** The two endpoint notifications (at `fromRevision` and `toRevision`) — the verifiable proof. */
	readonly bracketingEntries: readonly [NotificationV1, NotificationV1];
}

/** A fold of per-revision commit digests into one summary digest (`docs/reactivity.md` `mergedDigest`). */
export type DigestFold = (perRevisionDigests: readonly Uint8Array[]) => Uint8Array;

/** Coalesce per-revision deltas into one bounded delta (`docs/reactivity.md` `mergedDelta`). */
export type DeltaCoalesce = (perRevisionDeltas: readonly Uint8Array[]) => Uint8Array;

/**
 * The default system-level `mergedDigest` fold: a deterministic running hash
 * `acc₀ = H(∅); accᵢ = H(accᵢ₋₁ ‖ digestᵢ)` over the per-revision commit digests in revision order.
 * Order-dependent and reproducible, so every cohort member folds to identical bytes (gossip converges).
 */
export function defaultDigestFold(hash: IRingHash = createRingHash()): DigestFold {
	return (digests: readonly Uint8Array[]): Uint8Array => {
		let acc = hash.H(new Uint8Array(0));
		for (const digest of digests) {
			const input = new Uint8Array(acc.length + digest.length);
			input.set(acc, 0);
			input.set(digest, acc.length);
			acc = hash.H(input);
		}
		return acc;
	};
}

/** The default delta coalescer: ordered concatenation of the per-revision delta bytes. */
export function defaultDeltaCoalesce(deltas: readonly Uint8Array[]): Uint8Array {
	const total = deltas.reduce((n, d) => n + d.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const d of deltas) {
		out.set(d, offset);
		offset += d.length;
	}
	return out;
}

/** Construction inputs for a {@link RollingCheckpoint}. */
export interface RollingCheckpointInit {
	/** Collection id, base64url (must match the entries retired into it). */
	readonly collectionId: string;
	/** Checkpoint span `W_checkpoint` (default {@link W_CHECKPOINT_DEFAULT}). */
	readonly span?: number;
	/** Ring hash for the default digest fold. Default db-core SHA-256. */
	readonly hash?: IRingHash;
	/** `mergedDigest` fold (default {@link defaultDigestFold} over the injected hash). */
	readonly fold?: DigestFold;
	/** `mergedDelta` coalescer (default {@link defaultDeltaCoalesce}). */
	readonly coalesceDeltas?: DeltaCoalesce;
	/** `delta_max`: omit `mergedDelta` when the coalesced size exceeds this. `0` ⇒ never emit a delta. */
	readonly deltaMaxBytes?: number;
}

/**
 * The rolling `W_checkpoint`-span parent checkpoint. Retains up to `span` retired {@link RevisionEntry}s
 * (the documented per-cohort checkpoint memory cost) so it can fold a real `mergedDigest`, coalesce a
 * `mergedDelta`, and carry the two endpoint notifications. It always covers the `span` revisions just
 * below the replay ring's low edge.
 */
export class RollingCheckpoint {
	readonly collectionId: string;
	readonly span: number;
	private readonly hash: IRingHash;
	private readonly fold: DigestFold;
	private readonly coalesceDeltas: DeltaCoalesce;
	private readonly deltaMaxBytes: number;
	/** revision → retired entry; trimmed to the highest `span` revisions. */
	private readonly byRevision = new Map<number, RevisionEntry>();

	constructor(init: RollingCheckpointInit) {
		const span = init.span ?? W_CHECKPOINT_DEFAULT;
		if (!Number.isInteger(span) || span < 1) {
			throw new RangeError(`reactivity checkpoint: span must be an integer >= 1, got ${span}`);
		}
		this.collectionId = init.collectionId;
		this.span = span;
		this.hash = init.hash ?? createRingHash();
		this.fold = init.fold ?? defaultDigestFold(this.hash);
		this.coalesceDeltas = init.coalesceDeltas ?? defaultDeltaCoalesce;
		this.deltaMaxBytes = init.deltaMaxBytes ?? 0;
	}

	/** Number of retired revisions currently summarized. */
	get size(): number {
		return this.byRevision.size;
	}

	/** Lowest summarized revision, or `undefined` when empty. */
	get fromRevision(): number | undefined {
		return this.size === 0 ? undefined : Math.min(...this.byRevision.keys());
	}

	/** Highest summarized revision, or `undefined` when empty. */
	get toRevision(): number | undefined {
		return this.size === 0 ? undefined : Math.max(...this.byRevision.keys());
	}

	/** True iff `revision` is within the checkpoint's covered range. */
	covers(revision: number): boolean {
		const from = this.fromRevision;
		const to = this.toRevision;
		return from !== undefined && to !== undefined && revision >= from && revision <= to;
	}

	/**
	 * Fold one revision retired from the replay ring into the checkpoint. Entries arrive as the ring
	 * evicts its low edge; the checkpoint trims to its highest `span` revisions so it tracks the window
	 * immediately below the ring. A retransmit at an already-summarized revision replaces in place.
	 */
	retire(entry: RevisionEntry): void {
		if (entry.payload.collectionId !== this.collectionId) {
			return; // an entry for a different collection is not ours to summarize
		}
		this.byRevision.set(entry.revision, entry);
		while (this.byRevision.size > this.span) {
			this.byRevision.delete(Math.min(...this.byRevision.keys()));
		}
	}

	/** The retired entries, ascending by revision. */
	private orderedEntries(): RevisionEntry[] {
		return [...this.byRevision.values()].sort((a, b) => a.revision - b.revision);
	}

	/** Build the {@link CheckpointSummary} over the currently-summarized range, or `undefined` if empty. */
	summary(): CheckpointSummary | undefined {
		const ordered = this.orderedEntries();
		if (ordered.length === 0) {
			return undefined;
		}
		const digests = ordered.map((e) => b64urlToBytes(e.payload.digest));
		const mergedDigest = bytesToB64url(this.fold(digests));
		const first = ordered[0]!.payload;
		const last = ordered[ordered.length - 1]!.payload;
		const summary: CheckpointSummary = {
			collectionId: this.collectionId,
			fromRevision: first.revision,
			toRevision: last.revision,
			mergedDigest,
			bracketingEntries: [first, last],
		};
		const mergedDelta = this.buildMergedDelta(ordered);
		if (mergedDelta !== undefined) {
			return { ...summary, mergedDelta };
		}
		return summary;
	}

	/**
	 * Coalesce the per-revision deltas, returning the base64url result only when it fits within
	 * `delta_max`. Omitted (returns `undefined`) when no entry carries a delta, when `delta_max == 0`, or
	 * when the coalesced size would exceed `delta_max` (the resolved omit-when-oversize policy).
	 */
	private buildMergedDelta(ordered: readonly RevisionEntry[]): string | undefined {
		if (this.deltaMaxBytes <= 0) {
			return undefined;
		}
		const deltas: Uint8Array[] = [];
		for (const e of ordered) {
			if (e.payload.delta !== undefined) {
				deltas.push(b64urlToBytes(e.payload.delta));
			}
		}
		if (deltas.length === 0) {
			return undefined;
		}
		const coalesced = this.coalesceDeltas(deltas);
		if (coalesced.length > this.deltaMaxBytes) {
			return undefined; // omit when oversize — never split
		}
		return bytesToB64url(coalesced);
	}
}

/**
 * Verify a checkpoint's bracketing endpoints are real committed revisions: run the standard
 * {@link NotificationVerifier} over both endpoint notifications and confirm their revisions equal
 * `fromRevision`/`toRevision` and their collection matches. Returns `"verified"` only if **both**
 * endpoints verify and align; a forged or tampered endpoint yields `"untrusted"`.
 */
export async function verifyCheckpointEndpoints(summary: CheckpointSummary, verifier: NotificationVerifier): Promise<VerifyResult> {
	const [from, to] = summary.bracketingEntries;
	if (
		from.collectionId !== summary.collectionId ||
		to.collectionId !== summary.collectionId ||
		from.revision !== summary.fromRevision ||
		to.revision !== summary.toRevision
	) {
		return "untrusted";
	}
	const [fromVerdict, toVerdict] = await Promise.all([verifier.verify(from), verifier.verify(to)]);
	return fromVerdict === "verified" && toVerdict === "verified" ? "verified" : "untrusted";
}

/**
 * Narrow an already-parsed value to {@link CheckpointSummary}, throwing on any defect. Used by the resume
 * codec to validate a checkpoint embedded in a `checkpoint_window` reply. The two `bracketingEntries` are
 * validated as full {@link NotificationV1}s (the verifiable anchor); `mergedDelta` is optional.
 */
export function validateCheckpointSummary(value: unknown, what = "CheckpointSummary"): CheckpointSummary {
	const obj = asObject(value, what);
	const fromRevision = reqIntInRange(obj, "fromRevision", what, 0);
	const toRevision = reqIntInRange(obj, "toRevision", what, fromRevision);
	const bracketing = obj["bracketingEntries"];
	if (!Array.isArray(bracketing) || bracketing.length !== 2) {
		failWire(`${what}: field "bracketingEntries" must be a length-2 array`);
	}
	const summary: CheckpointSummary = {
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		fromRevision,
		toRevision,
		mergedDigest: b64urlField(reqString(obj, "mergedDigest", what), "mergedDigest", what),
		bracketingEntries: [validateNotificationV1(bracketing[0]), validateNotificationV1(bracketing[1])],
	};
	if (obj["mergedDelta"] !== undefined) {
		return { ...summary, mergedDelta: b64urlField(reqString(obj, "mergedDelta", what), "mergedDelta", what) };
	}
	return summary;
}
