import type { BlockId } from "../blocks/structs.js";
import { cidOfPiece, rootPieceId, type BlobRef } from "../blob/blob-ref.js";

declare const routingKeyBrand: unique symbol;

/**
 * The bytes a block or a blob is routed on — what `IKeyNetwork.findCluster` and
 * `IKeyNetwork.findCoordinator` are handed for it.
 *
 * Branded so the only ways to obtain one are {@link routingKeyForBlock} and {@link routingKeyForBlob}.
 * A block's key is its id's utf8 text and a blob's is 32 raw digest bytes; they never need telling
 * apart, since an equal key only means the same placement. Every party that asks "who is
 * responsible for this block" (the writer's `NetworkTransactor`, a coordinator's responsibility check,
 * a cohort member re-deriving its cluster, `RepoService`'s redirect check) must land on the same ring
 * position, and they only do if they hand the key network the same bytes. When the writer pre-hashed
 * the id and the servers did not, every network wider than one cohort sent writers to the wrong
 * machines — and no fixture was wide enough to notice, because a cohort holding every peer is the same
 * set from any coordinate.
 */
export type RoutingKey = Uint8Array & { readonly [routingKeyBrand]: true };

const utf8 = new TextEncoder();

/**
 * A block's routing key: the raw utf8 bytes of its id. Deliberately NOT hashed here — the key network
 * hashes the key once into a ring coordinate, and that is the only hash between a block id and its cohort.
 */
export function routingKeyForBlock(blockId: BlockId): RoutingKey {
	return utf8.encode(blockId) as RoutingKey;
}

/** A blob's routing key: the 32-byte SHA-256 digest inside its reference, not hashed again (the key network hashes once). */
export function routingKeyForBlob(ref: BlobRef): RoutingKey {
	return cidOfPiece(rootPieceId(ref)).multihash.digest as RoutingKey;
}
