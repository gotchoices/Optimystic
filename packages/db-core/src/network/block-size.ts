import { MAX_TRANSACTION_BYTES } from "./transaction-size.js";

/**
 * The most bytes one block may encode to, measured by `jsonEncodedBytes` (the UTF-8 length of its
 * `JSON.stringify`): 7.5 MiB, the same as {@link MAX_TRANSACTION_BYTES}.
 *
 * Every path that copies a whole block to another machine sends it in one message under db-p2p's
 * `MAX_BLOCK_MESSAGE_BYTES` frame cap — a replication push, a sync archive answer, a remote `get` reply —
 * so a block larger than one frame can never be replicated, repaired or read remotely. Two things pin the
 * value:
 *
 * - **It fits the frame with its wrapping.** A block at this size, plus what it travels in (a `get`
 *   reply entry's state, an archive revision entry, a push's metadata and commit proof), fits the
 *   8 MiB frame inside the same envelope reserve a transaction gets (`TRANSACTION_ENVELOPE_RESERVE_BYTES`).
 * - **No single transaction can exceed it on its own.** A block holding one entry or child is never
 *   larger than the transaction that wrote it, since that entry is inside the transaction's pend (as the
 *   new block's insert, or as the update operation that appends it), and the pend is held to
 *   {@link MAX_TRANSACTION_BYTES}.
 *
 * Structures that hold many entries per block (the log, tree nodes) keep each block that holds more than
 * one entry near {@link BLOCK_TARGET_BYTES}, far under this limit; this is the bound itself.
 */
export const MAX_BLOCK_BYTES = MAX_TRANSACTION_BYTES;

/**
 * The size past which a block holding more than one entry starts a new block: 1 MiB, by the same
 * `jsonEncodedBytes` measure as {@link MAX_BLOCK_BYTES}. The log rolls over to a new tail block at it
 * (`ChainInitOptions.blockTargetBytes`); an entry larger than it sits alone in its own block.
 *
 * Why 1 MiB:
 *
 * - One block's copy stays far under the 8 MiB frame, so a remote `get` reply carrying a few blocks
 *   still fits one message in the ordinary case, and a single replication push stays short on a slow
 *   relayed link.
 * - It is 32 entries of 32 KiB, so a log of ordinary small entries keeps rolling over by count
 *   (`EntriesPerBlock`) exactly as it did before the size rule.
 *
 * The cost: a structure of large entries spreads over more blocks, so walking it reads more blocks.
 */
export const BLOCK_TARGET_BYTES = 1024 * 1024;
