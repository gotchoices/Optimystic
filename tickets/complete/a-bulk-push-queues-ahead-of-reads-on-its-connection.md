description: A slow join seen through a public relay was another project's batched block copy using all of a slow relayed link, with other requests to the same machine waiting behind it; this change writes down how a block copy and reads share one connection and leaves a marked note where the code would change if it ever matters here.
architecture: docs/internals.md#cluster-health-monitors
files: docs/internals.md (§Cluster Health Monitors, the paragraph after "One push loop."), docs/debugging.md (the `block-transfer-service` namespace row), packages/db-p2p/src/cluster/block-transfer.ts (`NOTE:` above the semaphore in `BlockTransferCoordinator`)
difficulty: easy
----
# A bulk push queues ahead of reads on its connection

From fix ticket `bug-a-large-replication-push-stalls-a-relayed-attach` (GitHub #39). The 33-block push was Sereus's join catch-up, not Optimystic's; the 8 s transit was the relay's ~130 KB/s throughput; delayed reads waited in yamux's single first-in-first-out send queue behind up to one 256 KiB window per active push stream. Nothing in this repository was at fault.

## What was done

- `docs/internals.md`: paragraph "A push shares its connection with every other request to that peer." after "One push loop." — yamux's single FIFO send queue with no stream priority, the 256 KiB minimum window, a read waiting behind up to one window per push in flight, relayed-link throughput as the cause, the push concurrency limits, and why splitting a push alone would not help.
- `docs/debugging.md`: `block-transfer-service` row notes the dial-to-`request blocks=` gap is transit time.
- `packages/db-p2p/src/cluster/block-transfer.ts`: tripwire `NOTE:` above the semaphore — the lever, if ever measured, is one push in flight per destination peer.

## Review findings

- **Checked the yamux claims** against the installed `@chainsafe/libp2p-yamux` 8.0.1: `INITIAL_STREAM_WINDOW = 256 * 1024`, config rejects a smaller `initialStreamWindowSize`, sends are capped by `sendWindowCapacity`, and the receive window doubles only when a window is drained within `rtt * 4`. The doc's wording matches.
- **Checked the citations**: `streamMuxers: [yamux()]` in `libp2p-node-base.ts`, `maxConcurrency ?? 4` in `BlockTransferCoordinator`, the `request blocks=` log line in `block-transfer-service.ts`. `yarn lint:docs` passes.
- **Found and fixed (minor)**: the doc said "a node runs up to `maxConcurrency` pushes at once", and the `NOTE:` called the limit "node-wide". The semaphore covers only `BlockTransferCoordinator`; the spread-on-churn loop and the under-replication drain also call `pushBlockToPeers` outside it, one block at a time each. I reworded both to say that.
- **Tripwire**: per-destination push concurrency is still parked as the `NOTE:` at the semaphore, with no ticket. It is conditional on a measured problem in this repository.
- **Tests**: none added and none cut. The change is documentation plus comments, and there is no defect to reproduce. The db-p2p typecheck (`tsc --noEmit`) passes. I did not run the test suite because no behaviour changed.
- **Out of scope**: the suggestions to forward to Sereus (size `maxChunkBytes` from the declared link) and to the relay (measure throughput) stay in the fix ticket's history for the human.
