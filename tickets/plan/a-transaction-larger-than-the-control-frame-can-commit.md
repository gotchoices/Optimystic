description: A write bigger than about one megabyte can never be saved once another machine shares the data, because the message that carries it between machines is capped at one megabyte and the receiver refuses it; the writer just sees a missing vote. Let large writes commit, and fail clearly and early wherever a limit must remain.
files: packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/cluster/client.ts (`ClusterClient.update`, `encodedBytes`), packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-core/src/network/struct.ts
----
# A transaction larger than the control frame can commit

GitHub [#35](https://github.com/gotchoices/Optimystic/issues/35) (risavian). Read the issue in full (`gh issue view 35`); it has a reproduction and a control run.

`ClusterClient.update` sends `{ operation: 'update', record }` as one length-prefixed JSON frame, and the record carries the pend's full transforms in `message.operations[].pend.transforms`. `ClusterService` decodes with `maxDataLength: MAX_CONTROL_MESSAGE_BYTES` (1 MiB). Every remote cohort member refuses a transaction whose transforms exceed about 1 MiB (`InvalidDataLengthError: Message length too long`). The stream resets, and the writer sees `Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)`. Founding a Sereus strand with its schema hit this (`apply schema`'s catalog batch). Raising the cap only moves the cliff; the reporter verified the cap is the cause.

Note that one consensus record can now carry several collections' transforms (`a-consensus-record-carries-several-collections-of-one-action`), so records get larger, not smaller.

## Expected

- A transaction whose payload exceeds the control cap commits across machines. Directions to weigh (the planner decides and records why): keep block data off the control frame (the transforms travel on the block-sized protocol, or by reference for the member to fetch, with the record carrying digests), or chunk or stream the frame. The record's signatures must still bind the content.
- Any hard limit that remains is checked on the sender before sending, and fails with an error naming the limit, never with a reset that reads as a missing vote.
- If a per-transaction size limit remains, it is documented for writers.

## Test

A two-node spec committing a transaction above 1 MiB (the issue's 1.1 MB append shape), and a spec that an oversized request fails locally with the named error.
