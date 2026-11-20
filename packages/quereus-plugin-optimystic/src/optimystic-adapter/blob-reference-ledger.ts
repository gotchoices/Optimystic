/**
 * blob-reference-ledger — what one SQL transaction did to blob references, kept on the transaction
 * the way its write facts are, and folded at commit into the pins it must take
 * (docs/blobs.md §Committing a reference).
 *
 * Two lists. `records` is one entry per reference-tree change the transaction's statements staged,
 * in staging order, as `BlobReferenceMaintainer`'s `onStaged` hook reported them; `puts` is one
 * entry per blob `put` made through `plugin.blobs` while the transaction was open. Both carry the
 * transactor key of the network they belong to, since one transaction may write tables on two.
 *
 * The fold is {@link addedReferences}, and ITS KEY IS THE REFERRER, not the reference: a referrer
 * is one row's one column, which holds at most one reference at a time, so "the last change staged
 * at this referrer" is exactly what the reference tree holds once the commit lands. That is what
 * makes an insert-then-delete pin nothing, an update from one reference to another pin only the
 * new one, and a primary-key move (remove under the old referrer, add under the new) keep the
 * reference pinned.
 */

import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { ReferenceChange } from '../schema/blob-reference-maintainer.js';

/** One staged reference-tree change, with the network whose blob store holds its bytes. */
export interface BlobReferenceRecord {
	readonly backendKey: string;
	readonly change: ReferenceChange;
}

/** One blob `put` made while the transaction was open, pinned under its `put` label. */
export interface BlobPutRecord {
	readonly backendKey: string;
	readonly ref: BlobRef;
}

/** A (backend, reference, scope) triple the transaction leaves added — one pin each. */
export interface AddedBlobReference {
	readonly backendKey: string;
	readonly ref: BlobRef;
	readonly scope: BlobScope;
}

/** What one transaction has staged and put so far. */
export interface BlobReferenceLedger {
	readonly records: BlobReferenceRecord[];
	readonly puts: BlobPutRecord[];
	/** `records.length` at each open legacy savepoint, by depth. */
	readonly marks: Map<number, number>;
}

export function emptyBlobReferenceLedger(): BlobReferenceLedger {
	return { records: [], puts: [], marks: new Map() };
}

/**
 * The (backend, reference, scope) triples the transaction leaves ADDED, each once.
 *
 * Two steps, and both matter. First the last change staged at each referrer wins, which is what
 * turns a sequence of staged changes into the state the tree will hold. Then the surviving adds are
 * deduplicated by (backend, reference, scope), because a pin is held per scope: two rows of one
 * table that come to reference one blob are two referrers but one pin, while the same blob
 * referenced from two TABLES is two scopes and so two pins.
 */
export function addedReferences(ledger: BlobReferenceLedger): AddedBlobReference[] {
	const atReferrer = new Map<string, BlobReferenceRecord>();
	for (const record of ledger.records) {
		atReferrer.set(referrerKey(record), record);
	}
	const added = new Map<string, AddedBlobReference>();
	for (const { backendKey, change } of atReferrer.values()) {
		if (change.op !== 'add') continue;
		const triple = { backendKey, ref: change.ref, scope: change.scope };
		const key = JSON.stringify([backendKey, change.ref, change.scope]);
		if (!added.has(key)) added.set(key, triple);
	}
	return [...added.values()];
}

/** The transaction's puts, deduplicated by (backend, reference): one `put` pin per blob. */
export function putReferences(ledger: BlobReferenceLedger): BlobPutRecord[] {
	const puts = new Map<string, BlobPutRecord>();
	for (const put of ledger.puts) {
		const key = JSON.stringify([put.backendKey, put.ref]);
		if (!puts.has(key)) puts.set(key, put);
	}
	return [...puts.values()];
}

/** One row's one column on one network, in one scope — the unit at most one reference sits at. */
function referrerKey({ backendKey, change }: BlobReferenceRecord): string {
	return JSON.stringify([backendKey, change.scope, change.referrer]);
}
