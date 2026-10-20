import type { ActionRev, BlockId } from '@optimystic/db-core';
import type { BlockArchive } from '../storage/struct.js';

/**
 * Request to sync a specific block or revision from a peer.
 *
 * This protocol is used for block restoration across storage tiers,
 * allowing nodes to request missing blocks from cluster peers or storage rings.
 */
export interface SyncRequest {
	/** Block ID to retrieve */
	blockId: BlockId;

	/**
	 * Optional specific revision to retrieve.
	 * If undefined, retrieve the latest available revision.
	 */
	rev?: number;

	/**
	 * If true, include pending transactions in the response.
	 * Typically true when requesting latest state, false for historical revisions.
	 */
	includePending?: boolean;

	/**
	 * Maximum number of revisions to return.
	 * Prevents excessive response sizes.
	 * @default 100
	 */
	maxRevisions?: number;

	/**
	 * Optional hint about which tier is requesting (for logging/metrics).
	 * Values: 'ring-zulu', 'ring-0', 'ring-N', etc.
	 */
	requestingTier?: string;

	/**
	 * What the asker holds of each block it asks about: its newest committed `(rev, actionId)`. A
	 * block missing from the map is one the asker holds nothing of. Present → the server answers in
	 * {@link SyncResponse.answers} and may leave a block's content out (see {@link SyncBlockAnswer}).
	 * Absent → the original single-archive answer, exactly as before.
	 *
	 * Telling a cohort member what the asker holds extends it no new trust: echoing the asker's
	 * revision back gains a lying peer nothing it could not get by answering "holds nothing", since
	 * both read to the asker as "nothing ahead".
	 */
	held?: Record<BlockId, ActionRev>;
}

/**
 * Why a block's bytes were left out of a {@link SyncBlockAnswer}. `'held'`: the asker already holds
 * the revision served, or a newer one.
 */
export type SyncContentOmitted = 'held';

/** One block's answer to a request that carried {@link SyncRequest.held}. */
export interface SyncBlockAnswer {
	/**
	 * The archive served; absent → this peer holds nothing of the block. With `contentOmitted`, the
	 * archive's revision entry carries no `block` and no `action.transform.insert`, but still carries
	 * the commit proof for the revision served.
	 */
	archive?: BlockArchive;
	contentOmitted?: SyncContentOmitted;
}

/**
 * Response containing block archive data.
 */
export interface SyncResponse {
	/** True if the peer has the requested data */
	success: boolean;

	/** Block archive if found */
	archive?: BlockArchive;

	/** Error message if unsuccessful */
	error?: string;

	/** Peer ID of responder (for tracking/metrics) */
	responderId?: string;

	/** Present whenever the request carried {@link SyncRequest.held}: one answer per asked block. */
	answers?: Record<BlockId, SyncBlockAnswer>;
}

/** Sync protocol prefix - namespaced under db-p2p */
export const SYNC_PROTOCOL_PREFIX = '/db-p2p/sync/';

/** Sync protocol version */
export const SYNC_PROTOCOL_VERSION = '1.0.0';

/**
 * Builds the full protocol string for the sync protocol.
 *
 * @param protocolPrefix - Optional prefix (e.g., '/optimystic/testnet')
 * @returns Full protocol string
 */
export const buildSyncProtocol = (protocolPrefix: string = ''): string =>
	`${protocolPrefix}${SYNC_PROTOCOL_PREFIX}${SYNC_PROTOCOL_VERSION}`;

