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

import { MAX_BLOB_PIECE_BYTES, MAX_TRANSACTION_BYTES } from '@optimystic/db-core';

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

/**
 * Largest header frame a blob stream reads: the JSON first frame in either direction
 * (`readBlobFrames` in `blob/blob-frames.ts`). A `stat` of {@link MAX_BLOB_STAT_REFS} references is
 * about 4 KB of JSON.
 */
export const MAX_BLOB_HEADER_BYTES = 16 * 1024;

/** Largest piece frame a blob stream reads: the reader's bound on one piece, so a peer cannot make it allocate more. */
export const MAX_BLOB_PIECE_FRAME_BYTES = MAX_BLOB_PIECE_BYTES;

/**
 * Most piece ids one blob `get` names. It is also the bound on what one `get` stream can queue on the
 * receiving side, since nothing below the reader pauses the sender (the `NOTE:` at `readBlobFrames`).
 */
export const MAX_BLOB_GET_PIECES = 16;

/** Most references one blob `stat` names. */
export const MAX_BLOB_STAT_REFS = 64;

/**
 * Longest scope a blob `announce` names, in UTF-16 code units (`scope.length`). A scope is a collection
 * id; 1024 keeps the header far under {@link MAX_BLOB_HEADER_BYTES}.
 */
export const MAX_BLOB_SCOPE_CHARS = 1024;

/**
 * Most blob `get` streams this node serves at once for one peer: a client opens one background and one
 * foreground stream per peer (docs/blobs.md §Moving pieces between machines).
 */
export const MAX_BLOB_INBOUND_GETS_PER_PEER = 2;

/** Most blob `get` streams this node serves at once in all. */
export const MAX_BLOB_INBOUND_GETS = 16;

/** Most background blob `get` streams this node has open at once. */
export const MAX_BLOB_BACKGROUND_GET_STREAMS = 4;

/** Most foreground blob `get` streams this node has open at once. */
export const MAX_BLOB_FOREGROUND_GET_STREAMS = 8;

/**
 * Most blob `announce` requests this node acts on from one peer in a minute; the rest are answered
 * `unreferenced` without reading committed state (`AnnounceLimiter` in `blob/announce-limiter.ts`,
 * docs/blobs.md §Who may fetch and who may store).
 *
 * Well above what an honest announcer sends. Its owed-copies drain examines at most 64 entries a pass
 * with at least 15 s between passes (the `UnderReplicationDrain` schedule it shares, `blockBudget` and
 * `minIntervalMs` in `repo/under-replication-drain.ts`), so at most 256 announcements a minute, and the
 * reaction to a cohort change announces at most 64 blobs a check with at least 60 s between checks.
 */
export const BLOB_ANNOUNCES_PER_PEER_PER_MINUTE = 600;

/**
 * Most reads of committed state this node runs at once to decide whether announced blobs are
 * referenced, over every peer together, so no number of peers raises its read work. Reader repair
 * draws on the same allowance.
 */
export const BLOB_REFERENCE_READS_IN_FLIGHT = 4;

/** Most peers whose announcement allowance this node remembers at once; a new peer past this evicts the entry whose window started longest ago. */
export const BLOB_ANNOUNCE_PEERS_TRACKED = 4096;

/** First wait before a `waitMs` retry round of a blob fetch, doubling to {@link BLOB_WAIT_RETRY_MAX_MS}. */
export const BLOB_WAIT_RETRY_INITIAL_MS = 500;

/** Longest wait between `waitMs` retry rounds of a blob fetch. */
export const BLOB_WAIT_RETRY_MAX_MS = 8_000;
