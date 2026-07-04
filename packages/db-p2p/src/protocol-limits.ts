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
