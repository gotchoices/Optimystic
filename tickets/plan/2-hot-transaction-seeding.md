----
description: Seed hot transactions to newly joined peers
dependencies: peer join protocol, transaction state
----

On join, identify regions near the peer ID and request current hot (pending/recent) transactions for those blocks. Members/coordinator rebroadcast succinct deltas (pend/commit certs) to new peer with rate limits/TTLs. Ensure idempotency and bounded load (per-block caps, backpressure); verify commit certificates on receipt. Add observability for join catch-up (counts, bytes, durations).
