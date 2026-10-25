description: A machine reading blocks it does not hold asks another machine for several of them at once, and the answer goes back as one message; if those blocks add up to more than the 8 MiB message limit the reader rejects the whole answer and reads nothing, even when every block on its own would fit. Answer within the limit and fetch the rest in a follow-up.
prereq: a-log-block-rolls-over-by-size
architecture: docs/internals.md#read-path-block-retrieval
files: packages/db-p2p/src/repo/service.ts (the `get` branch of the request handler), packages/db-p2p/src/repo/client.ts (`RepoClient.get`), packages/db-p2p/src/protocol-client.ts (`ProcessMessageOptions.maxDataLength`), packages/db-p2p/src/protocol-limits.ts (`MAX_BLOCK_MESSAGE_BYTES`, `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES`), packages/db-p2p/src/storage/block-archive.ts (`fitConsultContent`, the precedent), packages/db-core/src/transactor/network-transactor.ts (`NetworkTransactor.get`, `batchesForPayload`), docs/internals.md
repro: static
----
# A remote read reply fits one message

## What is wrong

`NetworkTransactor.get` groups the blocks of one read by coordinator and sends each group as one `IRepo.get` (`batchesForPayload`); `RepoService` answers the whole group in one frame; `RepoClient` reads the reply under `MAX_BLOCK_MESSAGE_BYTES` (8 MiB), and the length-prefix decoder rejects a larger frame outright. So a read whose blocks on one coordinator sum past 8 MiB fails for every block in it, although each block fits on its own. Once `a-log-block-rolls-over-by-size` bounds a single block at `MAX_BLOCK_BYTES` (7.5 MiB), this is what is left of "a remote `get` answer is one frame" from the original report: two single-entry blocks of a few MiB each in one read (a log tail and the leaf the same write changed, say) are enough.

Inferred from code, not run: `RepoService` encodes whatever `CoordinatorRepo.get` returns with no size check, and the reader's decoder caps at 8 MiB. To confirm, answer a two-block `get` over the real stream handler with two 5 MiB blocks and watch the client throw the decoder's length error.

The sync protocol already solved the same problem for consult answers: `fitConsultContent` in `packages/db-p2p/src/storage/block-archive.ts` always carries the first block's bytes and carries the rest while they fit `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES`, answering the others with their claim alone.

## Expected

A remote read of any set of blocks, each within `MAX_BLOCK_BYTES`, succeeds.

Recommended shape, keeping db-core unaware of frames:

- `RepoService`'s `get` branch packs the reply: entries in request order, the first always whole, each further entry whole while the encoded reply stays within a content budget below the frame (reuse or mirror the consult budget's reasoning), and every entry that does not fit replaced by a marker that this block was left out for size. The marker is a db-p2p wire detail and must never reach db-core: it is not `unavailable` (that earns `NetworkTransactor.get`'s second-chance round against a different coordinator and ranks in its merge), and not an absent answer (that would be an authoritative "never created").
- `RepoClient.get` asks the same peer again for the left-out ids, with the same floors, context and `askerHolds` narrowed to those ids, until every id is answered, and returns one merged `GetBlockResults`. Each round answers at least one block, so it terminates. A follow-up is a fresh `CoordinatorRepo.get` on the far side (its own cohort consult and read-repair window); entries answered in different rounds may come from different moments, which is no weaker than today's per-block guarantees — say so in a comment.
- Requests from a build without the marker are answered as today when they fit; a reply from an older server simply never carries the marker.

If the implementer finds a cleaner seam (for example packing in `NetworkTransactor` by known sizes), the requirement is the same: no read fails because its blocks together outgrow one frame, and nothing outside db-p2p learns why a block arrived in a second round.

## TODO

- Pack the `get` reply in `RepoService` and add the left-out marker to the response shape.
- Loop in `RepoClient.get` over left-out ids and merge.
- One regression test over the real stream handler (a linked-duplex pair as in `packages/db-p2p/test/block-transfer-roundtrip.spec.ts`): a two-block `get` whose blocks together exceed the frame returns both blocks.
- Describe the packing in `docs/internals.md` next to §A transaction's size limit's block-size paragraph.
- Run `yarn build` and `yarn test` for db-p2p.

## Note from a-block-copy-travels-unencoded

The length-prefix encoder (`it-length-prefixed`) defaults to a 4 MiB cap, and `RepoService` encoded its replies at that default, so any `get` reply over 4 MiB, a single 5 MiB block included, was refused by the server's own encoder before the reader's 8 MiB cap mattered. `a-block-copy-travels-unencoded` now has `RepoService` (and the cluster, sync and block-transfer services, and `ProtocolClient` for requests) encode under `MAX_BLOCK_MESSAGE_BYTES`. The regression test here — two 5 MiB blocks over the real stream handler — is the first to exercise that repo reply encode above 4 MiB.
