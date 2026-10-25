description: When one machine copies a block to another, the block is sent as base64 text, which makes it a third larger, and the receiver sends the whole block back in its answer; so a block of only 6.3 MiB can never be copied, though it fits the 8 MiB message limit. Send the block as itself and answer with which blocks were kept.
prereq: a-log-block-rolls-over-by-size
architecture: docs/internals.md#spreadonchurnmonitor-middle-out
files: packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferRequest.blockData`, `BlockTransferResponse.blocks`, `handlePull`, `handlePush`, `BlockTransferClient.pushBlocks`, `BlockTransferClient.pullBlocks`, `pushBlockToPeers`), packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/test/inbound-stream-authorization.spec.ts, docs/internals.md
repro: verified
----
# A block copy travels unencoded

## What is wrong

Every replication push (rebalance, ring-shift confirm, spread-on-churn, cohort growth, the under-replication drain — all through `pushBlockToPeers` in `packages/db-p2p/src/cluster/block-transfer-service.ts`) sends the block as `blockData[id]`: base64 of its JSON. That inflates it by 4/3. The client refuses, before dialing, a request over `MAX_BLOCK_MESSAGE_BYTES` (`ProcessMessageOptions.maxRequestBytes`), so any block over about 6 MiB of JSON can never be pushed.

Reproduced (throwaway spec, since deleted): `BlockTransferClient.pushBlocks` with a 6,815,811-byte block threw `MessageTooLargeError` ("encodes to 9087824 bytes, over the 8388608-byte request limit") without dialing. The original report guessed the receiver would refuse with `InvalidDataLengthError`; in fact the sender refuses first. The push loop counts it as `unreachable` for every peer, so the block stays under-replicated and the drain eventually gives up per peer.

Two more costs on the same wire:

- `handlePush` answers with `blocks[id] = data`, echoing the full base64 payload of every accepted block. No sender reads it — senders read only `missing`. The echo doubles the bytes on the link and puts the answer, too, under the 8 MiB read cap.
- `handlePull` answers base64 as well, and for every requested block in one reply. Pull has no production caller today (only tests).

## Expected

- A push carries each block as its JSON value (`Record<BlockId, IBlock>`), not a string, so a block up to `MAX_BLOCK_BYTES` (from `a-log-block-rolls-over-by-size`) plus its metadata and commit proof fits one push frame.
- A push answer names the accepted block ids and the missing ones; it carries no block content. Keep the receiver-side rules exactly as they are: structural validation of each block, certification before persisting, per-block decisions, holder-evidence reporting for accepted blocks.
- A pull answer carries blocks as JSON values too. Decide whether pull is still wanted at all (no production caller); if it is kept, it answers within the frame — at least the first block always, the rest while they fit, unanswered ones listed so the caller can ask again — the same rule `fitConsultContent` applies to consult answers in `packages/db-p2p/src/storage/block-archive.ts`. If removed, remove its tests and doc mentions with it.
- `pushBlockToPeers` keeps reading answers "the one true way" (a peer holds the block when its answer does not list it missing).

This changes the block-transfer wire format with no version gate; per AGENTS.md backwards compatibility is not a concern yet, but say in `docs/internals.md` (§SpreadOnChurnMonitor's push paragraph, and wherever the payload is described) that a sender and receiver on builds either side of this change cannot copy blocks to each other.

## TODO

- Change `BlockTransferRequest`/`BlockTransferResponse` and both sides of push (and pull, or remove pull) as above.
- Drop the base64 encode/decode; the receiver still rejects a value that is not a structurally valid block (`null`, primitives, no `header`).
- One regression test: a push of a block just under `MAX_BLOCK_BYTES` round-trips through the real stream handler (the linked-duplex harness in `block-transfer-roundtrip.spec.ts`) and the receiver persists it. Update the existing round-trip and authorization specs for the new shapes rather than adding more.
- Update `docs/internals.md`.
- Run `yarn build` and `yarn test` for db-p2p.
