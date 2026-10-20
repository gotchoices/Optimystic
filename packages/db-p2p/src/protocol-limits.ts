/**
 * Inbound-message size caps for the db-p2p consensus protocols.
 *
 * Every inbound stream handler frames its wire data with length-prefixed
 * encoding (`it-length-prefixed`) and `JSON.parse`s each frame. Passing one of
 * these constants as the decoder's `maxDataLength` makes an oversized frame
 * reject at the length-prefix (before any allocation against the declared size)
 * instead of buffering up to the library default (4 MiB) of attacker-controlled
 * JSON per frame. Mirrors the existing precedent
 * `DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024` in
 * `packages/db-core/src/cohort-topic/wire/codec.ts`.
 */

/**
 * Max size (bytes) of a single inbound framed message on a *control-plane*
 * protocol — cluster records, dispute votes, sync requests. These carry a peer
 * set + signatures + small metadata, never bulk block data.
 */
export const MAX_CONTROL_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Max size (bytes) of a single inbound framed message on a *block-carrying*
 * protocol — repo operations (pend/commit transforms + block bodies),
 * block-transfer push payloads (base64-inflated block data, multiple per
 * request), and the block-bearing responses those protocols return.
 *
 * NOTE: the repo enforces no hard per-block byte ceiling today, so this is a
 * heuristic. If a legitimate block/transform can exceed this, the transfer will
 * be rejected — raise this constant (or thread a config override) rather than
 * removing the cap. If the repo later grows a real max-block constant, derive
 * this cap from it.
 */
export const MAX_BLOCK_MESSAGE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * The most blocks one latest-revision consult request names (`SyncRequest.blockIds`). An asker
 * splits a longer list into several requests; a server answers only this many of a longer list and
 * leaves the rest unanswered, which the asker reads as silence for those blocks. A read rarely names
 * more than a handful of blocks, and this many ids plus their held revisions is a few KB against
 * {@link MAX_CONTROL_MESSAGE_BYTES}.
 */
export const MAX_CONSULT_BATCH_BLOCKS = 32;

/**
 * How many bytes of block content one consult response may carry across all its blocks, measured as
 * the JSON-encoded size of each archive that carries bytes. A block whose bytes would pass it is
 * answered with its claim and proof alone (`SyncContentOmitted` `'size'`), except the first block
 * carrying bytes, which always does — so a one-block consult is answered exactly as before. Half of
 * {@link MAX_BLOCK_MESSAGE_BYTES}, the cap the asker reads the response under, leaving the rest for
 * claims, proofs and framing.
 */
export const CONSULT_RESPONSE_CONTENT_BUDGET_BYTES = MAX_BLOCK_MESSAGE_BYTES / 2;
