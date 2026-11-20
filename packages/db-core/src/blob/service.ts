import type { DurabilityQuorum } from '../network/struct.js';
import type { BlobRef } from './blob-ref.js';

/** A node's blob service, `node.blobs` (docs/blobs.md §The node's blob service). Types only: db-p2p implements it. */
export interface BlobService {
	/** Store a stream as a blob, pinned for `owner`. Resolves once every piece is durable on this node. */
	put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult>;
	/** What this node knows about a blob, without fetching content. */
	stat(ref: BlobRef, options?: { probe?: boolean }): Promise<BlobStat>;
	/** The bytes, or a range of them, in order; fetches what is not here unless told not to. */
	read(ref: BlobRef, options?: BlobReadOptions): AsyncIterable<Uint8Array>;
	/** Bring the whole blob here ahead of a read. */
	fetch(ref: BlobRef, options?: BlobFetchOptions): Promise<void>;
	pin(ref: BlobRef, owner: string): Promise<void>;
	unpin(ref: BlobRef, owner: string): Promise<void>;
	/** Tell the blob's cohort that committed state now references it, and where. */
	announce(ref: BlobRef, scope: BlobScope): Promise<void>;
	onProgress(listener: (event: BlobProgressEvent) => void): () => void;
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void;
}

export interface BlobPutOptions { owner?: string; signal?: AbortSignal }
export interface BlobPutResult { ref: BlobRef; size: number }
export interface BlobReadOptions { offset?: number; length?: number; from?: 'anywhere' | 'here'; waitMs?: number; signal?: AbortSignal }
export interface BlobStat { ref: BlobRef; size?: number; locality: 'here' | 'partial' | 'elsewhere' | 'unknown'; heldBytes: number; durability?: BlobDurability }
/** The id of the reference tree that lists the blob (see Registering references). */
export type BlobScope = string;

export interface BlobFetchOptions {
	/** Keep trying while no reachable holder has a piece yet, as BlobReadOptions.waitMs. */
	waitMs?: number;
	signal?: AbortSignal;
}

/** docs/blobs.md §Placement, copying and durability: counted over the cohort members that accept blobs. */
export interface BlobDurability {
	readonly quorum: DurabilityQuorum;
	/** Accepting members known to hold the whole blob, this node included when it holds it. */
	readonly confirmed: number;
	/** Cohort members that accept blobs, this node included when it does. Zero when the cohort could not be
	 *  named ('unrouted'), and also when it was named but no member accepts blobs — which stays 'local', since
	 *  the writer holds the only copy there is. */
	readonly accepting: number;
	/** Accepting members not yet known to hold it, by peer-id string. Absent when the cohort could not be named. */
	readonly unconfirmed?: readonly string[];
}

export interface BlobDurabilityEvent { readonly ref: BlobRef; readonly durability: BlobDurability }

/** Fetch progress for one reference; a put has no reference until it ends, so it reports none. */
export interface BlobProgressEvent {
	readonly ref: BlobRef;
	readonly piecesFetched: number;
	readonly bytesFetched: number;
	/** Known once the root piece is here. */
	readonly size?: number;
}
