description: One transaction is limited to what fits in a single network message (7.5 MiB of encoded change); let a larger transaction commit by sending its changes in several messages.
files: packages/db-core/src/network/transaction-size.ts (`MAX_TRANSACTION_BYTES`, once `a-transaction-larger-than-the-control-frame-can-commit` lands), packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/cluster/service.ts
tradeoffs: Writers can split large batches themselves, the limit is documented and fails fast with a named error, and chunking every hop (the writer's request, the cluster record, the member's echoed answer, carried records) is a sizeable protocol change for a case no known application needs.
----
# A transaction larger than one frame can commit

`a-transaction-larger-than-the-control-frame-can-commit` (GitHub #35) settles on one per-transaction limit, `MAX_TRANSACTION_BYTES`, checked on the writer, with every hop the pend takes framed under the same 8 MiB cap. It deliberately stops there: the whole pend still travels in one frame on each hop — writer to coordinator on the repo protocol, coordinator to each member on the cluster protocol, and back as the member's echoed answer.

Lifting the limit means a pend can span several frames on every one of those hops, with the record's `messageHash` still binding the whole content. Directions: stream the transforms in chunks on one stream (the per-stream "one request" rule would change — see `feat-a-stream-carries-more-than-one-request`), or move the transforms off the record entirely and have members fetch them by digest in chunks, which also stops the member echoing the whole pend back in its answer.

## Expected

A transaction above `MAX_TRANSACTION_BYTES` commits across machines; any limit that remains is checked on the writer and documented.
