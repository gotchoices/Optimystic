description: A slow join seen through a public relay was another project's batched block copy using all of a slow relayed link, with other requests to the same machine waiting behind it; this change writes down how a block copy and reads share one connection and leaves a marked note where the code would change if it ever matters here.
architecture: docs/internals.md#cluster-health-monitors
files: docs/internals.md (§Cluster Health Monitors, the paragraph after "One push loop."), docs/debugging.md (the `block-transfer-service` namespace row), packages/db-p2p/src/cluster/block-transfer.ts (`NOTE:` above the semaphore in `BlockTransferCoordinator`)
difficulty: easy
----
# A bulk push queues ahead of reads on its connection

From fix ticket `bug-a-large-replication-push-stalls-a-relayed-attach` (GitHub #39). Analysis (in the fix/implement ticket history): the 33-block push was Sereus's join catch-up, not Optimystic's; the 8 s transit was the relay's ~130 KB/s throughput; the delayed reads waited in yamux's single first-in-first-out send queue behind up to one 256 KiB window per active push stream. Nothing in this repository was at fault.

## What was done

- `docs/internals.md`: new paragraph "A push shares its connection with every other request to that peer." after "One push loop." — yamux's single FIFO send queue with no stream priority, the 256 KiB minimum window that does not grow on a slow link, a read waiting behind up to one window per push in flight to that peer plus relay buffering, that on a relayed link this is the link's throughput (cites #39's ~130 KB/s ≈ 2 s per window), `maxConcurrency` 4 with nothing keeping pushes off one peer, and why splitting a push alone would not help.
- `docs/debugging.md`: `block-transfer-service` row gains one sentence: the gap between a sender's dial and the `request blocks=` line is transit time, set by the link's throughput on a relayed link.
- `packages/db-p2p/src/cluster/block-transfer.ts`: tripwire `NOTE:` above the semaphore — up to `maxConcurrency` pushes can target one peer, each queuing up to one window ahead of its reads; the lever if ever measured is one push in flight per destination peer, keeping the node-wide limit.

## Validation

- `yarn lint:docs`: all citations resolve.
- No code behaviour changed and no test added: there is no defect to reproduce and the tripwire is conditional. Build/tests not run (comment-only source change).

## For the reviewer

- Check the yamux claims against `@chainsafe/libp2p-yamux` 8.0.1 if wanting to be strict; the doc says the window grows "only when the receiver drains a whole window within a few round trips" (the fix ticket said four) — wording kept loose on purpose.
- The items "for the human to forward" to Sereus (size `maxChunkBytes` from the declared link) and the relay (measure throughput with `relay-bytes-metrics-libp2p`) are outside this repository and were not acted on; they remain in the fix ticket's text for the human.
