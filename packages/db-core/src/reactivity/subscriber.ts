/**
 * Reactivity — subscriber delivery path (`docs/reactivity.md` §Delivery).
 *
 * A subscriber receiving a notification:
 *  1. **verifies** `sig` against the cached tail-cohort `MembershipCertV1` (the {@link NotificationVerifier}
 *     owns the **one fetch-and-retry** on a stale cache);
 *  2. checks `revision == lastRevision + 1`. If not, requests a backfill for the gap
 *     `[lastRevision + 1, revision]` via the {@link requestBackfill} seam (the `BackfillV1` request shape
 *     lands in [reactivity-backfill-resume-checkpoints]; this ticket only *detects* the gap and calls the
 *     hook);
 *  3. updates `lastRevision` once revisions are contiguous;
 *  4. surfaces the notification to the application layer.
 *
 * Subscribers dedupe by `(collectionId, revision)`; duplicates from forwarder retries are discarded.
 * A fresh subscription (`lastKnownRev == 0`, uninitialized) adopts the first verified notification as its
 * baseline rather than demanding a backfill from revision 1.
 */

import type { NotificationV1 } from "./wire.js";
import type { NotificationVerifier } from "./verify.js";

/** The delivery outcome for one inbound notification. */
export type DeliveryOutcome =
	/** Verified and contiguous: surfaced to the application, `lastRevision` advanced. */
	| "delivered"
	/** `(collectionId, revision)` already delivered: discarded. */
	| "duplicate"
	/** Verified but ahead of `lastRevision + 1`: a backfill was requested; not yet surfaced. */
	| "gap"
	/** Signature did not verify (even after the one refetch): dropped. */
	| "untrusted"
	/** For a different collection than this subscription: ignored. */
	| "foreign";

/** Application sink + backfill seam for a {@link ReactivitySubscriber}. */
export interface ReactivitySubscriberDeps {
	/** Collection this subscription tracks, base64url (matches {@link NotificationV1.collectionId}). */
	readonly collectionId: string;
	/** Verifies inbound notifications (owns the single stale-cache refetch). */
	readonly verifier: NotificationVerifier;
	/** Surface a verified, contiguous notification to the application. */
	readonly deliver: (n: NotificationV1) => void;
	/**
	 * Request a backfill for the inclusive revision gap `[from, to]`. The `BackfillV1` request/response
	 * lands in [reactivity-backfill-resume-checkpoints]; the returned entries are fed back through
	 * {@link ReactivitySubscriber.onNotification} to close the gap. Absent ⇒ the gap is recorded only.
	 */
	readonly requestBackfill?: (from: number, to: number) => void;
	/** Last revision already held; `0` (default) ⇒ fresh subscribe, adopt the first notification as baseline. */
	readonly lastKnownRev?: number;
}

/** Drives the subscriber-side verify → contiguity → deliver path for one collection. */
export interface ReactivitySubscriber {
	/** Last contiguously-delivered revision (`lastKnownRev` until the first delivery). */
	readonly lastRevision: number;
	/** Process one inbound notification; returns the {@link DeliveryOutcome}. */
	onNotification(n: NotificationV1): Promise<DeliveryOutcome>;
}

class CollectionSubscriber implements ReactivitySubscriber {
	private last: number;
	private initialized: boolean;

	constructor(private readonly deps: ReactivitySubscriberDeps) {
		const lastKnownRev = deps.lastKnownRev ?? 0;
		this.last = lastKnownRev;
		// A fresh subscribe (lastKnownRev == 0) has no baseline yet; the first verified notification sets it.
		this.initialized = lastKnownRev > 0;
	}

	get lastRevision(): number {
		return this.last;
	}

	async onNotification(n: NotificationV1): Promise<DeliveryOutcome> {
		if (n.collectionId !== this.deps.collectionId) {
			return "foreign";
		}
		// Verify first (one fetch-and-retry is internal to the verifier). An untrusted notification is
		// dropped before any (collectionId, revision) dedupe or lastRevision update.
		const verdict = await this.deps.verifier.verify(n);
		if (verdict !== "verified") {
			return "untrusted";
		}

		// Fresh subscription: adopt the first verified notification as the contiguity baseline.
		if (!this.initialized) {
			this.initialized = true;
			this.last = n.revision;
			this.deps.deliver(n);
			return "delivered";
		}

		// Dedupe by (collectionId, revision): anything at or below the contiguous head is already delivered.
		if (n.revision <= this.last) {
			return "duplicate";
		}

		// Contiguity check.
		if (n.revision === this.last + 1) {
			this.last = n.revision;
			this.deps.deliver(n);
			return "delivered";
		}

		// Gap: request the missing range (inclusive of `revision`); the backfilled entries re-enter here.
		this.deps.requestBackfill?.(this.last + 1, n.revision);
		return "gap";
	}
}

/** Build a {@link ReactivitySubscriber} for one collection. */
export function createReactivitySubscriber(deps: ReactivitySubscriberDeps): ReactivitySubscriber {
	return new CollectionSubscriber(deps);
}
