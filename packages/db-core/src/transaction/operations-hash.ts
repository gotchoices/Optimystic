import type { BlockId, IBlock, BlockOperations } from '../blocks/structs.js';
import type { CollectionId } from '../collection/struct.js';
import type { Transforms } from '../transform/struct.js';
import { hashString } from '../utility/hash-string.js';

/**
 * Represents an operation on a block within a collection.
 *
 * This is the SINGLE source of truth for the operation shape used by the
 * transaction "operations hash" — the fingerprint a coordinator sends and a
 * validator recomputes. Both {@link TransactionCoordinator} and
 * {@link TransactionValidator} import this type; it must never be duplicated,
 * because the two sides disagreeing is exactly the bug this module prevents.
 */
export type Operation =
	| { readonly type: 'insert'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly block: IBlock }
	| { readonly type: 'update'; readonly collectionId: CollectionId; readonly blockId: BlockId; readonly operations: BlockOperations }
	| { readonly type: 'delete'; readonly collectionId: CollectionId; readonly blockId: BlockId };

/**
 * Rank of each operation type, used ONLY as the final tiebreaker when the same
 * (collectionId, blockId) legitimately carries more than one operation — a block
 * staged, then mutated, then deleted within one transform (Transforms apply order
 * is insert → update → delete; see transform/struct.ts). This is the semantic
 * apply order. The exact ranking is arbitrary for correctness (both sides use it),
 * but it MUST be defined in exactly one place — here.
 */
const TYPE_RANK: Record<Operation['type'], number> = {
	insert: 0,
	update: 1,
	delete: 2,
};

/**
 * Collect every block operation across all collections into a flat list.
 *
 * The returned order reflects Map/object insertion order and is therefore NOT
 * canonical — {@link hashOperations} sorts before hashing, so callers do not need
 * to pre-sort. Shared by the coordinator (both commit() and execute()) and the
 * validator so all three collect sites produce the identical logical set.
 */
export function collectOperations(transforms: Map<CollectionId, Transforms>): Operation[] {
	const operations: Operation[] = [];
	for (const [collectionId, t] of transforms) {
		for (const [blockId, block] of Object.entries(t.inserts ?? {})) {
			operations.push({ type: 'insert', collectionId, blockId, block });
		}
		for (const [blockId, ops] of Object.entries(t.updates ?? {})) {
			operations.push({ type: 'update', collectionId, blockId, operations: ops });
		}
		for (const blockId of t.deletes ?? []) {
			operations.push({ type: 'delete', collectionId, blockId });
		}
	}
	return operations;
}

/**
 * Total order over operations by the tuple (collectionId, blockId, type), using
 * plain string comparison on the first two components and {@link TYPE_RANK} on the
 * third. This is the cross-node ordering contract: two honest nodes that see the
 * same logical set MUST produce the same sorted sequence regardless of the order
 * they happened to collect operations in.
 */
function compareOperations(a: Operation, b: Operation): number {
	if (a.collectionId !== b.collectionId) return a.collectionId < b.collectionId ? -1 : 1;
	if (a.blockId !== b.blockId) return a.blockId < b.blockId ? -1 : 1;
	return TYPE_RANK[a.type] - TYPE_RANK[b.type];
}

/**
 * Canonical JSON encoder: recursively sorts object keys but PRESERVES array element
 * order, and matches JSON.stringify leaf semantics.
 *
 * - Object keys are emitted in ascending (sorted) order, so two objects with the
 *   same content but different key-insertion order encode identically.
 * - Array element order is preserved because BlockOperations is an ordered list of
 *   [entity, index, deleteCount, inserted] tuples whose order is semantically
 *   meaningful (as are any data arrays nested inside an IBlock).
 * - Leaf semantics mirror JSON.stringify: `undefined`/function/symbol object-values
 *   are dropped, the same in arrays encode as `null`, `null` encodes as `null`,
 *   non-finite numbers as `null`, and other primitives via JSON.stringify.
 *
 * Exported so the order-independence test can exercise it directly.
 *
 * NOTE: no toJSON/Date special-casing — a value carrying toJSON (e.g. a Date)
 * encodes as its plain enumerable keys ({} for a Date), not JSON.stringify's
 * toJSON string. Harmless today (blocks hold plain JSON) and still deterministic
 * across nodes (both sides run this same encoder); if IBlock content ever grows
 * toJSON-bearing values and matching JSON.stringify exactly matters, add the hook.
 */
export function canonicalStringify(value: unknown): string {
	if (value === null) return 'null';

	const type = typeof value;
	if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	if (type === 'string' || type === 'boolean') return JSON.stringify(value);
	if (type === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
	if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';

	if (Array.isArray(value)) {
		const items = value.map(element => {
			const et = typeof element;
			// In arrays, undefined/function/symbol serialize as null (JSON.stringify semantics).
			if (element === undefined || et === 'function' || et === 'symbol') return 'null';
			return canonicalStringify(element);
		});
		return `[${items.join(',')}]`;
	}

	// Plain object: sort keys ascending, drop undefined/function/symbol values.
	const obj = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(obj).sort()) {
		const v = obj[key];
		const vt = typeof v;
		if (v === undefined || vt === 'function' || vt === 'symbol') continue;
		parts.push(`${JSON.stringify(key)}:${canonicalStringify(v)}`);
	}
	return `{${parts.join(',')}}`;
}

/**
 * Compute the transaction operations hash: sort into canonical order, canonically
 * stringify, then SHA-256 (base64url) via {@link hashString}, keeping the existing
 * `ops:` prefix so the on-the-wire hash format is unchanged.
 *
 * This is the fingerprint the coordinator sends in PendRequest.operationsHash and
 * the validator recomputes; equality of this string is the cross-node agreement
 * that a transaction's operations match.
 *
 * NOTE: this canonical encoding differs from the pre-refactor raw JSON.stringify
 * encoding, so the hash a given transaction produces changed. Same-version clusters
 * are unaffected (both sender and validator recompute fresh, nothing persisted). But
 * there is NO protocol-version gate on this hash: in a MIXED-version cluster an old
 * node and a new node would disagree and reject each other with "Operations hash
 * mismatch". If rolling upgrades become a supported deployment, version-gate this.
 */
export async function hashOperations(operations: readonly Operation[]): Promise<string> {
	const sorted = [...operations].sort(compareOperations);
	return `ops:${await hashString(canonicalStringify(sorted))}`;
}
