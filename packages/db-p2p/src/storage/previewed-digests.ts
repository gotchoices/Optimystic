import type { ActionId, ActionRev, BlockId, Transform } from "@optimystic/db-core";
import { LruMap } from "@optimystic/db-core";

/**
 * What a block's next content is computed over: the committed revision a pending transform is
 * applied to, or `'insert'` for a transform carrying an insert, whose result is the same whatever
 * the block held before.
 */
export type DigestBase = ActionRev | 'insert';

/**
 * The {@link DigestBase} `transform` is applied over when this node's latest is `latest`, or
 * `undefined` when there is none: an update-only transform on a block with no committed revision,
 * which materializes nothing.
 */
export function digestBaseOf(transform: Transform, latest: ActionRev | undefined): DigestBase | undefined {
	return transform.insert !== undefined ? 'insert' : latest;
}

/** A preview's digest of a block's next content: the pending record's, over `base`, for a commit at `rev`. */
export interface PreviewedDigest {
	readonly rev: number;
	readonly base: DigestBase;
	readonly digest: string;
}

/**
 * A preview's hold on its key while it reads and hashes. Compared by identity: a later preview of
 * the key, a pend of the key or a commit of it replaces or removes the entry holding it, and the
 * preview's result is then not kept.
 */
export interface DigestReservation {
	readonly key: string;
}

interface Entry {
	readonly reservation: DigestReservation;
	readonly result?: PreviewedDigest;
}

/**
 * NOTE: one entry per block of each action previewed here and not yet committed; a commit removes its
 * entry, and one whose action never commits ages out. An evicted entry costs its commit one hash, as
 * every commit cost before this memo. If a profile under load ever shows commits hashing again, count
 * the results evicted before their commit and raise this bound.
 */
const PREVIEWED_DIGESTS_CAPACITY = 1024;

/**
 * The digests `StorageRepo.previewCommitDigest` computed on the promise round, kept so the commit
 * that applies the same pending record over the same base reuses one instead of hashing the same
 * content again.
 *
 * A block's next content is a function of two things: the pending record for `(blockId, actionId)`
 * and the base it is applied over. A result is keyed by the first and carries the second, and each
 * rule below makes a change to either one a miss:
 *
 * - **The record.** A preview reserves its key ({@link reserve}) BEFORE it reads the record, and keeps
 *   its result only if the key still holds its own reservation when it is done ({@link settle}). A
 *   pend removes the key right AFTER it saves the record ({@link forget}). So a preview that read the
 *   record a pend then replaced had its reservation removed before it could keep a result, or its
 *   result removed after, and a preview that reserved after the pend read the new record. Removing a
 *   record needs nothing here: no commit applies a record that is gone, and a new one arrives only
 *   through a pend.
 * - **The base.** {@link take} returns a result only for the revision and base the commit applies
 *   over; a base that moved between the preview and the commit is a miss.
 *
 * A miss costs the commit the hash it always paid. A wrong hit would store a commit proof for content
 * this node does not hold, so every rule fails toward a miss.
 *
 * The preview runs without the block's write latch, a pend and a commit under it; the reservation is
 * what keeps the preview's unlatched result from outliving a change made under the latch, which is
 * why it must be taken before the preview's first read of storage.
 */
export class PreviewedDigests {
	private readonly entries = new LruMap<string, Entry>(PREVIEWED_DIGESTS_CAPACITY);

	/** Claim `(blockId, actionId)` for a preview about to read its pending record, voiding any earlier claim. */
	reserve(blockId: BlockId, actionId: ActionId): DigestReservation {
		const reservation: DigestReservation = { key: keyOf(blockId, actionId) };
		this.entries.set(reservation.key, { reservation });
		return reservation;
	}

	/**
	 * End a preview: keep `result` when the key still holds `reservation`, and remove the reservation
	 * when there is no result (the preview materialized nothing to hash). A voided reservation keeps
	 * nothing.
	 */
	settle(reservation: DigestReservation, result: PreviewedDigest | undefined): void {
		if (this.entries.peek(reservation.key)?.reservation !== reservation) {
			return;
		}
		if (result === undefined) {
			this.entries.delete(reservation.key);
		} else {
			this.entries.set(reservation.key, { reservation, result });
		}
	}

	/** Drop whatever is held for `(blockId, actionId)`: its pending record has just been replaced. */
	forget(blockId: BlockId, actionId: ActionId): void {
		this.entries.delete(keyOf(blockId, actionId));
	}

	/**
	 * Remove what is held for `(blockId, actionId)`, and return its digest when it is a result for a
	 * commit at `rev` over `base`.
	 */
	take(blockId: BlockId, actionId: ActionId, rev: number, base: DigestBase | undefined): string | undefined {
		const key = keyOf(blockId, actionId);
		const result = this.entries.peek(key)?.result;
		this.entries.delete(key);
		return result !== undefined && result.rev === rev && sameBase(result.base, base) ? result.digest : undefined;
	}
}

/** Both ids are strings other machines choose, so the key is their JSON pair, which no two pairs share. */
function keyOf(blockId: BlockId, actionId: ActionId): string {
	return JSON.stringify([blockId, actionId]);
}

function sameBase(previewed: DigestBase, applied: DigestBase | undefined): boolean {
	if (previewed === 'insert' || applied === undefined || applied === 'insert') {
		return previewed === applied;
	}
	return previewed.rev === applied.rev && previewed.actionId === applied.actionId;
}
