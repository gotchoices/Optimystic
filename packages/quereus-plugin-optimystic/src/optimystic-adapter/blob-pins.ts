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
 *
 * A QUEUED transaction keeps its reference pins deliberately — nothing is on the network yet, so the
 * writer is the only machine holding the bytes — until the queue finishes with it, which is
 * {@link SqlBlobPins.settleQueued}. That arm runs OFF the commit, on this object's own work chain
 * ({@link SqlBlobPins.settled}), because it has to wait for the transaction the status arrived during
 * to end before it touches the blob service.
 */

import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { BlobBackend } from './collection-factory.js';
import type { BlobScopeRegistration } from './blob-scope-registration.js';
import {
	UNSTAGED_PIN_PREFIX,
	parsePinLabel,
	transactionPinPrefix,
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
	/** `CollectionFactory.knownBlobBackends`: every blob backend this process could hold a pin in. */
	knownBackends(): Promise<BlobBackend[]>;
	/** `TransactionBridge.tablesOf`: the tables a scope (a reference tree's collection id) still backs
	 * in this process; empty or `undefined` once the table it belonged to is gone from here. */
	tablesOf(scope: BlobScope): ReadonlyMap<string, unknown> | undefined;
	/** `TransactionBridge.whenTransactionIdle`: resolves once no transaction is open on the bridge. */
	whenTransactionIdle(): Promise<void>;
}

/** Whether a settling reference's scope may be announced into ({@link SqlBlobPins.scopeState}). */
type ScopeState =
	/** In its network's registry: announce. */
	| 'registered'
	/** Certainly NOT in it — the table was dropped, here or elsewhere: release without announcing. */
	| 'dropped'
	/** Cannot be told now: keep the pin and let the reconciliation retry. */
	| 'unknown';

export class SqlBlobPins {
	/**
	 * What each queued transaction holds, remembered by {@link queued} and taken by
	 * {@link settleQueued}: the fast path that keeps a settle from scanning this machine's blob
	 * records. One entry per queued transaction that added a reference, so it is bounded by the
	 * queue's depth, and it is empty in a process that did not seal the entry itself.
	 */
	private readonly queuedPins = new Map<string, HeldPins>();
	/**
	 * Every transaction THIS process sealed into the queue, whether or not it added a reference
	 * ({@link queued}), until it settles. What it answers is "is {@link queuedPins} authoritative for
	 * this transaction": a transaction sealed here that is not in that map took no reference pin, so
	 * its settle needs no pin listing at all.
	 *
	 * Without it, a host that uses NO blobs would pay a listing — and the resolution of a blob store
	 * per network, which also starts that store's sweep — on every queued transaction it settles.
	 * Absence means "cannot say", which is the safe direction: the listing runs.
	 */
	private readonly sealedHere = new Set<string>();
	/** {@link settleQueued}'s work, one step at a time; never rejects ({@link chained}). */
	private chain: Promise<void> = Promise.resolve();
	private disposed = false;
	/** Resolved by {@link dispose}, so a step parked on an open transaction is not what keeps a
	 * disposing host waiting (`MaterializedViewFollower`'s `haltedPromise` precedent). */
	private releaseChain = (): void => undefined;
	private readonly disposing = new Promise<void>(resolve => { this.releaseChain = resolve; });

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
	 * the queued transaction itself ({@link settleQueued}), and what it holds is remembered so that
	 * settle costs no pin listing; its `put` pins are dropped as a landed commit drops them.
	 *
	 * The `unstaged` pins are KEPT — see {@link abandoned}.
	 */
	async queued(held: HeldPins | undefined, transaction: TransactionState): Promise<void> {
		this.sealedHere.add(transaction.stampId);
		// Both keyed by the same expression deliberately: a map keyed differently from its guard would
		// make the guard skip the listing for a transaction the map cannot answer for.
		if (held !== undefined) this.queuedPins.set(transaction.stampId, held);
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
	 * A QUEUED transaction has settled: `'all'` for a `committed` outcome, and for a failed one the
	 * collection ids it had committed, possibly none. Each reference pin it still holds is announced
	 * into its scope and released when that scope committed, and released outright when it did not —
	 * so the writer's piece sweep can take the bytes of a transaction that never landed.
	 *
	 * Chained rather than run inline ({@link chained}), and so never awaited by the caller: the queue
	 * reports a terminal status synchronously from its drain, and from the restore's discard, neither
	 * of which may be held up by a release that first waits for an open transaction to end. Never
	 * throws, and never reports anything worse than a line in the log: the transaction has already
	 * settled, and a pin that cannot be released is not a failure of anything a caller can retry.
	 *
	 * Idempotent, which is what makes a status delivered twice — or a race with the restart
	 * reconciliation — harmless: announcing a reference twice is one record write, and unpinning a
	 * label that is already gone does nothing.
	 *
	 * The transaction's OWN pins only, as every other arm. An `unstaged` pin is left alone even for a
	 * reference that landed — where {@link committed} would drop it — because the two have different
	 * remedies: an online commit is the pin's release, and a queued one is answered by the holding
	 * period that expires an `unstaged` pin no open or queued transaction has staged
	 * (`feat-sql-columns-hold-blob-references`). The bytes are kept either way.
	 */
	settleQueued(transactionId: string, committed: 'all' | ReadonlySet<string>): Promise<void> {
		return this.chained(() => this.releaseQueued(transactionId, committed));
	}

	/**
	 * Resolves once everything chained so far has run. Never rejects.
	 *
	 * NEVER await this inside a transaction: a chained step waits for the open transaction to end, so
	 * awaiting it from inside one deadlocks. For `plugin.hydrate` and for specs.
	 */
	settled(): Promise<void> {
		return this.chain;
	}

	/** Stop chaining further work and wait for what is chained; a step parked on an open transaction
	 * stops waiting for it. Idempotent. */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.releaseChain();
		await this.chain;
	}

	/**
	 * Run `step` after everything chained before it, once no transaction is open on the bridge. The
	 * chain is what the restart reconciliation joins, so no two settlements ever handle one
	 * transaction's pins at the same time; it never rejects, and a step that faults is logged.
	 *
	 * The ONLINE arms above stay off this chain deliberately: they run inside `commitTransaction` and
	 * `rollbackTransaction` under Quereus's exec mutex, and so must not wait on a chain that waits
	 * for the transaction they belong to.
	 */
	private chained(step: () => Promise<void>): Promise<void> {
		const run = this.chain.then(async () => {
			// NOTE: each race leaves one reaction on `disposing`, which settles only at dispose, so a
			// process that settles very many queued transactions retains one per settle (the
			// `MaterializedViewFollower` precedent has the same shape, at a far lower rate). Unmeasured;
			// if a long-lived host ever shows memory growing here, give the wait a waiter it removes.
			await Promise.race([this.deps.whenTransactionIdle(), this.disposing]);
			if (this.disposed) return;
			await step();
		}).catch(error => {
			// Every step isolates each reference itself, so reaching here means the step faulted.
			log('blob:pin-settle-failed %o', error);
		});
		this.chain = run;
		return run;
	}

	/**
	 * One queued transaction's reference pins, from memory when this process sealed the entry and
	 * from the pins' own labels when it did not.
	 */
	private async releaseQueued(transactionId: string, committed: 'all' | ReadonlySet<string>): Promise<void> {
		const held = this.queuedPins.get(transactionId);
		this.queuedPins.delete(transactionId);
		// Taken whichever path runs, so neither set holds a settled transaction.
		const sealedHere = this.sealedHere.delete(transactionId);
		// The fast path is not an optimization to be simplified away: `listPins` scans EVERY blob
		// record on this machine and reads each one (the `NOTE:` at `LocalBlobService.listPins`), so
		// without it a phone holding ten thousand photos would pay ten thousand key-value reads per
		// offline commit. The listing is the correct general answer and is still needed — a process
		// that did not seal the entry has nothing in memory — but it is the rare path.
		//
		// NOTE: a terminal status delivered TWICE for one transaction takes the listing on the second
		// pass, since both records were taken on the first; it is correct (it finds nothing) and rare.
		// `feat-blob-pins-reconcile-after-a-restart`'s `mayHoldStalePins` is where to cut it.
		const references = held?.references ?? (sealedHere ? [] : await this.listQueuedReferences(transactionId));
		for (const reference of references) {
			try {
				await this.settleQueuedReference(transactionId, reference, committed);
			} catch (error) {
				log('blob:pin-release-failed transaction=%s ref=%s owner=%s %o',
					transactionId, reference.ref, reference.label, error);
			}
		}
	}

	/**
	 * Every reference pin the transaction holds in any store this process knows of, read back from the
	 * labels — the path a settle takes for an entry the offline journal's restore put back after a
	 * restart, since this process never sealed it and so remembers nothing of it.
	 *
	 * A `put` pin met on the way is dropped here rather than listed: `queued` already released the
	 * transaction's puts, so one still present outlived its transaction, and the label is in hand.
	 */
	private async listQueuedReferences(transactionId: string): Promise<HeldReference[]> {
		const prefix = transactionPinPrefix(transactionId);
		const references: HeldReference[] = [];
		for (const backend of await this.deps.knownBackends()) {
			try {
				for await (const { ref, owner } of backend.service.listPins(prefix)) {
					const parsed = parsePinLabel(owner);
					if (parsed?.kind === 'reference') {
						references.push({ backend, ref, scope: parsed.scope, label: owner });
					} else if (parsed?.kind === 'put') {
						await this.unpinOrLog(backend, ref, owner);
					}
				}
			} catch (error) {
				log('blob:pin-listing-failed transaction=%s key=%s %o', transactionId, backend.key, error);
			}
		}
		return references;
	}

	/** One settling reference: announced and released, released outright, or kept and logged. */
	private async settleQueuedReference(transactionId: string, reference: HeldReference, committed: 'all' | ReadonlySet<string>): Promise<void> {
		const { backend, ref, scope, label } = reference;
		if (committed !== 'all' && !committed.has(scope)) {
			// The transaction failed, was discarded, or committed only its other half: nothing holds
			// this reference, so the bytes go with the writer's next piece sweep.
			log('blob:pin-released transaction=%s ref=%s scope=%s reason=scope-not-committed', transactionId, ref, scope);
			await this.unpinOrLog(backend, ref, label);
			return;
		}
		const state = await this.scopeState(backend, scope);
		if (state === 'unknown') {
			// NOTE: nothing in this part retries a kept pin — `feat-blob-pins-reconcile-after-a-restart`
			// is what does, so a kept pin is a deferral and not a leak.
			log('blob:pin-kept transaction=%s ref=%s scope=%s reason=scope-unregistered', transactionId, ref, scope);
			return;
		}
		if (state === 'registered') {
			try {
				await backend.service.announce(ref, scope);
			} catch (error) {
				log('blob:pin-kept transaction=%s ref=%s scope=%s reason=announce-failed %o', transactionId, ref, scope, error);
				return;
			}
			log('blob:announced transaction=%s ref=%s scope=%s', transactionId, ref, scope);
		} else {
			log('blob:pin-released transaction=%s ref=%s scope=%s reason=scope-dropped', transactionId, ref, scope);
		}
		await this.unpinOrLog(backend, ref, label);
	}

	/**
	 * Whether `scope` may be announced into. Announcing into a reference tree the network's registry
	 * does not list tells the cohort to hold bytes no storage node will ever find referenced, so the
	 * check comes before every announcement.
	 *
	 * Which check depends on whether a table here still backs the scope: one that does registers it
	 * as an online commit does, and one that does not is only READ — registering a tree whose table
	 * has been dropped would re-register it and keep its blobs for ever.
	 */
	private async scopeState(backend: BlobBackend, scope: BlobScope): Promise<ScopeState> {
		// `BlobBackend extends NetworkBinding`, so the backend IS the network the registry is read
		// and written through.
		if ((this.deps.tablesOf(scope)?.size ?? 0) > 0) {
			return (await this.deps.registration.ensure(backend, scope)).registered ? 'registered' : 'unknown';
		}
		const listed = await this.deps.registration.isRegistered(backend, scope);
		if (listed === undefined) return 'unknown';
		return listed ? 'registered' : 'dropped';
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
