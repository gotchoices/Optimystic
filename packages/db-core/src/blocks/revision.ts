/**
 * A revision number is the third wire-supplied name a backend turns into a location. The filesystem
 * backend uses it RAW as a filename (`<store>/<blockId>/revs/<rev>.json`, and the same under
 * `proofs/`), and the LevelDB backend writes it as a fixed-width unsigned key suffix
 * (`revScopedKey`'s `setBigUint64(…, BigInt(rev))` in `packages/db-p2p-storage-rn/src/keys.ts`). It
 * is declared `number`, but it arrives from the same `JSON.parse`d request as the other two, so the
 * declared type is not evidence at a network boundary. A revision number is valid when, and only
 * when:
 *
 * > `Number.isSafeInteger(rev) && rev >= 0`
 *
 * One predicate closes both shapes. A non-integer (`'../escaped'`, `NaN`, `1.5`) spells a path
 * segment naming somewhere else on the fs backend and throws out of `BigInt()` on the LevelDB one;
 * a negative throws out of `setBigUint64`, which takes unsigned. Both of those throws are inside a
 * backend's write path, where a throw latches the store (the flush contract's rule 5 at
 * `RawStoreDriver.flush`) rather than refusing one request — which is why the check belongs above
 * the driver with the other two.
 *
 * `0` is accepted and is legitimately reached: a rev-less pend compares and lists from
 * `request.rev ?? 0` (`StorageRepo.pend`). Nothing legitimately reaches a NEGATIVE rev — the two
 * expressions that could arithmetically produce one are both guarded above storage
 * (`computeRevertedBlock` probes only when `invalidatedRev > 1`, and `getBlock(request.rev - 1)`
 * fails `inRanges` before any revision record is read) — so the floor stays at 0 rather than being
 * widened for a caller.
 */
export function isValidRevision(rev: number): boolean {
	return Number.isSafeInteger(rev) && rev >= 0;
}

/**
 * Throw unless `rev` satisfies {@link isValidRevision}. Called by `KvRawStorage` on every revision
 * number it is given, reads included, before the number reaches a driver — so a refusal rejects that
 * one call and leaves the store usable.
 */
export function assertValidRevision(rev: number): void {
	if (!isValidRevision(rev)) throw new InvalidRevisionError(rev);
}

/** A revision number that does not name a location inside the store that was asked to hold it. */
export class InvalidRevisionError extends Error {
	constructor(readonly rev: unknown) {
		// `String` for a number, so `NaN` and `Infinity` read as themselves rather than as the `null`
		// JSON.stringify renders them; quoted otherwise, so a string that reached here is visible as one.
		super(`revision ${typeof rev === 'number' ? String(rev) : JSON.stringify(rev)} is not a non-negative safe integer; see isValidRevision for the rule`);
		this.name = 'InvalidRevisionError';
	}
}
