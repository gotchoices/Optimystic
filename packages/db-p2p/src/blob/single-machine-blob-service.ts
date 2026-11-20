/**
 * A `BlobService` for a host with no libp2p node (docs/blobs.md §The node's blob service).
 *
 * Imports here are pure or type-only, as `node-blob-service.ts`'s are: this module is reachable from
 * the react-native entry (`src/rn.ts`).
 */

import type {
	BlobDigest,
	BlobDurability,
	BlobDurabilityEvent,
	BlobFetchOptions,
	BlobProgressEvent,
	BlobPutOptions,
	BlobPutResult,
	BlobReadOptions,
	BlobRef,
	BlobScope,
	BlobService,
	BlobStat,
} from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import type { IKVStore } from '../storage/i-kv-store.js';
import { blobScopeProblem } from './blob-protocol.js';
import { LocalBlobService, type BlobPinIndex } from './local-blob-service.js';
import type { IPieceStore } from './piece-store.js';

const log = createLogger('blob:store');

export interface SingleMachineBlobServiceInit {
	readonly pieces: IPieceStore;
	readonly kv: IKVStore;
	/** Default `defaultBlobDigest()`, as LocalBlobServiceInit's. */
	readonly digest?: BlobDigest;
	readonly now?: () => number;
}

/**
 * A `BlobService` whose cohort is this machine alone: a `LocalBlobService` for everything except
 * `announce`, which keeps the blob under the `owed` hold and reports durability `local` instead of
 * rejecting (docs/blobs.md §SQL). For a host with no libp2p node — the SQL plugin's `local`, `test`
 * and `mesh-test` transactors, and an application holding blobs beside a non-networked database.
 *
 * By composition rather than by subclassing, so it rests only on the public surface of the class it
 * wraps; every member but `announce` is a delegation.
 */
export class SingleMachineBlobService implements BlobService, BlobPinIndex {
	private readonly local: LocalBlobService;

	constructor(init: SingleMachineBlobServiceInit) {
		this.local = new LocalBlobService({ pieces: init.pieces, kv: init.kv, digest: init.digest, now: init.now });
	}

	/** Schedules the start-up sweep (LocalBlobService.start). */
	start(): void {
		this.local.start();
	}

	/** Cancels a scheduled sweep and waits for a running one (LocalBlobService.stop). */
	stop(): Promise<void> {
		return this.local.stop();
	}

	put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.local.put(source, options);
	}

	/** What this machine holds, and the `local` durability `announce` recorded, if any. `probe` has nobody to ask. */
	stat(ref: BlobRef, options?: { probe?: boolean }): Promise<BlobStat> {
		return this.local.stat(ref, options);
	}

	/** This machine's pieces alone; a piece that is not here fails the read, since there is nobody to fetch from. */
	read(ref: BlobRef, options?: BlobReadOptions): AsyncIterable<Uint8Array> {
		return this.local.read(ref, options);
	}

	fetch(ref: BlobRef, options?: BlobFetchOptions): Promise<void> {
		return this.local.fetch(ref, options);
	}

	pin(ref: BlobRef, owner: string): Promise<void> {
		return this.local.pin(ref, owner);
	}

	unpin(ref: BlobRef, owner: string): Promise<void> {
		return this.local.unpin(ref, owner);
	}

	/**
	 * Keeps the blob here for a committed reference in `scope`, rather than telling a cohort: takes the
	 * `owed` hold and, the first time, records and reports durability `local`.
	 *
	 * Nothing here ever releases that hold — there is nobody to copy to — so it is released only by
	 * reclaiming, once `scope` stops listing the reference (docs/blobs.md §Lifetime, *An owed blob
	 * follows the same rule*), exactly as for a networked node whose cohort never fully holds the blob.
	 *
	 * The scope is refused on the same rule the wire applies, so a recorded scope is always one a
	 * networked node could send and a host that moves from this service to a node has nothing to
	 * re-check. Throws RangeError for an empty scope or one over `MAX_BLOB_SCOPE_CHARS`.
	 */
	async announce(ref: BlobRef, scope: BlobScope): Promise<void> {
		const problem = blobScopeProblem(scope);
		if (problem !== undefined) throw new RangeError(`A blob announce has ${problem}`);
		// Creates the record when there is none and flushes, so the blob survives a restart with a hold no sweep removes.
		await this.local.holdOwed(ref);
		if (await this.local.durabilityOf(ref) !== undefined) {
			// A re-announce: the stored class is what keeps a restart from reporting an unchanged class again.
			return;
		}
		// `local` by the order of the rules in `classifyBlobDurability`: "no other member accepts blobs"
		// is decided before any arithmetic, so a cohort of just this machine never reads as a strict
		// majority of itself.
		//
		// NOTE: `confirmed` is computed once and never recomputed — nothing on a single machine can make
		// an incompletely held blob whole, so a reference announced before its bytes arrived stays
		// `confirmed: 0`. A caller that puts a blob and then announces it always records 1.
		const durability: BlobDurability = {
			quorum: 'local',
			confirmed: await this.local.holdsWhole(ref) ? 1 : 0,
			accepting: 1,
			unconfirmed: [],
		};
		// Written before it is reported, so a listener never sees a class the record does not yet hold.
		await this.local.setDurability(ref, durability);
		this.local.emitDurability({ ref, durability });
		log('blob:announce-single-machine ref=%s scope=%s', ref, scope);
	}

	/** {@link BlobPinIndex.pinsOf}. */
	pinsOf(ref: BlobRef): Promise<string[]> {
		return this.local.pinsOf(ref);
	}

	/** {@link BlobPinIndex.listPins}. */
	listPins(ownerPrefix: string): AsyncIterable<{ ref: BlobRef; owner: string }> {
		return this.local.listPins(ownerPrefix);
	}

	/** Never fires: this service fetches nothing. */
	onProgress(listener: (event: BlobProgressEvent) => void): () => void {
		return this.local.onProgress(listener);
	}

	/** Fires once per blob `announce` first recorded a durability for. */
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void {
		return this.local.onDurability(listener);
	}
}
