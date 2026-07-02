----
description: Several network request handlers accept incoming messages of unlimited size and count, letting one peer flood a node with huge or endless data and exhaust its memory.
files: packages/db-p2p/src/protocol-client.ts (~149-163), packages/db-p2p/src/cluster/service.ts (~210-221), packages/db-p2p/src/repo/service.ts (~273-284), packages/db-p2p/src/sync/service.ts (~115-124), packages/db-p2p/src/dispute/service.ts (~101-112)
difficulty: medium
----

# No message-size or frame-count caps on inbound consensus protocols

## The problem

Every listed handler decodes its inbound stream with a bare `lpDecode(source)` —
no `maxDataLength` — and then loops `for await` over frames with no per-stream
frame cap, `JSON.parse`-ing each frame. An inbound peer can therefore stream many
large (~4 MB) frames of attacker-controlled JSON on a single stream, and open up
to `maxInboundStreams` (32) such streams concurrently, driving memory blowup with
no bound.

The cluster, repo, and dispute request handlers additionally do not enforce
one-request-per-stream, so a single stream can carry an unbounded sequence of
requests.

## Expected behavior

Inbound frames must be size-capped to the real maximum payload for each protocol,
and request handlers must not accept an unbounded number of frames/requests per
stream.

## Suggested-fix hint

Pass `lpDecode({ maxDataLength })` sized to each protocol's realistic payload,
and enforce one-request-per-stream on the request handlers. The sync and
block-transfer paths already enforce single-request-per-stream — extend the same
discipline to the cluster, repo, and dispute handlers.

## TODO
- Determine a realistic `maxDataLength` per protocol.
- Add `maxDataLength` to each `lpDecode` call site listed in `files:`.
- Enforce one-request-per-stream on cluster/repo/dispute request handlers,
  mirroring sync/block-transfer.
- Add a test that an oversized frame and an over-count stream are rejected.
