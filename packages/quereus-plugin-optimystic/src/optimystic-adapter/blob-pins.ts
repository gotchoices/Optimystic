/**
 * blob-pins — the pins a SQL transaction's blob references are held under while it commits, and
 * their release once it lands (docs/blobs.md §Committing a reference, §SQL "Pins follow the
 * transaction").
 *
 * "The writer keeps what it wrote": while a transaction that references a blob is being committed,
 * the blob is pinned on this machine, so the reference its commit publishes is always backed by at
 * least one copy. Once the commit lands, the writer announces each reference with the table's
 * reference tree as its scope — which is what authorizes the blob's cohort to store it and takes
 * the `owed` hold that keeps it here until the cohort does — and only then releases the pin.
 *
 * The pin is taken when the COMMIT STARTS rather than when a statement first stages the reference,
 * which is where docs/blobs.md §SQL words it. Nothing reached from the vtab's `update()` may call
 * the blob service at all: a validating member re-executes the same statements and has no bytes, so
 * it must neither pin nor announce. What the departure changes is bounded — a transaction left open
 * longer than the `unstaged` holding period — and `feat-sql-columns-hold-blob-references` closes
 * that by never expiring an `unstaged` pin whose reference an open or queued transaction has
 * staged.
 *
 * Every settling arm takes the transaction as well as the pins it is holding, and reads the puts
 * off the transaction's own ledger rather than off {@link HeldPins}: one source of truth for the
 * puts, and it is what lets an arm run for a commit whose {@link SqlBlobPins.holdForCommit} never
 * completed. None of them throws: by the time one runs the write is durable or queued, and a
 * failure here must not turn a successful commit into a failed one.
 */

import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { BlobBackend } from './collection-factory.js';
import type { BlobScopeRegistration } from './blob-scope-registration.js';
import {
	UNSTAGED_PIN_PREFIX,
	parsePinLabel,
	transactionPutPinLabel,
	transactionReferencePinLabel,
} from './blob-pin-labels.js';
import { addedReferences, putReferences } from './blob-reference-ledger.js';
import type { TransactionState } from '../types.js';
import { createLogger } from '../logger.js';

/** One line per pin taken, kept or released (docs/debugging.md §quereus-plugin sub-namespaces). */
const log = createLogger('blob');

/** One reference pinned for a committing transaction, with everything its release needs. */
export interface HeldReference {
	readonly backend: BlobBackend;
	readonly ref: BlobRef;
	readonly scope: BlobScope;
	readonly label: string;
}

/** What one transaction holds while it commits. */
export interface HeldPins {
	readonly transactionId: string;
	readonly references: readonly HeldReference[];
}

/** How a transaction ended, as the settling arms distinguish it. */
export type BlobPinSettlement = 'queued' | 'abandoned' | { readonly committed: 'all' | ReadonlySet<string> };

export interface SqlBlobPinsDeps {
	/** `CollectionFactory.blobBackendForKey`: the backend of a transactor key the factory has seen. */
	backendByKey(key: string): Promise<BlobBackend>;
	registration: BlobScopeRegistration;
}

export class SqlBlobPins {
	// NOTE: every pin, announcement and release below is awaited in sequence, one reference at a
	// time, so a transaction that adds N references costs N local record writes at `holdForCommit`
	// and up to 2N at the release — all local, and all inside the commit the host is awaiting. Fine
	// at the scale a SQL transaction writes rows; if a transaction that references hundreds of blobs
	// ever shows the commit slowing, batch the record writes per backend rather than interleaving
	// the announcements, which must stay ordered before their own unpin.
	constructor(private readonly deps: SqlBlobPinsDeps) {}

	/**
	 * Pin every reference the transaction leaves added, under its transaction label.
	 *
	 * Every such reference is pinned whether or not this machine holds its bytes: a reference copied
	 * from another row commits and reads as not held, and announcing it still tells its cohort where
	 * to look for it.
	 *
	 * All or nothing. A pin's record write failing fails the COMMIT, before anything has been sent,
	 * and this unpins what it had already taken first — so the ordinary failed-commit path that
	 * follows finds nothing held under a reference label. `undefined` when the transaction adds no
	 * reference, which is every commit of every table without a `blobref` column.
	 */
	async holdForCommit(transaction: TransactionState): Promise<HeldPins | undefined> {
		const added = addedReferences(transaction.blobReferences);
		if (added.length === 0) return undefined;
		const references: HeldReference[] = [];
		try {
			for (const { backendKey, ref, scope } of added) {
				const backend = await this.deps.backendByKey(backendKey);
				const label = transactionReferencePinLabel(transaction.stampId, scope);
				await backend.service.pin(ref, label);
				references.push({ backend, ref, scope, label });
			}
		} catch (error) {
			await this.releaseReferences(references);
			throw error;
		}
		log('blob:pin-held transaction=%s refs=%d', transaction.stampId, references.length);
		return { transactionId: transaction.stampId, references };
	}

	/**
	 * The commit landed for `committed` scopes — `'all'`, or the collection ids a partial commit
	 * names. Each committed reference is announced into its scope and then unpinned, in that order,
	 * so no instant leaves a committed reference with no hold on this machine; its `unstaged` pins
	 * go with it, and so do the transaction's `put` pins.
	 *
	 * A reference whose scope is NOT committed, one whose scope cannot be confirmed in the network's
	 * registry, and one whose announcement throws all KEEP their pin, logged with the reason: the
	 * bytes stay here and `feat-sql-columns-hold-blob-references` retries the release.
	 */
	async committed(held: HeldPins | undefined, transaction: TransactionState, committed: 'all' | ReadonlySet<string>): Promise<void> {
		const landed: HeldReference[] = [];
		for (const reference of held?.references ?? []) {
			if (committed !== 'all' && !committed.has(reference.scope)) {
				log('blob:pin-kept transaction=%s ref=%s scope=%s reason=scope-not-committed',
					transaction.stampId, reference.ref, reference.scope);
				continue;
			}
			landed.push(reference);
			await this.announceAndRelease(transaction, reference);
		}
		// Every reference whose row landed, whether or not its announcement did: a kept reference pin
		// holds the bytes here just as the `unstaged` pin did, so the application's pre-transaction
		// hold has done its job either way.
		await this.releaseUnstaged(landed);
		await this.releasePuts(transaction);
	}

	/**
	 * The transaction was sealed into the offline queue. Its reference pins stay, to be settled with
	 * the queued transaction itself; its `put` pins are dropped as a landed commit drops them.
	 *
	 * The `unstaged` pins are KEPT — see {@link abandoned}.
	 */
	async queued(_held: HeldPins | undefined, transaction: TransactionState): Promise<void> {
		await this.releasePuts(transaction);
	}

	/**
	 * Nothing of the transaction is durable or queued: every reference pin it took goes, and so does
	 * every `put` pin of the transaction.
	 *
	 * The `unstaged` pins are left alone. The application put those bytes OUTSIDE the transaction and
	 * may retry the insert, so dropping them would lose bytes an immediate retry would have kept;
	 * the holding period bounds them instead. Only {@link committed} drops an `unstaged` pin, for the
	 * same reason it is the only arm that can: a reference pin can still be released without its row
	 * ever landing (a queued entry that later fails settles with whatever it committed, possibly
	 * nothing), and this fails toward keeping bytes, which is the bias docs/blobs.md takes throughout.
	 */
	async abandoned(held: HeldPins | undefined, transaction: TransactionState): Promise<void> {
		await this.releaseReferences(held?.references ?? []);
		await this.releasePuts(transaction);
	}

	/**
	 * Announce one committed reference into its scope and release its pin; `false` when the pin was
	 * kept instead. Nothing is announced into a tree the network's registry does not list: a scope no
	 * storage node reads is one an announcement teaches nothing.
	 *
	 * A node built without a blob copy drain throws out of `announce` for EVERY reference
	 * (`NodeBlobService.announce`), which is exactly why this cannot be allowed to escape into the
	 * commit: the rows are durable, and the only sane answer is to keep the bytes here and say so.
	 */
	private async announceAndRelease(transaction: TransactionState, reference: HeldReference): Promise<boolean> {
		const { backend, ref, scope, label } = reference;
		try {
			// `BlobBackend extends NetworkBinding`, so the backend IS the network the registry is read
			// and written through.
			const outcome = await this.deps.registration.ensure(backend, scope);
			if (!outcome.registered) {
				log('blob:pin-kept transaction=%s ref=%s scope=%s reason=scope-unregistered %o',
					transaction.stampId, ref, scope, outcome.cause);
				return false;
			}
			await backend.service.announce(ref, scope);
			log('blob:announced transaction=%s ref=%s scope=%s', transaction.stampId, ref, scope);
		} catch (error) {
			log('blob:pin-kept transaction=%s ref=%s scope=%s reason=announce-failed %o',
				transaction.stampId, ref, scope, error);
			return false;
		}
		await this.unpinOrLog(backend, ref, label);
		return true;
	}

	/** Drop every `unstaged` pin each settled reference still holds on its own backend. */
	private async releaseUnstaged(settled: readonly HeldReference[]): Promise<void> {
		// One pass per (backend, reference): two scopes of one reference settle twice, and the second
		// pass finds the pins the first already dropped gone.
		const seen = new Set<string>();
		for (const { backend, ref } of settled) {
			const key = JSON.stringify([backend.key, ref]);
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				for (const label of await backend.service.pinsOf(ref)) {
					if (parsePinLabel(label)?.kind === 'unstaged') await this.unpinOrLog(backend, ref, label);
				}
			} catch (error) {
				log('blob:pin-release-failed ref=%s owner=%s* %o', ref, UNSTAGED_PIN_PREFIX, error);
			}
		}
	}

	/**
	 * Drop the transaction's `put` pins — one label over each blob it put while open.
	 *
	 * A referenced blob is held by its reference pin or by the `owed` hold its announcement took, and
	 * an unreferenced one was put inside a transaction that chose not to keep it. That is the design
	 * (docs/blobs.md §SQL) and it is a footgun: `begin; put(a); put(b); insert … values (a); commit`
	 * loses `b`. Put outside any transaction, or pass an explicit `owner`, to keep a blob no row
	 * references.
	 */
	private async releasePuts(transaction: TransactionState): Promise<void> {
		const label = transactionPutPinLabel(transaction.stampId);
		for (const { backendKey, ref } of putReferences(transaction.blobReferences)) {
			try {
				const backend = await this.deps.backendByKey(backendKey);
				await this.unpinOrLog(backend, ref, label);
			} catch (error) {
				log('blob:pin-release-failed ref=%s owner=%s %o', ref, label, error);
			}
		}
	}

	/** Drop every reference pin in `references`, each independently of the others. */
	private async releaseReferences(references: readonly HeldReference[]): Promise<void> {
		for (const { backend, ref, label } of references) {
			await this.unpinOrLog(backend, ref, label);
		}
	}

	private async unpinOrLog(backend: BlobBackend, ref: BlobRef, label: string): Promise<void> {
		try {
			await backend.service.unpin(ref, label);
		} catch (error) {
			log('blob:pin-release-failed ref=%s owner=%s %o', ref, label, error);
		}
	}
}
