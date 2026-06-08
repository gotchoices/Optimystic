/**
 * Cohort-topic substrate — deterministic primary/backup sharding.
 *
 * Transcribed from `docs/cohort-topic.md` §Primary and backup sharding:
 *
 * ```
 * order(cohortMembers) = sort(cohortMembers, by PeerId ascending)
 * slot(participantId, cohortEpoch) = H(participantId ‖ cohortEpoch) mod k
 * primary  = order[slot]
 * backups  = order[slot+1 .. slot+2  (mod k)]
 * ```
 *
 * Deterministic given `(participantId, cohortEpoch, members)`; shards delivery load roughly evenly
 * across the `~k` members. `H` is the injected {@link IRingHash} (db-core's own SHA-256 — **not** a
 * FRET import), reused so coords stay byte-compatible with the rest of the substrate.
 */

import type { IRingHash } from "../ports.js";
import { compareBytes, concatBytes } from "./bytes.js";

/** Deterministic slot assignment over a fixed cohort snapshot. */
export interface SlotAssigner {
	/**
	 * `(primary, backups)` for `participantId` under `cohortEpoch` and `cohortMembers`.
	 * Backups are the 1..2 members following the primary in ascending order, wrapping mod `k`.
	 */
	assignSlots(participantId: Uint8Array, cohortEpoch: Uint8Array, cohortMembers: readonly Uint8Array[]): { primary: Uint8Array; backups: Uint8Array[] };
}

/** Number of warm-failover backups (capped by available members). */
const MAX_BACKUPS = 2;

/** `coord mod k` over the full digest, MSB-first, without bigint allocation. */
function modK(coord: Uint8Array, k: number): number {
	let acc = 0;
	for (let i = 0; i < coord.length; i++) {
		acc = (acc * 256 + coord[i]!) % k;
	}
	return acc;
}

/** Build a {@link SlotAssigner} bound to a hash. */
export function createSlotAssigner(hash: IRingHash): SlotAssigner {
	return {
		assignSlots(participantId: Uint8Array, cohortEpoch: Uint8Array, cohortMembers: readonly Uint8Array[]): { primary: Uint8Array; backups: Uint8Array[] } {
			const k = cohortMembers.length;
			if (k === 0) {
				throw new RangeError("assignSlots requires a non-empty cohort");
			}
			const order = [...cohortMembers].sort(compareBytes);
			const slot = modK(hash.H(concatBytes(participantId, cohortEpoch)), k);
			const primary = order[slot]!;
			const backups: Uint8Array[] = [];
			const nBackups = Math.min(MAX_BACKUPS, k - 1);
			for (let i = 1; i <= nBackups; i++) {
				backups.push(order[(slot + i) % k]!);
			}
			return { primary, backups };
		},
	};
}
