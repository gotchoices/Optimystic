----
description: Cap the size and number of incoming network messages on the P2P consensus protocols so a single peer can't flood a node with huge or endless data and exhaust its memory.
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts
difficulty: medium
----

# Cap inbound message size and count on P2P consensus protocols

## Background / reproduction

Every inbound stream handler in `db-p2p` frames its wire data with length-prefixed
encoding (`it-length-prefixed`) and then `JSON.parse`s each frame. The framing
decode is called with **no explicit `maxDataLength`**, so it falls back to the
library default (4 MiB per frame), and three of the handlers loop `for await` over
frames with **no per-stream frame cap** — so one stream can carry an unbounded
sequence of requests. libp2p allows up to `maxInboundStreams` (32) of these
streams concurrently. Net effect: a hostile peer can pin a large multiple of
`(4 MiB × frames × 32 streams)` of attacker-controlled JSON in memory.

Two independent gaps, per handler:

| Handler | file | size cap? | one-request-per-stream? |
|---|---|---|---|
| cluster request | `cluster/service.ts` (~210-221) | ❌ default 4 MiB | ❌ unbounded `for await` |
| repo request | `repo/service.ts` (~273-284) | ❌ default 4 MiB | ❌ unbounded `for await` |
| dispute request | `dispute/service.ts` (~101-112) | ❌ default 4 MiB | ❌ unbounded `for await` |
| sync request | `sync/service.ts` (~115-124) | ❌ default 4 MiB | ✅ already `return;` after first |
| block-transfer request | `cluster/block-transfer-service.ts` (~128-145) | ❌ default 4 MiB | ✅ already `return;` after first |
| client response read | `protocol-client.ts` (~149-163) | ❌ default 4 MiB | ✅ reads one frame via `first(...)` |

`sync` and `block-transfer` already enforce one-request-per-stream by `return`ing
out of the `for await` right after yielding the first response — that is the
pattern to copy to cluster/repo/dispute. None of the six sites size-caps its
decode.

## Why the change is safe

Every protocol client — `ClusterClient`, `RepoClient`, `SyncClient`,
`DisputeClient`, `BlockTransferClient` — sends its request through
`ProtocolClient.processMessage` (`protocol-client.ts:50`), which writes exactly
**one** length-prefixed request frame, reads exactly **one** response frame via
`first(...)`, then closes the stream. No client multiplexes multiple requests
over a single stream. So enforcing one-request-per-stream on the server handlers
matches what every real client already does; only a malicious/broken peer sends
more, which is exactly what we want to cut off.

An oversized frame is rejected for free: `it-length-prefixed` `decode` throws when
a frame's declared length exceeds `maxDataLength`; that throw propagates through
the `pipe` into the existing `catch` block, which calls `stream.abort(...)`. So
setting `maxDataLength` turns "buffer 4 MiB of junk" into "abort the stream".

## Design

### 1. A shared limits module

Add `packages/db-p2p/src/protocol-limits.ts` with two documented constants
(mirrors the existing precedent `DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024` in
`packages/db-core/src/cohort-topic/wire/codec.ts`):

```ts
/**
 * Max size (bytes) of a single inbound framed message on a *control-plane*
 * protocol — cluster records, dispute votes, sync requests. These carry a peer
 * set + signatures + small metadata, never bulk block data.
 */
export const MAX_CONTROL_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Max size (bytes) of a single inbound framed message on a *block-carrying*
 * protocol — repo operations (pend/commit transforms + block bodies),
 * block-transfer push payloads (base64-inflated block data, multiple per
 * request), and the block-bearing responses those protocols return.
 *
 * NOTE: the repo enforces no hard per-block byte ceiling today, so this is a
 * heuristic. If a legitimate block/transform can exceed this, the transfer will
 * be rejected — raise this constant (or thread a config override) rather than
 * removing the cap.
 */
export const MAX_BLOCK_MESSAGE_BYTES = 8 * 1024 * 1024; // 8 MiB
```

Numbers are a starting point sized generously above realistic payloads; tune with
the implementer's knowledge of block sizes. Keep them named and greppable.

### 2. Per-call-site caps

Server inbound-request decodes — pass `{ maxDataLength }` to the `lpDecode`/
`lp.decode` call:

- `cluster/service.ts` → `MAX_CONTROL_MESSAGE_BYTES`
- `dispute/service.ts` → `MAX_CONTROL_MESSAGE_BYTES`
- `sync/service.ts` → `MAX_CONTROL_MESSAGE_BYTES` (request is a tiny `SyncRequest`)
- `repo/service.ts` → `MAX_BLOCK_MESSAGE_BYTES` (pend/commit carry block data)
- `cluster/block-transfer-service.ts` → `MAX_BLOCK_MESSAGE_BYTES` (push carries base64 blocks)

Client response decode — the single `lpDecode` in `protocol-client.ts` is shared
across every protocol's *response*, so the cap must be per-call. Thread an
optional `maxDataLength` through `processMessage`'s `options` and apply it as
`lpDecode(stream, { maxDataLength: options?.maxDataLength ?? MAX_BLOCK_MESSAGE_BYTES })`.
Default to the block cap so no existing caller regresses. Each client passes the
cap matching the response it reads:

- `cluster/client.ts` → `MAX_CONTROL_MESSAGE_BYTES` (response is a `ClusterRecord`)
- `dispute/client.ts` → `MAX_CONTROL_MESSAGE_BYTES` (vote/ack)
- `sync/client.ts` → `MAX_BLOCK_MESSAGE_BYTES` (**response is a `BlockArchive` with block data — block cap, not control**)
- `repo/client.ts` → `MAX_BLOCK_MESSAGE_BYTES` (get returns block data)
- `block-transfer` client (`processMessage` calls in `block-transfer-service.ts`) → `MAX_BLOCK_MESSAGE_BYTES`

Note the asymmetry on sync: the *request* the server reads is tiny (control cap),
but the *response* the client reads is a block archive (block cap). Don't
collapse them to one constant.

### 3. One-request-per-stream on cluster/repo/dispute

In each of `cluster/service.ts`, `repo/service.ts`, `dispute/service.ts`, add a
`return;` inside the `processStream` generator immediately after the
`yield new TextEncoder().encode(JSON.stringify(response));`, so the generator
completes after the first response — exactly as `sync/service.ts:108` and
`block-transfer-service.ts:144` already do. The outer `for await ... of responses`
then drains, `stream.close()` runs, and any second frame the peer queued is never
read or parsed.

## Tripwire

The 8 MiB block cap is a heuristic because the repo enforces no hard per-block
size limit. It is fine now; it becomes work only if a legitimate block/transform
ever exceeds it (transfers would then be rejected). Recorded as a `NOTE:` comment
at the constant in `protocol-limits.ts`; if the repo later grows a real max-block
constant, derive the cap from it. This is a code comment, not a follow-up ticket.

## TODO

- Add `packages/db-p2p/src/protocol-limits.ts` with `MAX_CONTROL_MESSAGE_BYTES`
  and `MAX_BLOCK_MESSAGE_BYTES`, documented as above, including the `NOTE:`
  tripwire comment on the block constant.
- Pass `{ maxDataLength }` to the decode in each server handler:
  `cluster/service.ts`, `dispute/service.ts`, `sync/service.ts` → control cap;
  `repo/service.ts`, `cluster/block-transfer-service.ts` → block cap.
- Thread an optional `maxDataLength` through `ProtocolClient.processMessage`
  options and apply it to the response `lpDecode` (default = block cap).
- Have each client pass its cap: cluster/dispute → control; sync/repo/block-transfer
  → block (mind the sync request-vs-response asymmetry).
- Add `return;` after the first `yield` in the `processStream` generators of
  `cluster/service.ts`, `repo/service.ts`, `dispute/service.ts` (mirror
  sync/block-transfer).
- Add a test (`packages/db-p2p/test/inbound-message-caps.spec.ts`, mocha/chai,
  matching the repo's `.spec.ts` style) driving each handler with a mock duplex
  stream (see `test/cluster-service-redirect.spec.ts` for the mock-stream setup):
  - an oversized frame (declared length > the handler's cap) causes the stream to
    be aborted / yields no valid response;
  - a stream carrying two back-to-back valid requests yields exactly one response
    (second request is never processed) on cluster/repo/dispute.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`
  (stream output; do not silently redirect) and confirm green, plus `yarn build`
  / `tsc` for the package.
