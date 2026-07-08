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
 * Current operations-hash FORMAT VERSION. Versions the *serialization* of operations
 * into bytes (the sort key, {@link canonicalStringify} rules, and the SHA-256/base64url
 * step) — distinct from `engineId` in the TransactionStamp, which versions the operation
 * *content* an engine produces from the same statements. Two honest nodes must agree on
 * BOTH dimensions to produce the same ops-hash.
 *
 * Bump this whenever a change to the canonical serialization alters the emitted bytes,
 * so a peer running the old format is *detected* (a legible version-skew error) rather
 * than mistaken for a content disagreement or a Byzantine lie. See docs/transactions.md
 * ("Operations Hash — Canonical Serialization").
 */
export const OPS_HASH_VERSION = 'v1';

/**
 * Wire-token prefix carrying {@link OPS_HASH_VERSION}: `ops.v1:`. The `.` delimiter is
 * outside the base64url alphabet (A–Z a–z 0–9 `-` `_`) that follows the trailing `:`, so
 * the version segment can always be sliced back out unambiguously — see {@link opsHashVersion}.
 */
export const OPS_HASH_PREFIX = `ops.${OPS_HASH_VERSION}:`;

/**
 * Extract the format-version segment from an ops-hash token — the `v1` in `ops.v1:<hash>` —
 * or `null` if the string is not a recognizable versioned ops-hash token.
 *
 * Total: never throws. A bare legacy `ops:<hash>` token (no `.` delimiter), an empty
 * string, or any garbage all return `null`. A validator treats a `null` (or a version it
 * does not recognize) as an unsupported/foreign format — a legible version-skew error —
 * never as an accidental content match.
 */
export function opsHashVersion(token: string): string | null {
	if (typeof token !== 'string') return null;
	if (!token.startsWith('ops.')) return null;
	const colon = token.indexOf(':', 4);
	if (colon <= 4) return null; // no version characters between "ops." and ":"
	return token.slice(4, colon);
}

/**
 * The EXACT canonical byte-string {@link hashOperations} feeds into SHA-256: the operations
 * sorted by {@link compareOperations} and run through {@link canonicalStringify}. The version
 * token is NOT part of this preimage — it wraps the resulting hash, it is not hashed.
 *
 * Exposed so a future client signature (design-client-transaction-signatures) can bind the
 * IDENTICAL bytes the validators hash, rather than re-deriving the serialization and risking
 * drift. Pair it with {@link OPS_HASH_VERSION} to record which format the bytes belong to.
 */
export function canonicalOperationsPayload(operations: readonly Operation[]): string {
	return canonicalStringify([...operations].sort(compareOperations));
}

/**
 * Compute the transaction operations hash: sort into canonical order, canonically
 * stringify, SHA-256 (base64url) via {@link hashString}, then prefix the versioned
 * {@link OPS_HASH_PREFIX} token (`ops.v1:`) so the wire string is self-describing.
 *
 * This is the fingerprint the coordinator sends in PendRequest.operationsHash and
 * the validator recomputes; equality of this string is the cross-node agreement
 * that a transaction's operations match.
 *
 * NOTE: the ops-hash carries a format-version token, so a mixed-version cluster now
 * *detects* skew — a validator seeing a foreign/legacy version emits a distinct
 * "unsupported operations-hash format version" error instead of the ambiguous
 * "Operations hash mismatch" (see TransactionValidator). What it does NOT do is
 * *cross-compute* older formats: a node only recognizes that a peer speaks a different
 * version, it cannot reproduce that peer's historical bytes. Mixed-version clusters
 * therefore fail LEGIBLY, not interoperably; multi-version compatibility is future
 * work if rolling upgrades ship. The ops-hash is recomputed fresh on both sides and
 * never persisted, so bumping the version cannot retroactively invalidate committed
 * transactions (unlike transaction.id, which IS persisted — leave it untouched).
 */
export async function hashOperations(operations: readonly Operation[]): Promise<string> {
	return `${OPS_HASH_PREFIX}${await hashString(canonicalOperationsPayload(operations))}`;
}
