import type { BlockId, CollectionId } from '../index.js';
import type { ActionId } from '../collection/action.js';

/** A commit landed on this node mutating one collection's blocks. */
export type CollectionChangeEvent = {
	/** Header/collection id of the affected collection (block.header.collectionId). */
	readonly collectionId: CollectionId;
	/** Blocks within that collection mutated by this commit. */
	readonly blockIds: readonly BlockId[];
	readonly actionId: ActionId;
	readonly rev: number;
};

export type CollectionChangeListener = (event: CollectionChangeEvent) => void;

/**
 * The cluster-consensus commit certificate for a committed action — the **authoritative** proof
 * that the cohort agreed the commit. It is the cross-package currency the local change-notifier
 * bridge forwards into the cohort-topic substrate (`CohortTopicService.onLocalCommit`) so reactivity
 * can originate notifications **without re-signing**: a notification's signature is bit-for-bit this
 * `thresholdSig`. The bridge and every downstream consumer treat the bytes as opaque and pass them
 * through unchanged — only the cluster layer that produced consensus ever mints one.
 *
 * Peer ids are carried as their string form (the cluster keys signatures by peer-id string); db-core
 * stays cross-platform and never references a libp2p `PeerId` type here.
 */
export type CommitCert = {
	/** Threshold signature bytes proving `signers` agreed the commit. Forwarded UNCHANGED; never re-signed. */
	readonly thresholdSig: Uint8Array;
	/** Peer-id strings whose signatures compose {@link thresholdSig} (a distinct set of size ≥ {@link minSigs}). */
	readonly signers: readonly string[];
	/** Threshold the signer set satisfies (the cluster super-majority / cohort `k − x`). */
	readonly minSigs: number;
	/**
	 * The exact byte preimage each `signers[i]` signed to produce its 64-byte chunk of
	 * {@link thresholdSig} — the cluster's per-member commit-vote payload `utf8(commitHash + ":approve")`,
	 * identical across all approving signers. Reactivity sets a notification's `digest` to
	 * base64url(signedPayload) so a subscriber's threshold-verify over `digest` reproduces the exact
	 * signed image. Opaque to db-core; minted only by the cluster layer.
	 */
	readonly signedPayload: Uint8Array;
};

export interface IBlockChangeNotifier {
	/**
	 * Subscribe to commits that mutate the given collection. Returns an
	 * idempotent unsubscribe. Listeners are invoked AFTER the commit's critical
	 * section (locks released), synchronously in commit order; a throwing
	 * listener must not break the commit or other listeners (log + continue).
	 */
	onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void;
}

export function isBlockChangeNotifier(x: unknown): x is IBlockChangeNotifier {
	return !!x && typeof (x as IBlockChangeNotifier).onCollectionChange === 'function';
}
