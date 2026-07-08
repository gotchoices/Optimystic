import type { ArachnodeInfo } from './arachnode-fret-adapter.js';

/**
 * An Arachnode ring partition: the first `prefixBits` bits of a hashed coordinate must equal
 * `prefixValue` for a key to fall inside it. Structurally identical to `ArachnodeInfo.partition`.
 */
export interface RingPartition {
	prefixBits: number;
	prefixValue: number;
}

/**
 * Extract the first `bits` bits of a hashed coordinate as an integer (MSB-first).
 *
 * The single source of truth for the block/peer prefix comparison Arachnode uses to decide
 * responsibility. `RingSelector.calculatePartition` (peer side) and `RestorationCoordinator`
 * (block side) both route through this, so a peer's advertised partition and a block's derived
 * prefix are computed the same way — otherwise "this peer owns this block's slice" would silently
 * stop meaning what it says.
 */
export function extractPrefix(coord: Uint8Array, bits: number): number {
	let value = 0;
	for (let i = 0; i < bits; i++) {
		const byteIndex = Math.floor(i / 8);
		const bitIndex = 7 - (i % 8);
		const bit = (coord[byteIndex]! >> bitIndex) & 1;
		value = (value << 1) | bit;
	}
	return value;
}

/**
 * Does `partition` cover the key at `coord`? Ring 0 (an undefined partition) covers the whole
 * keyspace, so it always returns true.
 */
export function partitionCovers(partition: RingPartition | undefined, coord: Uint8Array): boolean {
	if (!partition) {
		return true;
	}
	return extractPrefix(coord, partition.prefixBits) === partition.prefixValue;
}

/**
 * Is the node described by `info` a currently-serving responsible holder for the key at `coord`?
 *
 * **Fail-toward-old-holder.** A node mid-move (`status === 'moving'`) advertises its *target*
 * `partition`, but it keeps serving its *old* range (`moveFrom`) until it releases. So a moving
 * node covers the key if EITHER its old range or its target range covers it — it is still counted
 * as a serving holder for everything it served before the move until it transitions to `active` at
 * the new ring. This is what keeps a shed key covered through Phases A–B and across a mid-handoff
 * crash. See `docs/arachnode-ring-handoff.md` § Part 3.
 */
export function isServingHolder(info: ArachnodeInfo, coord: Uint8Array): boolean {
	if (info.status === 'moving' && info.moveFrom) {
		return partitionCovers(info.moveFrom.partition, coord) || partitionCovers(info.partition, coord);
	}
	return partitionCovers(info.partition, coord);
}

/**
 * Does the node described by `info` qualify toward *another* mover's Phase-B replication floor for
 * the key at `coord`?
 *
 * A qualifying holder must still cover the key **after its own advertised move** — i.e. its
 * *target* `partition` (the one it currently advertises) must cover it. A concurrent mover that is
 * shedding the same sub-range advertises a target that does NOT cover the key, so it is excluded:
 * two adjacent movers can never both count the other, so at most one reaches "confirmed" on the
 * shared overlap and the other rolls back. For a non-moving (`active`) node, the advertised
 * partition IS its serving range, so this reduces to plain partition coverage. See
 * `docs/arachnode-ring-handoff.md` § Part 3 (concurrent moves).
 */
export function qualifiesForFloor(info: ArachnodeInfo, coord: Uint8Array): boolean {
	return partitionCovers(info.partition, coord);
}
