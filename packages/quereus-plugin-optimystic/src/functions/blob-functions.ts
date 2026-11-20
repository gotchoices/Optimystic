/**
 * The two blob SQL functions of docs/blobs.md §SQL: `BlobLocality(ref)` and `BlobSize(ref)`, both
 * answered from this machine's own blob records.
 * Content never passes through SQL.
 *
 * NOTE: nothing REFUSES either function's value being written into a row — `insert into T (Loc)
 * values (BlobLocality(?))` goes in today, and so does `CommitOutlook()`, which has the same shape.
 * It is harmless while no deployment wires a transaction validator, so no member ever re-executes a
 * statement (`feat-no-deployment-validates-transactions-at-pend`); once one does, such a member
 * computes a different value from its own bytes and disagrees with the writer. If that ticket lands,
 * refuse a non-deterministic plugin function in a written value at the write-provenance seam — as a
 * class over all three functions, not one at a time.
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { BlobRefError, parseBlobRef } from '@optimystic/db-core';
import type { SqlBlobService } from '../optimystic-adapter/sql-blob-service.js';

/**
 * `BlobLocality(ref)` — how much of the referenced blob this machine holds: `'here'`, `'partial'`,
 * `'elsewhere'`, or `'unknown'` for a blob this machine knows nothing of. NULL in gives NULL.
 *
 * Answered WITHOUT `probe`, so it reads this machine's records alone and never waits on the
 * network — which is also why it is not `DETERMINISTIC`: the answer changes as bytes move.
 *
 * **Not for a written value.** A validating member re-executing a statement whose written value came
 * from `BlobLocality` would compute a different one, since the two machines hold different bytes.
 */
export function createBlobLocalityFunction(blobs: SqlBlobService) {
	return async function blobLocality(value: SqlValue): Promise<SqlValue> {
		if (value === null) return null;
		const ref = refOf(value);
		return (await blobs.stat(ref)).locality;
	};
}

/**
 * `BlobSize(ref)` — the blob's size in bytes as this machine knows it, or NULL while its root piece
 * is not here (including for a reference this machine knows nothing of). NULL in gives NULL. Not
 * deterministic, and not for a written value, for {@link createBlobLocalityFunction}'s reasons.
 */
export function createBlobSizeFunction(blobs: SqlBlobService) {
	return async function blobSize(value: SqlValue): Promise<SqlValue> {
		if (value === null) return null;
		const ref = refOf(value);
		return (await blobs.stat(ref)).size ?? null;
	};
}

/**
 * The argument as a reference. A non-string and a malformed string both raise `BlobRefError`, which
 * becomes a `MISMATCH` carrying its reason in the message and the original as its `cause` — the
 * same classification the `blobref` column type refuses a bad value with, so a caller sees one kind
 * of error for one kind of mistake wherever it is made.
 */
function refOf(value: SqlValue) {
	try {
		return parseBlobRef(value as string);
	} catch (error) {
		if (error instanceof BlobRefError) {
			throw new QuereusError(error.message, StatusCode.MISMATCH, error);
		}
		throw error;
	}
}
