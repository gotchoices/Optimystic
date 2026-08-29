import type { BlockId } from "@optimystic/db-core";
import { Latches } from "@optimystic/db-core";

/**
 * The ONE per-block write lock.
 *
 * A block's metadata is stored as a single blob — `{ latest, ranges }` — read and written whole, so
 * any read-modify-write of it overwrites `latest` whether it meant to or not. The invariant is
 * therefore stated over the whole blob, not over `latest`:
 *
 * > A block's metadata, revision records, action transforms, pending records, and stored proofs are
 * > only ever written while holding {@link blockWriteLatchKey}`(blockId)`.
 *
 * This module is the single acquirer of that key. The check, which deliberately matches the call
 * shape (the escapes keep this very comment from matching):
 *
 * >     grep -rnE "Latches\.acquire\(" packages/db-p2p/src
 *
 * That must return exactly one line — the call in `acquireBlockWriteLatch` below. A second hit
 * anywhere means a caller has started taking the key directly and the token discipline has a hole.
 * Every writing method on `IBlockStorage` demands a
 * {@link BlockWriteLatch} token, which only this module can mint, so an unlatched write does not
 * type-check rather than merely being documented as forbidden.
 *
 * `Latches` is a plain FIFO promise-chain mutex — no owner tracking, no re-entrancy — so a holder
 * must never call back into something that acquires the same block's key. The token is what lets a
 * callee prove it is already inside the latch instead of re-acquiring.
 */
export const blockWriteLatchKey = (blockId: BlockId): string => `Block.write:${blockId}`;

let mint!: (blockId: BlockId) => BlockWriteLatch;
let expire!: (latch: BlockWriteLatch) => void;

/**
 * Opaque proof that the bearer is executing inside {@link blockWriteLatchKey}`(blockId)`. Only
 * {@link acquireBlockWriteLatch} (and {@link withBlockWriteLatch} through it) can construct one:
 * the constructor is private and the module-scoped minter is assigned from a static block, where
 * the private constructor is callable — no cast, nothing outside this module can build a token.
 *
 * A token is only valid while the latch it proves is actually held: releasing expires it, so a
 * callback that stashes its token and writes after its scope closed is rejected instead of silently
 * writing unlatched. `live` is the check; only this module can clear it.
 *
 * `BlockStorage` checks `latch.blockId` against its own id on every write, so a token for one block
 * cannot be presented for another.
 */
export class BlockWriteLatch {
	#live = true;

	private constructor(readonly blockId: BlockId) { }

	/** False once the latch this token proves has been released. */
	get live(): boolean {
		return this.#live;
	}

	static {
		mint = (blockId) => new BlockWriteLatch(blockId);
		expire = (latch) => { latch.#live = false; };
	}
}

/**
 * Acquire the write latch for `blockId`. The non-scoped form exists for `StorageRepo.commit`, which
 * holds N block latches at once (acquired in sorted id order so two commits cannot deadlock); every
 * other caller should prefer {@link withBlockWriteLatch}. The caller MUST call `release` exactly
 * once, in a `finally`. Releasing expires the token, so a write attempted with it afterwards is
 * rejected rather than running outside the latch.
 */
export async function acquireBlockWriteLatch(blockId: BlockId): Promise<{ latch: BlockWriteLatch; release: () => void }> {
	const releaseLatch = await Latches.acquire(blockWriteLatchKey(blockId));
	const latch = mint(blockId);
	return {
		latch,
		release: () => {
			expire(latch);
			releaseLatch();
		}
	};
}

/**
 * Run `fn` while holding the write latch for `blockId`, handing it the token to pass down to the
 * storage writes it makes. Acquire/release is per call, so a caller holds at most one block latch at
 * a time and cannot deadlock against `StorageRepo.commit`'s sorted, up-front multi-latch acquisition
 * — as long as `fn` does not itself acquire another block's latch (nothing in this package does).
 */
export async function withBlockWriteLatch<T>(blockId: BlockId, fn: (latch: BlockWriteLatch) => Promise<T>): Promise<T> {
	const { latch, release } = await acquireBlockWriteLatch(blockId);
	try {
		return await fn(latch);
	} finally {
		release();
	}
}
