----
description: Add metrics and monitoring for transaction performance and network health
dependencies: transaction protocol, networking layer
----

Add metrics and monitoring for transaction performance and network health. This includes lightweight timing metrics (ms) for DHT closestPeers, protocol roundtrips, and pend/commit end-to-end. Add a per-request correlation id (e.g. trxId/messageHash) to logs across layers. Add optional verbose tracing flag (env) to include batch/peer details when diagnosing.
