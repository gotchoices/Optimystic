/**
 * Framed-message size caps for the db-p2p consensus protocols.
 *
 * Every inbound stream handler frames its wire data with length-prefixed
 * encoding (`it-length-prefixed`) and `JSON.parse`s each frame. Passing one of
 * these constants as the decoder's `maxDataLength` makes an oversized frame
 * reject at the length-prefix (before any allocation against the declared size)
 * instead of buffering up to the library default (4 MiB) of attacker-controlled
 * JSON per frame. Mirrors the existing precedent
 * `DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024` in
 * `packages/db-core/src/cohort-topic/wire/codec.ts`.
 *
 * Outbound, `ProtocolClient.processMessage` refuses to send a request larger than the cap its server
 * decodes under (`ProcessMessageOptions.maxRequestBytes`), so an oversized request fails locally, by
 * name, rather than as a remote stream reset.
 *
 * The encoder has the same 4 MiB default, so an encode left at it silently caps a block-carrying frame
 * at half its size. Every block-carrying service therefore encodes its reply under the cap its client
 * reads the reply under, and `ProtocolClient` encodes a request under no cap beyond `maxRequestBytes`.
 */

import { MAX_TRANSACTION_BYTES } from '@optimystic/db-core';

/**
 * Max size (bytes) of a single framed message on a *control-plane* protocol: what carries a peer set,
 * signatures and small metadata, never a transaction's transforms or bulk block data. Inbound, the
 * sync request (`SyncService`) decodes under it; outbound, the client reads the dispute vote and
 * resolution ack under it, and a `SyncClient` sends no request larger.
 */
export const MAX_CONTROL_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * What a block-carrying frame holds beyond the transaction's own pend: the repo message envelope, a
 * cluster record's peer map (addresses capped at 8 per peer), its promise and commit signatures and
 * apply outcomes, and a commit record carried alongside a held-back pend record on the action's first
 * commit request (`ClusterClient.updateCarrying`).
 *
 * NOTE: sized by reasoning (a ten-peer record's peer map and signatures come to tens of kilobytes),
 * not by measuring a near-limit record. If a `request:too-large` log ever names the cluster protocol,
 * the envelope outgrew this reserve: measure it, raise the reserve, and lower `MAX_TRANSACTION_BYTES`
 * by as much, so the frame cap other builds decode under stays at 8 MiB.
 */
export const TRANSACTION_ENVELOPE_RESERVE_BYTES = 512 * 1024; // 512 KiB

/**
 * Max size (bytes) of a single framed message on a *block-carrying* protocol, in both directions:
 *
 * - repo (`RepoService`, `RepoClient`) — pend/commit transforms, block bodies in get responses;
 * - cluster (`ClusterService`, `ClusterClient`) — a pend record carries the transaction's transforms,
 *   and the member echoes that record back with its vote;
 * - dispute challenge (`DisputeProtocolService`) — the challenge carries the disputed cluster record;
 * - block-transfer (`BlockTransferService`, `BlockTransferClient`) — a pushed block with its revision metadata and commit proof;
 * - sync responses (`SyncClient`) — block archives.
 *
 * Derived from the per-transaction limit, so a transaction a writer is allowed to send fits every frame
 * it travels in: the writer → coordinator request, the coordinator → member record, and the member's
 * echoed answer.
 */
export const MAX_BLOCK_MESSAGE_BYTES = MAX_TRANSACTION_BYTES + TRANSACTION_ENVELOPE_RESERVE_BYTES; // 8 MiB

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

/**
 * How many bytes one remote `get` reply may spend on its entries, measured as the JSON-encoded size of
 * each: past it, `RepoService` answers a block with a left-out entry and the asker's `RepoClient` asks
 * again for it (`fitGetReply` in `repo/get-reply.ts`). The first entry is always carried whole.
 *
 * The frame less the envelope reserve, i.e. the transaction limit, which is also the block limit
 * (`MAX_BLOCK_BYTES`): a reply holding one block of that size fits the frame inside the same reserve a
 * transaction gets, so a reply packed up to the same total leaves the reserve for the left-out entries
 * and the JSON around the entries. Unlike a consult answer, a left-out entry carries no claim or proof,
 * so nothing else needs the room {@link CONSULT_RESPONSE_CONTENT_BUDGET_BYTES} keeps back.
 */
export const GET_REPLY_CONTENT_BUDGET_BYTES = MAX_BLOCK_MESSAGE_BYTES - TRANSACTION_ENVELOPE_RESERVE_BYTES;
