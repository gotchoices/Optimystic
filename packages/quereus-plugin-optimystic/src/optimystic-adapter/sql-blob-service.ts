/**
 * The blob service an application holds: `plugin.blobs` and `plugin.blobsFor(table)`
 * (docs/blobs.md §SQL).
 */

import type {
	BlobDurabilityEvent,
	BlobFetchOptions,
	BlobPathAccess,
	BlobProgressEvent,
	BlobPutOptions,
	BlobPutResult,
	BlobReadOptions,
	BlobRef,
	BlobScope,
	BlobStat,
} from '@optimystic/db-core';
import type { BlobBackend, SqlBlobBackendService } from './collection-factory.js';
import { transactionPutPinLabel, unstagedPinLabel } from './blob-pin-labels.js';
import { addListener, notifyListeners } from './listeners.js';
import type { TransactionBridge } from './txn-bridge.js';
import { createLogger } from '../logger.js';

const log = createLogger('blob');

/**
 * One network's blob store, resolved on first use, with `put`'s owner label defaulted from the
 * bridge's open transaction.
 *
 * Thin by design. The sharing happens in `CollectionFactory.getBlobBackend`, so two of these over
 * one network are NOT reference-equal and yet read the same blob records, hold the same pins, and
 * (each through its own forwarding listener) receive the same progress and durability events. A
 * host should not compare `plugin.blobs` with `plugin.blobsFor(table)` for identity.
 *
 * Resolution is lazy because a host may set the session's `default_vtab_args` after `register`
 * returns, and because resolving the default network of a `network` transactor builds the libp2p
 * node — which must not happen merely because the plugin was registered.
 */
export class SqlBlobService implements SqlBlobBackendService {
	private readonly progressListeners = new Set<(event: BlobProgressEvent) => void>();
	private readonly durabilityListeners = new Set<(event: BlobDurabilityEvent) => void>();
	/** The backend's unsubscribes, held while this has listeners of that kind and the backend resolved. */
	private releaseProgress: (() => void) | undefined;
	private releaseDurability: (() => void) | undefined;
	private backend: BlobBackend | undefined;
	/** A resolution started by {@link startResolving} alone, so a burst of subscriptions starts one. */
	private resolving = false;
	private readonly now: () => number;

	/**
	 * @param resolve The network's backend. Called on each use until one resolves; a resolution that
	 *   fails is not remembered by the factory, so a later call retries.
	 * @param bridge Whose open transaction names the default pin owner of a `put`.
	 */
	constructor(
		private readonly resolve: () => Promise<BlobBackend>,
		private readonly bridge: TransactionBridge,
		now: () => number = Date.now,
	) {
		this.now = now;
	}

	/**
	 * Store a stream as a blob on this network, pinned so it cannot be swept.
	 *
	 * The pin's owner label is the caller's `owner` when it gave one. Otherwise it names the
	 * transaction open when the put STARTS — `sql/<stampId>/put` — and `sql-unstaged/<ms>` when none
	 * is. Decided at the start, not when the put resolves: a put that outlives its transaction keeps
	 * the label it began under.
	 *
	 * Who then releases the pin:
	 *
	 *  - A put labelled for a transaction that is STILL the open one when the put resolves is
	 *    recorded on that transaction, and its pin is released when the transaction settles —
	 *    committed, queued or rolled back alike (`SqlBlobPins`).
	 *  - A put that OUTLIVES its transaction records nothing, and so leaves a stray
	 *    `sql/<stampId>/put` pin that `SqlBlobPins.reconcile` removes.
	 *  - A put the caller gave an explicit `owner` for records nothing either: that pin is the host's
	 *    own to release, through {@link unpin}.
	 *  - A put made outside any transaction keeps its `sql-unstaged/<ms>` pin until a transaction
	 *    that references the blob commits, or the holding period expires.
	 *
	 * **A blob put inside a transaction that the transaction never references loses its bytes when
	 * the transaction ends.** `begin; put(a); put(b); insert … values (a); commit` releases `b`'s pin
	 * and the sweep takes its pieces. That is the design — a put inside a transaction is pinned under
	 * that transaction's identity (docs/blobs.md §SQL) — so to keep a blob no row references, put it
	 * outside any transaction or pass an explicit `owner`.
	 */
	async put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult> {
		return await this.pinnedPut(
			options?.owner,
			() => this.backendNow(),
			(backend, owner) => backend.service.put(source, { ...options, owner }),
		);
	}

	/**
	 * Putting and reading a blob BY FILE PATH on this network, under this service's pin rules, or
	 * `undefined` when this network's backend offers no path access — which is the case in every
	 * browser, on any backend whose piece store cannot reach files, and on every node that left the
	 * `blobs.paths` setting at its default `'off'` (docs/blobs.md §Putting and reading by file path).
	 *
	 * A method rather than the `BlobService.paths` PROPERTY, which this service therefore never
	 * sets: the backend is resolved asynchronously ({@link backendNow}), so nothing here can answer
	 * synchronously whether path access exists, and a property that was present-but-throwing would
	 * break the one thing its contract promises — present exactly when available. A host asks
	 * `await plugin.blobs.pathAccess()` once and gets the same two answers the property gives.
	 *
	 * `putFile` is {@link put} by another route: the same default owner, chosen when the put starts,
	 * and the same recording on the transaction that defaulted it, because both go through one
	 * method and so cannot drift. `readToFile` reads and is the backend's own — a read pins nothing.
	 *
	 * The backend is captured ONCE, as this resolves, and the returned object uses that one for both
	 * forms and for the key a recorded put is noted under. The factory hands this service a
	 * different backend only across a `CollectionFactory.dispose()` ({@link adoptBackend}); an
	 * object taken before that goes on writing into the store it was taken over, which is the
	 * host's to notice — take a fresh one after disposing.
	 */
	async pathAccess(): Promise<BlobPathAccess | undefined> {
		const backend = await this.backendNow();
		const paths = backend.service.paths;
		if (paths === undefined) return undefined;
		return {
			mode: paths.mode,
			putFile: (path, options) => this.pinnedPut(
				options?.owner,
				async () => backend,
				(_, owner) => paths.putFile(path, { ...options, owner }),
			),
			readToFile: (ref, path, options) => paths.readToFile(ref, path, options),
		};
	}

	/** What THIS machine knows about a blob; `probe` asks the blob's cohort, on a network backend. */
	async stat(ref: BlobRef, options?: { probe?: boolean }): Promise<BlobStat> {
		const { service } = await this.backendNow();
		return await service.stat(ref, options);
	}

	/** The bytes, or a range of them, in order; fetches what is not here unless told not to. */
	async *read(ref: BlobRef, options?: BlobReadOptions): AsyncIterable<Uint8Array> {
		const { service } = await this.backendNow();
		yield* service.read(ref, options);
	}

	/** Bring the whole blob here ahead of a read. */
	async fetch(ref: BlobRef, options?: BlobFetchOptions): Promise<void> {
		const { service } = await this.backendNow();
		await service.fetch(ref, options);
	}

	async pin(ref: BlobRef, owner: string): Promise<void> {
		const { service } = await this.backendNow();
		await service.pin(ref, owner);
	}

	async unpin(ref: BlobRef, owner: string): Promise<void> {
		const { service } = await this.backendNow();
		await service.unpin(ref, owner);
	}

	/** Tell the blob's cohort that committed state now references it, and where. On a single-machine
	 * backend there is no cohort to tell: the blob is kept here and its durability recorded `local`. */
	async announce(ref: BlobRef, scope: BlobScope): Promise<void> {
		const { service } = await this.backendNow();
		await service.announce(ref, scope);
	}

	/** The owner labels pinned on `ref` IN THIS MACHINE's blob records, not the network's; `[]` when
	 * this machine holds no readable record for it. This plugin's labels are built and read in
	 * `blob-pin-labels.ts`. */
	async pinsOf(ref: BlobRef): Promise<string[]> {
		const { service } = await this.backendNow();
		return await service.pinsOf(ref);
	}

	/** Every (reference, owner) pin in THIS MACHINE's blob records whose owner label starts with
	 * `ownerPrefix`, in no promised order. */
	async *listPins(ownerPrefix: string): AsyncIterable<{ ref: BlobRef; owner: string }> {
		const { service } = await this.backendNow();
		yield* service.listPins(ownerPrefix);
	}

	/**
	 * Fetch progress for one reference. The first subscription starts resolving the backend; a
	 * listener subscribed before it resolves still hears everything after it, and an unsubscribe
	 * before it resolves leaves nothing attached. Idempotent unsubscribe.
	 */
	onProgress(listener: (event: BlobProgressEvent) => void): () => void {
		const unsubscribe = addListener(this.progressListeners, listener);
		this.attachProgress();
		return () => {
			unsubscribe();
			if (this.progressListeners.size === 0) {
				this.releaseProgress?.();
				this.releaseProgress = undefined;
			}
		};
	}

	/** A blob's durability class, as it is first recorded and as it changes. Same discipline as
	 * {@link onProgress}. */
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void {
		const unsubscribe = addListener(this.durabilityListeners, listener);
		this.attachDurability();
		return () => {
			unsubscribe();
			if (this.durabilityListeners.size === 0) {
				this.releaseDurability?.();
				this.releaseDurability = undefined;
			}
		};
	}

	/**
	 * The pin rules of every put this service makes, which {@link put} documents in full, around
	 * whichever backend call stores the bytes. One method so a stream put and a path put cannot
	 * drift, and the order within it is load-bearing twice over: the label is chosen BEFORE anything
	 * is awaited, so it names the transaction open when the put STARTED rather than whichever one is
	 * open once the backend has resolved, and the recording happens after the bytes are down, when
	 * that transaction may no longer be the open one.
	 *
	 * @param explicitOwner The caller's own `owner`, when it gave one: that pin is the host's to
	 *   release, so nothing is defaulted and nothing is recorded on any transaction.
	 * @param backendOf The backend whose key a recorded put is noted under. A function, and called
	 *   only after the label is chosen, because resolving it may await — see above. It must name the
	 *   backend `store` actually writes into: the key is what `SqlBlobPins` reopens the store through
	 *   to release the pin, so one naming another network's store would release nothing.
	 * @param store Stores the bytes, under the owner label this chose.
	 */
	private async pinnedPut(
		explicitOwner: string | undefined,
		backendOf: () => Promise<BlobBackend>,
		store: (backend: BlobBackend, owner: string) => Promise<BlobPutResult>,
	): Promise<BlobPutResult> {
		// Only a put whose label THIS defaulted to a transaction is that transaction's to release.
		const defaulted = explicitOwner === undefined ? this.defaultPinOwner() : undefined;
		const owner = explicitOwner ?? defaulted!.label;
		const backend = await backendOf();
		const result = await store(backend, owner);
		const open = this.bridge.getCurrentTransaction();
		if (defaulted?.transactionId !== undefined
			&& open?.isActive === true && open.stampId === defaulted.transactionId) {
			this.bridge.noteBlobPut(backend.key, result.ref);
		}
		return result;
	}

	/**
	 * The transaction open NOW names the pin; see {@link put}. Answers the `transactionId` beside the
	 * label, because the put is that transaction's to release only while it is still the open one —
	 * and only the label says nothing about which transaction it named.
	 */
	private defaultPinOwner(): { readonly label: string; readonly transactionId?: string } {
		const current = this.bridge.getCurrentTransaction();
		return current?.isActive === true
			? { label: transactionPutPinLabel(current.stampId), transactionId: current.stampId }
			: { label: unstagedPinLabel(this.now()) };
	}

	/**
	 * The backend, resolved afresh on EVERY use rather than remembered: that is what makes a service
	 * used after `CollectionFactory.dispose()` reach the store the factory built next instead of the
	 * one it stopped (see {@link adoptBackend}).
	 *
	 * NOTE: so each call pays one binding derivation and one map lookup — which for `BlobLocality`
	 * and `BlobSize` is per ROW of the query, since both read `plugin.blobs`. Nothing touches
	 * storage, and the factory's own de-duplication means no second store is ever built; if a
	 * `select BlobLocality(...)` over many rows ever shows up as slow, cache the resolved backend
	 * behind a disposal generation the factory bumps, rather than simply remembering it here.
	 */
	private async backendNow(): Promise<BlobBackend> {
		const backend = await this.resolve();
		this.adoptBackend(backend);
		return backend;
	}

	/**
	 * Take the resolved backend and attach whichever forwarders have listeners waiting. Called on
	 * every resolution: re-adopting the same object changes nothing, since the backend of one
	 * network is one object for as long as it lives.
	 *
	 * A DIFFERENT object means the factory was disposed and built this network a fresh store
	 * (`CollectionFactory.dispose` forgets its backends and stops the services it built), so the
	 * forwarders move with it — otherwise this service's listeners would stay subscribed to a
	 * stopped service and hear nothing again.
	 */
	private adoptBackend(backend: BlobBackend): void {
		if (this.backend !== backend) {
			this.releaseProgress?.();
			this.releaseProgress = undefined;
			this.releaseDurability?.();
			this.releaseDurability = undefined;
			this.backend = backend;
		}
		this.attachProgress();
		this.attachDurability();
	}

	private attachProgress(): void {
		if (this.releaseProgress !== undefined || this.progressListeners.size === 0) return;
		const backend = this.backend;
		if (backend === undefined) {
			this.startResolving();
			return;
		}
		this.releaseProgress = backend.service.onProgress(event => {
			notifyListeners(this.progressListeners, event, error => log('blob:progress-listener-threw %o', error));
		});
	}

	private attachDurability(): void {
		if (this.releaseDurability !== undefined || this.durabilityListeners.size === 0) return;
		const backend = this.backend;
		if (backend === undefined) {
			this.startResolving();
			return;
		}
		this.releaseDurability = backend.service.onDurability(event => {
			notifyListeners(this.durabilityListeners, event, error => log('blob:durability-listener-threw %o', error));
		});
	}

	/**
	 * Resolve the backend for its events alone, so a listener subscribed before anything else
	 * touched this network still hears what happens on it. A failure is logged and nothing is
	 * remembered: the listener stays in its set, {@link resolving} is cleared, and the next
	 * subscription (or any other use of this service) tries again.
	 */
	private startResolving(): void {
		if (this.resolving) return;
		this.resolving = true;
		void this.backendNow()
			.catch(error => log('blob:backend-resolution-failed %o', error))
			.finally(() => { this.resolving = false; });
	}
}
