import { sha256 } from "multiformats/hashes/sha2";
import { toString as uint8ArrayToString } from "uint8arrays";
import type { BlockOperation, IBlock, BlockId, BlockStore, ReadPurpose } from "../index.js";
import { applyOperation } from "../transform/helpers.js";
import { canonicalJson } from "../utility/canonical-json.js";

export async function get<T extends IBlock>(store: BlockStore<T>, id: BlockId, purpose?: ReadPurpose): Promise<T> {
	const block = await store.tryGet(id, purpose);
	if (!block) throw Error(`Missing block (${id})`);
	return block;
}

export function apply<T extends IBlock>(store: BlockStore<T>, block: IBlock, op: BlockOperation) {
	applyOperation(block, op);
	store.update(block.header.id, op);
}

/** Canonical sha256 of a block's content, base64url: `base64url(SHA256(canonicalJson(block)))`.
 * The single hash used wherever two nodes must agree on what a block contains — quorum restoration
 * content-agreement (db-p2p `selectQuorumBlock` candidates) and commit content digests. Keep ONE
 * implementation: a drifted copy reports honest content as forged. */
export async function canonicalBlockHash(block: IBlock): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(block));
	const digest = await sha256.digest(bytes);
	return uint8ArrayToString(digest.digest, 'base64url');
}
