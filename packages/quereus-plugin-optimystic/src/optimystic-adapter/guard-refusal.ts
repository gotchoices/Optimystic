import { TreeGuardRefusedError } from '@optimystic/db-core';

/** The first guard refusal in `error`'s cause chain — the db-core refusal a commit failure carries
 * however it was wrapped — or `undefined` when there is none. */
export function guardRefusalIn(error: unknown): TreeGuardRefusedError | undefined {
	for (let cursor: unknown = error; cursor instanceof Error; cursor = cursor.cause) {
		if (cursor instanceof TreeGuardRefusedError) return cursor;
	}
	return undefined;
}
