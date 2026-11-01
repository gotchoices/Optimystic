import type { ActionId } from "../collection/action.js";
import type { PendRequest } from "./struct.js";

/**
 * The most bytes one transaction's pend may encode to: 7.5 MiB, measured by {@link jsonEncodedBytes}
 * over the {@link PendRequest}s that travel together in one consensus record — transforms, validation
 * payload and all. That is the sum of the batch when a transaction's collections travel together
 * (`IRepo.pendMany`), and one collection's pend when they cannot and each is pended on its own.
 *
 * A pend's payload travels whole in one frame on every hop it takes: writer → coordinator on the repo
 * protocol, then coordinator → each other cohort member on the cluster protocol, and back as the
 * member's echoed answer. Both protocols decode under one frame cap (db-p2p's
 * `MAX_BLOCK_MESSAGE_BYTES`), which is this limit plus a reserve for the envelope around the pend, so a
 * transaction under this limit fits every frame it rides in. The limit is the same at every group
 * size: a solo cohort takes no cluster hop, but is held to it all the same, so a write that commits
 * on one machine does not start failing when a second joins.
 *
 * A writer with more to save than this splits it into several transactions.
 */
export const MAX_TRANSACTION_BYTES = 7.5 * 1024 * 1024;

/**
 * The bytes `value` encodes to on the wire: the UTF-8 length of its `JSON.stringify`. JSON is the
 * encoding every request and response frame of the repo and cluster protocols carries, so this is the
 * measure a frame cap is judged by.
 */
export function jsonEncodedBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * A transaction too large to send: its pend encodes to more than {@link MAX_TRANSACTION_BYTES}.
 * Raised before anything is sent, so nothing was reserved and nothing needs cancelling. Not a
 * `StaleFailure` and never retried — the same transaction is the same size on every attempt. The
 * writer has to split the change into smaller transactions.
 */
export class TransactionTooLargeError extends Error {
	constructor(
		readonly actionId: ActionId,
		/** What the transaction's pend encodes to, by {@link jsonEncodedBytes}. */
		readonly bytes: number,
		/** The limit it exceeded: {@link MAX_TRANSACTION_BYTES}. */
		readonly limit: number = MAX_TRANSACTION_BYTES,
	) {
		super(`transaction ${actionId} encodes to ${bytes} bytes, over the per-transaction limit MAX_TRANSACTION_BYTES (${limit} bytes); split it into smaller transactions`);
		this.name = 'TransactionTooLargeError';
	}
}

/**
 * What `requests` — one transaction's pends that ride in one consensus record — encode to together,
 * the measure {@link MAX_TRANSACTION_BYTES} is judged by.
 *
 * NOTE: encodes every request once more than sending it does, on the writer and again on the
 * coordinator. Negligible for an ordinary write; if pend encoding ever shows in a profile of large
 * writes, measure once on the writer and hand the size along instead.
 */
export function transactionBytes(requests: readonly PendRequest[]): number {
	let bytes = 0;
	for (const request of requests) bytes += jsonEncodedBytes(request);
	return bytes;
}

/**
 * Throws {@link TransactionTooLargeError} when `requests` together encode to more than
 * {@link MAX_TRANSACTION_BYTES} ({@link transactionBytes}). The one rule both the writer (before
 * sending) and the coordinator (on receipt) apply.
 */
export function assertTransactionFits(requests: readonly PendRequest[]): void {
	if (requests.length === 0) return;
	const bytes = transactionBytes(requests);
	if (bytes > MAX_TRANSACTION_BYTES) throw new TransactionTooLargeError(requests[0]!.actionId, bytes);
}
