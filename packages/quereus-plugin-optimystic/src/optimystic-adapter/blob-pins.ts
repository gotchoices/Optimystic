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
 * longer than the `unstaged` holding period — and {@link SqlBlobPins.sweepUnstaged} closes that by
 * never expiring an `unstaged` pin whose reference an open or queued transaction has staged.
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
 *
 * And what the process never got to do, {@link SqlBlobPins.reconcile} finishes. A pin written when a
 * commit started and never released — because the process stopped in between, or because an arm KEPT
 * it deliberately (`blob:pin-kept`) when its scope could not be confirmed or its announcement failed
 * — is judged from COMMITTED STATE: the reference tree the pin's own label names either lists the
 * reference or it does not. That is the whole of the durable bookkeeping; nothing is read from the
 * offline journal, and nothing has to be remembered across the restart.
 *
 * The one pin no transaction answers for is the `unstaged` pin of a put made OUTSIDE any transaction
 * and then never referenced — the upload the user cancelled, the statement that failed, the process
 * that stopped. {@link SqlBlobPins.sweepUnstaged} bounds those by a holding period
 * (`blob_unstaged_holding_ms`, 24 hours by default), and is the one arm here that runs on a timer
 * rather than off a transaction's exit.
 */

import { BlobReferenceTree, unrefTimer } from '@optimystic/db-core';
import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { BlobBackend } from './collection-factory.js';
import type { BlobScopeRegistration } from './blob-scope-registration.js';
import {
	TRANSACTION_PIN_PREFIX,
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

/** How long an unreferenced `unstaged` pin is kept when the registration declares nothing: 24 hours,
 * the period docs/blobs.md §SQL names. */
export const DEFAULT_UNSTAGED_HOLDING_MS = 86_400_000;

/**
 * The registration's `blob_unstaged_holding_ms`, or {@link DEFAULT_UNSTAGED_HOLDING_MS} when unset
 * (README § Plugin-Level Configuration). Read in `register`, as `cost_profile` is, so a bad value
 * throws before anything is built.
 *
 * `null` and `''` count as unset, as they do for `cost_profile`: a plugin loader's settings form
 * sends an empty field as `''`. Anything else that is not a finite positive number throws, because
 * ignoring it would silently keep every unreferenced put for a day when the host asked for a
 * minute, or expire bytes it meant to hold.
 */
export function parseUnstagedHoldingMs(config: Readonly<Record<string, unknown>>): number {
	const declared = config['blob_unstaged_holding_ms'];
	if (declared === undefined || declared === null || declared === '') return DEFAULT_UNSTAGED_HOLDING_MS;
	if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
		throw new Error(`blob_unstaged_holding_ms must be a finite, positive number of milliseconds; got ${typeof declared} ${String(declared)}`);
	}
	return declared;
}

/**
 * How often {@link SqlBlobPins.sweepUnstaged} runs for a given holding period: a quarter of it,
 * never more than an hour and never less than a minute. The floor is what keeps a host that
 * configures a one-second holding period — a test, a tool — from arming a 250 ms interval.
 */
function unstagedSweepPeriodMs(holdingMs: number): number {
	return Math.max(60_000, Math.min(holdingMs / 4, 3_600_000));
}

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
	/** True for a transaction {@link SqlBlobPins.reconcile} must not judge yet: the bridge's active
	 * transaction, or one the offline controller still holds — queued, being submitted, partially
	 * committed, or journaled and not yet put back (`OfflineMode.holdsTransaction`). */
	isLive(transactionId: string): boolean;
	/** False until it is safe to read a transaction's absence from the queue as "settled": with an
	 * offline journal, until a restore pass has completed in this process; true with no journal
	 * (`OfflineMode.reconcileReady`). */
	reconcileReady(): boolean;
	/** `TransactionBridge.openBlobReferences`: the references the OPEN transaction's ledger leaves
	 * added, which no sweep may expire ({@link SqlBlobPins.sweepUnstaged}). Synchronous, because the
	 * sweep asks it per pin it is about to drop rather than once per pass. */
	openReferences(): ReadonlySet<BlobRef>;
	/** The clock the `unstaged` holding period is measured on; `Date.now` from `register`, and a
	 * spec's own where a spec drives {@link SqlBlobPins.sweepUnstaged} by hand. */
	now(): number;
	/** How long an `unstaged` pin is kept before a sweep may expire it: the registration's
	 * `blob_unstaged_holding_ms` ({@link parseUnstagedHoldingMs}). */
	unstagedHoldingMs: number;
}

/** One transaction pin a reconciliation pass found, with what its label named: a `scope` for a
 * reference pin, none for a `put` pin. */
interface FoundPin {
	readonly transactionId: string;
	readonly ref: BlobRef;
	readonly label: string;
	readonly scope?: BlobScope;
}

/** A pin whose label named a scope, so it is a reference pin. */
type ReferencePin = FoundPin & { readonly scope: BlobScope };

/** One `unstaged` pin a sweep found past its holding period, with the time its label named. */
interface ExpiringUnstagedPin {
	readonly ref: BlobRef;
	readonly owner: string;
	readonly putAtMs: number;
}

/** The pins of one backend a pass has to settle, with every live transaction's already dropped. */
interface StalePins {
	/** Reference pins grouped by scope: one committed read answers a whole group. */
	readonly byScope: Map<BlobScope, ReferencePin[]>;
	/** `put` pins, which outlive their transaction only when nothing references their bytes. */
	readonly puts: FoundPin[];
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
	/** {@link settleQueued}'s and {@link reconcile}'s work, one step at a time; never rejects
	 * ({@link chained}). */
	private chain: Promise<void> = Promise.resolve();
	/**
	 * Whether this process may be holding a transaction pin nothing is going to release on its own —
	 * what makes {@link reconcile} free on the triggers that fire often.
	 *
	 * `true` to begin with (a fresh process has never looked), `true` again whenever a backend this
	 * process had not looked at resolves ({@link backendResolved}) and whenever ANY arm keeps a pin it
	 * could not release, and `false` only at the start of a pass that then goes on to look at every
	 * known backend. Clearing it at the START rather than at the end is deliberate: a backend that
	 * resolves while the pass runs — including one the pass's own {@link SqlBlobPinsDeps.knownBackends}
	 * resolved — then leaves it set, and the next trigger looks again rather than the pass having to
	 * reason about what appeared behind it. That costs one extra, empty pass per process and is why
	 * {@link reconcile} coalesces.
	 */
	private mayHoldStalePins = true;
	/** The reconciliation chained and not yet started; a request before it starts gets the same one
	 * (`OfflineRestore.run`'s `pendingPass` precedent). */
	private pendingReconcile: Promise<void> | undefined;
	/** The one interval behind {@link sweepUnstaged}, armed by the first backend to resolve
	 * ({@link backendResolved}) and cleared by {@link dispose}. One per `SqlBlobPins`, however many
	 * backends resolve, since each sweep walks every known backend. */
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Every `unstaged` label whose time this build could not read, so a stuck one is logged once
	 * rather than on every sweep. Bounded by the number of such labels on the machine, which is zero
	 * in a store only this build has written.
	 */
	private readonly unreadableUnstaged = new Set<string>();
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
	 * bytes stay here and {@link reconcile} retries the release.
	 */
	async committed(held: HeldPins | undefined, transaction: TransactionState, committed: 'all' | ReadonlySet<string>): Promise<void> {
		const landed: HeldReference[] = [];
		for (const reference of held?.references ?? []) {
			if (committed !== 'all' && !committed.has(reference.scope)) {
				log('blob:pin-kept transaction=%s ref=%s scope=%s reason=scope-not-committed',
					transaction.stampId, reference.ref, reference.scope);
				this.mayHoldStalePins = true;
				continue;
			}
			landed.push(reference);
			if (!await this.announceAndRelease(transaction, reference)) this.mayHoldStalePins = true;
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
	 * ({@link sweepUnstaged}). The bytes are kept either way.
	 */
	settleQueued(transactionId: string, committed: 'all' | ReadonlySet<string>): Promise<void> {
		return this.chained(() => this.releaseQueued(transactionId, committed));
	}

	/**
	 * Settle every transaction pin whose transaction is not live, from COMMITTED STATE: the reference
	 * tree each pin's own label names either lists the reference or it does not. This is what finishes
	 * a pin the process stopped in the middle of — written when a commit started and left behind by a
	 * crash before the send, after the send, or while a queued entry had no journal to restore it —
	 * and what retries a pin an arm kept deliberately (`blob:pin-kept`) because its scope could not be
	 * confirmed or its announcement failed. Never throws.
	 *
	 * A no-op until {@link SqlBlobPinsDeps.reconcileReady}, and a no-op whenever nothing may be stale
	 * ({@link mayHoldStalePins}) — which is the steady state, and is what lets a reachability wake
	 * trigger this. Triggered after `OfflineMode.restore()` (which awaits it, so a restart's
	 * reconciliation is observable), on every reachability wake, and when a backend first resolves in
	 * this process ({@link backendResolved}).
	 *
	 * Chained like {@link settleQueued}, so a settle and a reconciliation never handle one
	 * transaction's pins at once; a request made while a pass is chained and not yet started joins
	 * that pass, and one made while a pass is RUNNING is chained behind it, since a running pass may
	 * already have listed.
	 *
	 * NOTE: a pass lists every transaction pin on each backend and reads one reference tree per scope
	 * that has one. The flag above is what keeps that off the frequent triggers; if a machine ever
	 * keeps many pins across many wakes, remember the uncertain scopes and retry only those.
	 *
	 * NOTE: a pass can overlap the TAIL of an online commit — between the bridge's `endTransaction()`
	 * and its off-chain {@link committed}, the transaction is no longer live and its pins are still
	 * there, so a pass can announce and unpin them first. That reads like a bug and is not: by then
	 * the commit is durable, so committed state says the same thing to both, and both steps are
	 * idempotent — a second announce finds the stored durability and a second unpin finds no pin.
	 */
	reconcile(): Promise<void> {
		if (!this.mayHoldStalePins || !this.deps.reconcileReady()) return Promise.resolve();
		if (this.pendingReconcile !== undefined) return this.pendingReconcile;
		const pass = this.chained(() => {
			this.pendingReconcile = undefined;
			return this.reconcilePass();
		});
		this.pendingReconcile = pass;
		return pass;
	}

	/**
	 * A blob backend resolved in this process — a store this process has not looked at, which may hold
	 * a pin a previous one left. Subscribed through `CollectionFactory.onBlobBackendResolved`, which
	 * replays the backends already resolved and then reports each new one exactly once.
	 *
	 * The backend itself is not remembered: a pass walks every KNOWN backend, so one that has just
	 * resolved is in that walk by definition, and a per-backend pass would have to be chained anyway.
	 */
	backendResolved(_backend: BlobBackend): void {
		this.mayHoldStalePins = true;
		void this.reconcile();
		this.startUnstagedSweep();
	}

	/**
	 * Unpin every `unstaged` pin older than the holding period, except on a reference some live
	 * transaction is relying on — the holding period docs/blobs.md §SQL promises for a blob put
	 * outside any transaction and never referenced. Never throws.
	 *
	 * `now` is the moment the period is measured against; it defaults to the deps' clock, read when
	 * the pass actually runs rather than when this is called, and a spec passes its own.
	 *
	 * Chained like {@link settleQueued} and {@link reconcile}, so a sweep never runs beside a
	 * settlement or a reconciliation — the three read and write the same pins — and so it waits for
	 * any open transaction to end before it looks. Armed on a timer by {@link backendResolved}.
	 *
	 * NOTE: that wait is for the transaction open when the step STARTS, and says nothing about the
	 * next one, so a pass can run beside a statement that begins behind it. That is what
	 * {@link SqlBlobPinsDeps.openReferences} is asked per expiring pin for; what is left unguarded is
	 * the instant between that read and the `unpin`. If a host is ever seen losing the bytes of a
	 * blob it referenced within the holding period, pin the reference when the statement stages it
	 * rather than when the commit starts — which needs the vtab's `update()` path to be able to
	 * reach the blob service, and it deliberately cannot (docs/blobs.md §Registering references).
	 */
	sweepUnstaged(now?: number): Promise<void> {
		return this.chained(() => this.sweepUnstagedPass(now ?? this.deps.now()));
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
		// Before the await, so a host that disposes while a sweep is chained does not then wait for an
		// interval it has already stopped caring about; the chained step itself bails at `disposed`.
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
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
				this.mayHoldStalePins = true;
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
		if (!await this.releaseLanded(transactionId, reference)) this.mayHoldStalePins = true;
	}

	/**
	 * One reference whose row is known to have landed: announced into its scope and then released, in
	 * that order; released without announcing when its scope is CERTAINLY not in the network's registry
	 * (the table was dropped, here or elsewhere); kept and logged otherwise. `false` when the pin was
	 * kept, which is what leaves {@link mayHoldStalePins} set so a later trigger tries again.
	 *
	 * Shared by {@link settleQueued} and {@link reconcile}, which differ only in how they establish
	 * that the row landed: the queue's terminal status for one, a committed read of the reference tree
	 * for the other.
	 */
	private async releaseLanded(transactionId: string, reference: HeldReference): Promise<boolean> {
		const { backend, ref, scope, label } = reference;
		const state = await this.scopeState(backend, scope);
		if (state === 'unknown') {
			log('blob:pin-kept transaction=%s ref=%s scope=%s reason=scope-unregistered', transactionId, ref, scope);
			return false;
		}
		if (state === 'registered') {
			try {
				await backend.service.announce(ref, scope);
			} catch (error) {
				log('blob:pin-kept transaction=%s ref=%s scope=%s reason=announce-failed %o', transactionId, ref, scope, error);
				return false;
			}
			log('blob:announced transaction=%s ref=%s scope=%s', transactionId, ref, scope);
		} else {
			log('blob:pin-released transaction=%s ref=%s scope=%s reason=scope-dropped', transactionId, ref, scope);
		}
		await this.unpinOrLog(backend, ref, label);
		return true;
	}

	// ── reconciliation from committed state ──────────────────────────────────

	/**
	 * One reconciliation pass: every backend this process knows of, in turn.
	 *
	 * NOTE: a backend whose store cannot be resolved is logged and left OUT of the walk
	 * (`CollectionFactory.knownBlobBackends`), and this pass cannot tell it was skipped, so it clears
	 * {@link mayHoldStalePins} without having looked there. The pins stay — which is the safe
	 * direction — and a resolution is not remembered, so the next successful one announces the backend
	 * and re-arms the flag ({@link backendResolved}). If a network whose blob store can never be
	 * resolved is ever seen holding pins for ever, have `knownBlobBackends` report the skip and leave
	 * the flag set for it.
	 */
	private async reconcilePass(): Promise<void> {
		// Re-checked here as well as at the request, since a pass chained behind a running one may find
		// that the running one has already answered for everything.
		if (!this.mayHoldStalePins) return;
		this.mayHoldStalePins = false;
		try {
			for (const backend of await this.deps.knownBackends()) {
				await this.reconcileBackend(backend);
			}
		} catch (error) {
			this.mayHoldStalePins = true;
			throw error;
		}
	}

	/**
	 * One backend's transaction pins: the `put` pins of settled transactions released outright, and
	 * their reference pins judged one scope at a time. Each scope is isolated, so one unreadable
	 * reference tree does not hide the rest.
	 */
	private async reconcileBackend(backend: BlobBackend): Promise<void> {
		let stale: StalePins;
		try {
			stale = await this.listStalePins(backend);
		} catch (error) {
			this.mayHoldStalePins = true;
			log('blob:pin-listing-failed key=%s reason=reconcile %o', backend.key, error);
			return;
		}
		// A `put` pin outlives its transaction only when the put resolved after the transaction ended
		// (`SqlBlobService.put` fixes the label when the put STARTS), and such bytes are referenced by
		// nothing: no row of that transaction can name a reference the transaction did not have.
		for (const { transactionId, ref, label } of stale.puts) {
			log('blob:pin-released transaction=%s ref=%s reason=put-outlived-transaction', transactionId, ref);
			await this.unpinOrLog(backend, ref, label);
		}
		for (const [scope, references] of stale.byScope) {
			try {
				await this.reconcileScope(backend, scope, references);
			} catch (error) {
				this.mayHoldStalePins = true;
				log('blob:pin-settle-failed key=%s scope=%s %o', backend.key, scope, error);
			}
		}
	}

	/**
	 * Every transaction pin on `backend`, with the pins of every LIVE transaction dropped: the bridge's
	 * open transaction, and whatever the offline queue or the journal's restore still holds.
	 *
	 * Grouped by transaction first, so `isLive` is asked once per transaction rather than once per pin,
	 * and the reference pins then regrouped by scope, so one committed read answers a whole scope. A
	 * label that does not parse is skipped and never released: it carries this plugin's prefix but not
	 * one of its shapes, so releasing it would drop somebody else's hold ({@link parsePinLabel}).
	 */
	private async listStalePins(backend: BlobBackend): Promise<StalePins> {
		const byTransaction = new Map<string, FoundPin[]>();
		for await (const { ref, owner } of backend.service.listPins(TRANSACTION_PIN_PREFIX)) {
			const parsed = parsePinLabel(owner);
			if (parsed === undefined || parsed.kind === 'unstaged') continue;
			const pin: FoundPin = {
				transactionId: parsed.stampId,
				ref,
				label: owner,
				...(parsed.kind === 'reference' ? { scope: parsed.scope } : {}),
			};
			const pins = byTransaction.get(parsed.stampId);
			if (pins === undefined) byTransaction.set(parsed.stampId, [pin]); else pins.push(pin);
		}
		const stale: StalePins = { byScope: new Map(), puts: [] };
		for (const [transactionId, pins] of byTransaction) {
			if (this.deps.isLive(transactionId)) continue;
			for (const pin of pins) {
				const scope = pin.scope;
				if (scope === undefined) {
					stale.puts.push(pin);
					continue;
				}
				const group = stale.byScope.get(scope);
				if (group === undefined) stale.byScope.set(scope, [{ ...pin, scope }]); else group.push({ ...pin, scope });
			}
		}
		return stale;
	}

	/**
	 * One scope's settled reference pins, judged by ONE committed read of its reference tree: a
	 * reference the tree lists is announced and released, one it certainly does not list is released
	 * outright — the transaction never committed it, or a later transaction removed it, and a removed
	 * reference is not the writer's to keep — and an UNCERTAIN read keeps every pin of the scope for a
	 * later trigger to try again.
	 */
	private async reconcileScope(backend: BlobBackend, scope: BlobScope, references: readonly ReferencePin[]): Promise<void> {
		const listing = await BlobReferenceTree.listed(backend.transactor, scope, references.map(reference => reference.ref));
		if (!listing.certain) {
			this.mayHoldStalePins = true;
			log('blob:reconcile-uncertain scope=%s refs=%d', scope, references.length);
			return;
		}
		for (const { transactionId, ref, label } of references) {
			try {
				if (listing.listed.has(ref)) {
					if (!await this.releaseLanded(transactionId, { backend, ref, scope, label })) this.mayHoldStalePins = true;
				} else {
					log('blob:pin-released transaction=%s ref=%s scope=%s reason=not-listed', transactionId, ref, scope);
					await this.unpinOrLog(backend, ref, label);
				}
			} catch (error) {
				this.mayHoldStalePins = true;
				log('blob:pin-settle-failed transaction=%s ref=%s scope=%s %o', transactionId, ref, scope, error);
			}
		}
	}

	// ── the `unstaged` holding period ────────────────────────────────────────

	/**
	 * Arm the sweep: one pass now, for the backend that has just resolved, and the interval if it is
	 * not already running. Called once per backend resolution, and the pass walks every KNOWN
	 * backend, so a second resolution needs no second timer.
	 */
	private startUnstagedSweep(): void {
		if (this.disposed) return;
		void this.sweepUnstaged();
		if (this.sweepTimer !== undefined) return;
		this.sweepTimer = unrefTimer(setInterval(
			() => { void this.sweepUnstaged(); },
			unstagedSweepPeriodMs(this.deps.unstagedHoldingMs),
		));
	}

	/** One sweep: every backend this process knows of, each isolated from the others. */
	private async sweepUnstagedPass(now: number): Promise<void> {
		for (const backend of await this.deps.knownBackends()) {
			try {
				await this.sweepBackendUnstaged(backend, now);
			} catch (error) {
				log('blob:pin-listing-failed key=%s reason=sweep-unstaged %o', backend.key, error);
			}
		}
	}

	/**
	 * One backend's `unstaged` pins: each one past its holding period released, unless an unfinished
	 * transaction is relying on its reference ({@link livePinnedReferences} and
	 * {@link SqlBlobPinsDeps.openReferences}). Each release is isolated, so one store fault does not
	 * hide the rest of the sweep.
	 *
	 * A label whose time this build cannot read is LEFT PINNED, for ever, and logged once: it was
	 * written by a build that knows something this one does not, or it is corrupt, and releasing a
	 * pin whose meaning is unknown drops somebody's bytes.
	 *
	 * A `putAtMs` in the FUTURE — the machine's clock was moved back — simply expires nothing until
	 * the clock catches up. The holding period is measured on this machine's own clock, the same
	 * limit docs/blobs.md §Lifetime already states for the reclaim pass.
	 */
	private async sweepBackendUnstaged(backend: BlobBackend, now: number): Promise<void> {
		const expiring = await this.listExpiringUnstaged(backend, now);
		if (expiring.length === 0) return;
		// Listed only now that something is actually expiring, so a sweep that finds nothing past its
		// period — the steady state — pays ONE listing of the machine's blob records rather than two.
		const pinnedLive = await this.livePinnedReferences(backend);
		for (const { ref, owner, putAtMs } of expiring) {
			// The open transaction's ledger is asked here, per pin, rather than folded into `pinnedLive`:
			// a statement can begin while this pass is running, and a reference it stages has no pin of
			// its own until its commit starts, so a set built before the listing would miss it and this
			// sweep would drop the bytes that commit is about to reference.
			if (pinnedLive.has(ref) || this.deps.openReferences().has(ref)) continue;
			try {
				await backend.service.unpin(ref, owner);
				log('blob:unstaged-expired ref=%s putAt=%d', ref, putAtMs);
			} catch (error) {
				// Unlike a transaction pin's release, this leaves nothing owed: the next sweep finds the
				// pin again and is just as able to drop it, so `mayHoldStalePins` is not touched.
				log('blob:pin-release-failed ref=%s owner=%s %o', ref, owner, error);
			}
		}
	}

	/**
	 * Every `unstaged` pin on `backend` whose holding period has passed at `now`, collected before
	 * anything is released — as {@link listStalePins} collects, and for the same reason: a store's
	 * listing is not something to be written through while it is still being read.
	 *
	 * NOTE: that listing reads every blob record on the machine (the `NOTE:` at
	 * `LocalBlobService.listPins`), and unlike {@link reconcile} a sweep has no flag that can tell it
	 * the walk is pointless — any put could have aged past the period since the last one. At one pass
	 * an hour that is a bounded cost; if a machine holding very many blobs is ever seen paying for it,
	 * keep the earliest `putAtMs` a pass saw still inside the period and skip the next pass until then.
	 */
	private async listExpiringUnstaged(backend: BlobBackend, now: number): Promise<ExpiringUnstagedPin[]> {
		const expiring: ExpiringUnstagedPin[] = [];
		for await (const { ref, owner } of backend.service.listPins(UNSTAGED_PIN_PREFIX)) {
			const parsed = parsePinLabel(owner);
			if (parsed?.kind !== 'unstaged') {
				if (!this.unreadableUnstaged.has(owner)) {
					this.unreadableUnstaged.add(owner);
					log('blob:unstaged-unreadable ref=%s owner=%s', ref, owner);
				}
				continue;
			}
			if (parsed.putAtMs + this.deps.unstagedHoldingMs <= now) {
				expiring.push({ ref, owner, putAtMs: parsed.putAtMs });
			}
		}
		return expiring;
	}

	/**
	 * The references on `backend` carrying a reference pin whose transaction is still LIVE — the open
	 * SQL transaction once its commit has started, and every QUEUED transaction, whose pins stay in
	 * place until the queue finishes with it ({@link settleQueued}). A sweep must not expire the
	 * `unstaged` pin of such a reference however old it is: an entry waiting in the queue can still
	 * fail with nothing committed, so this machine is the only one holding its bytes.
	 *
	 * Read off the same `listPins(TRANSACTION_PIN_PREFIX)` listing {@link reconcile} makes, and
	 * grouped by nothing: `isLive` is asked once per reference pin rather than once per transaction,
	 * because the set a sweep needs is of references and a transaction holds few pins.
	 */
	private async livePinnedReferences(backend: BlobBackend): Promise<Set<BlobRef>> {
		const references = new Set<BlobRef>();
		for await (const { ref, owner } of backend.service.listPins(TRANSACTION_PIN_PREFIX)) {
			const parsed = parsePinLabel(owner);
			if (parsed?.kind === 'reference' && this.deps.isLive(parsed.stampId)) references.add(ref);
		}
		return references;
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
			// The pin stays, so this process is still holding one nothing else will drop: a later
			// trigger looks again, and for a transaction pin that look is also what releases it.
			this.mayHoldStalePins = true;
			log('blob:pin-release-failed ref=%s owner=%s %o', ref, label, error);
		}
	}
}
