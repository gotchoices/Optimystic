import type { BlobRef, BlobScope } from '@optimystic/db-core';

/** Key prefix of every blob record in the node's IKVStore; one key per blob, `optimystic-blobs/<ref>`. */
export const BLOB_RECORD_KEY_PREFIX = 'optimystic-blobs/';
/** The owner a put with no `owner` is pinned under (docs/blobs.md §The node's blob service). */
export const DEFAULT_BLOB_OWNER = 'default';

/**
 * Why this node keeps a blob (docs/blobs.md §Holds). A record holds at most one pin per owner and
 * at most one hold of each other kind. `at` is when the hold was taken. A hold may carry further
 * properties a later ticket adds; the codec keeps them as it found them.
 */
export type BlobHold =
	| { readonly kind: 'pin'; readonly owner: string; readonly at: number }
	| { readonly kind: 'owed'; readonly at: number }
	/** `scope`: the scope the reference was last verified under, which the cohort's copying re-announces with. */
	| { readonly kind: 'responsible'; readonly at: number; readonly scope: BlobScope }
	| { readonly kind: 'cached'; readonly at: number };

export type BlobHoldKind = BlobHold['kind'];

/** One blob this node has a reason to keep, stored as JSON under `BLOB_RECORD_KEY_PREFIX + ref`. */
export interface BlobRecord {
	readonly v: 1;
	readonly ref: BlobRef;
	/** The blob's byte size, once known. */
	readonly size?: number;
	/** Whether every piece was here when last checked. A hint: `stat` trusts it while the root piece is here, and a read that finds a piece missing clears it. */
	readonly whole: boolean;
	/** When the blob was last read here, ms since the epoch; at most `LAST_READ_RESOLUTION_MS` stale. */
	readonly lastReadAt?: number;
	/** Never empty in a stored record: a record whose last hold goes is deleted. */
	readonly holds: readonly BlobHold[];
}

/** The stored text under a record's key is not a record of that blob. */
export class BlobRecordFormatError extends Error {
	constructor(readonly ref: BlobRef, reason: string) {
		super(`Blob record for ${ref} is malformed: ${reason}`);
		this.name = 'BlobRecordFormatError';
	}
}

const HOLD_KINDS: ReadonlySet<string> = new Set<BlobHoldKind>(['pin', 'owed', 'responsible', 'cached']);

/** The key a record of `ref` is stored under. */
export function blobRecordKey(ref: BlobRef): string {
	return BLOB_RECORD_KEY_PREFIX + ref;
}

export function encodeBlobRecord(record: BlobRecord): string {
	return JSON.stringify(record);
}

/**
 * The record `text` holds for `ref`, or BlobRecordFormatError naming the first rule it breaks.
 * Every property beyond the ones checked, on the record and on each hold, is kept as found, so a
 * field a later ticket adds is not a format change.
 */
export function decodeBlobRecord(ref: BlobRef, text: string): BlobRecord {
	const value = parseJson(ref, text);
	if (!isObject(value)) {
		throw new BlobRecordFormatError(ref, 'not a JSON object');
	}
	const problem = recordProblem(ref, value);
	if (problem !== undefined) {
		throw new BlobRecordFormatError(ref, problem);
	}
	return value as unknown as BlobRecord;
}

function parseJson(ref: BlobRef, text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		// JSON.parse reports bad input by throwing; the message is the detail the error carries.
		throw new BlobRecordFormatError(ref, `not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

function recordProblem(ref: BlobRef, record: Record<string, unknown>): string | undefined {
	if (record.v !== 1) {
		return `version ${JSON.stringify(record.v)}, not 1`;
	}
	if (record.ref !== ref) {
		return `names ${JSON.stringify(record.ref)}, not the blob its key names`;
	}
	if (record.size !== undefined && !isByteCount(record.size)) {
		return `size ${JSON.stringify(record.size)} is not a non-negative safe integer`;
	}
	if (typeof record.whole !== 'boolean') {
		return '"whole" is not a boolean';
	}
	if (record.lastReadAt !== undefined && !isFiniteNumber(record.lastReadAt)) {
		return '"lastReadAt" is not a finite number';
	}
	return holdsProblem(record.holds);
}

function holdsProblem(holds: unknown): string | undefined {
	if (!Array.isArray(holds)) {
		return '"holds" is not an array';
	}
	if (holds.length === 0) {
		return 'no holds (a record whose last hold goes is deleted)';
	}
	for (const [index, hold] of holds.entries()) {
		const problem = holdProblem(hold);
		if (problem !== undefined) {
			return `hold ${index}: ${problem}`;
		}
	}
	return undefined;
}

function holdProblem(hold: unknown): string | undefined {
	if (!isObject(hold)) {
		return 'not an object';
	}
	if (typeof hold.kind !== 'string' || !HOLD_KINDS.has(hold.kind)) {
		return `unknown kind ${JSON.stringify(hold.kind)}`;
	}
	if (!isFiniteNumber(hold.at)) {
		return '"at" is not a finite number';
	}
	if (hold.kind === 'pin' && (typeof hold.owner !== 'string' || hold.owner === '')) {
		return 'a pin with no owner';
	}
	if (hold.kind === 'responsible' && (typeof hold.scope !== 'string' || hold.scope === '')) {
		return 'a responsible hold with no scope';
	}
	return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isByteCount(value: unknown): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
