import type { StaleFailure } from "./struct.js";

/**
 * The single rule for "is this non-success retryable after a re-read?" Both write paths and the
 * transactor's aggregation call this — no consumer re-derives it.
 *
 * {@link StaleFailure.conflict} is authoritative when present. The `missing`/`pending` fallback
 * covers producers that have not been taught the field, including a remote peer on an older build
 * (the repo protocol is plain JSON, so an unset field simply arrives absent).
 */
export function isConflictFailure(failure: StaleFailure): boolean {
	return failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length);
}
