description: A stored block can grow larger than the biggest message machines exchange — a log block keeps 32 entries and each entry carries its write's data — and such a block can then never be copied to another machine, repaired, or read remotely. Bound how large a block may grow, or let a block travel in more than one message.
files: packages/db-core/src/chain/chain.ts (`EntriesPerBlock`, `Chain.add`), packages/db-p2p/src/protocol-limits.ts (`MAX_BLOCK_MESSAGE_BYTES`, `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES`), packages/db-p2p/src/cluster/block-transfer-service.ts (`pushBlockToPeers`, `BlockTransferClient.pushBlocks` — base64 of the block's JSON), packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/repo/client.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Only applications writing large entries (hundreds of KB per write) reach it, and the fix — byte-based log roll-over and leaf splitting, or chunked block transfer — touches the block format or every block-carrying protocol.
----
# A block larger than a frame cannot be copied

Found while planning `a-transaction-larger-than-the-control-frame-can-commit` (GitHub #35). That ticket bounds one *transaction's* size; this is about one *block's*, which nothing bounds.

## Why a block outgrows a frame

A log block holds up to `EntriesPerBlock` (32) entries, rolling over by count, never by bytes, and each entry carries its action — the written data itself. A diary taking 300 KB appends therefore fills a log block of about 9.6 MB; 600 KB appends (which the issue's reproduction commits today) about 19 MB. Every individual transaction is well under the per-transaction limit; the block is not. A tree leaf or any block updated across many transactions can grow the same way if its contents are large.

## Where it then fails (inferred from code, not run)

Every path that moves a whole block between machines sends it as one frame capped at `MAX_BLOCK_MESSAGE_BYTES` (8 MiB):

- **Block-transfer push** (rebalance, spread-on-churn, cohort growth, the under-replication drain) sends the block as base64 of its JSON, inflating it by 4/3, so a block over about 6 MiB is refused by every receiver. The block stays under-replicated; the drain gives up per peer.
- **Sync archive answers** (read-repair consults, commit-path reconcile) carry the block in one frame; above the cap the asker refuses the answer, so repair of that block fails.
- **A remote `get`** answer is one frame; a reader on a machine that does not hold the block cannot read it at all.

The commits that build the block all succeed, and the block reads fine on machines that hold it, so nothing fails until a copy or a remote read is needed.

## To confirm

A two-node integration spec: 32 diary appends of 300 KB on node A (cohort of two), then read the diary from a third node that joins afterwards, or force a cohort-growth push. Expect the push to be refused (`InvalidDataLengthError` on the receiver) and the remote read to fail.

## Expected

Either no block can grow past what one frame carries (byte-aware log roll-over and leaf splits, with a documented per-block limit), or a block can travel in several messages. Whichever limit remains is checked on the writer, as the per-transaction one is.
