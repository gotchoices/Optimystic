----
description: Verify that the new size and per-stream limits on incoming P2P consensus messages actually stop a hostile peer from flooding a node with huge or endless data.
files: packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/test/inbound-message-caps.spec.ts
difficulty: medium
----

# Review: cap inbound message size and count on P2P consensus protocols

## What was implemented

Two independent inbound-flood protections were added to every `db-p2p` consensus
stream handler and matching client:

1. **Size cap** — the length-prefixed decoder (`it-length-prefixed`) is now given
   an explicit `maxDataLength`. A frame whose *declared* length (the varint prefix)
   exceeds the cap is rejected at the prefix, **before any allocation against the
   declared size** — verified by reading `it-length-prefixed/dist/src/decode.js`:
   it throws `InvalidDataLengthError('Message length too long')` the instant
   `dataLength > maxDataLength`, before waiting for the body. Previously every
   decode used the library default of 4 MiB per frame.
2. **One request per stream** — the cluster/repo/dispute server generators now
   `return` after yielding the first response (sync and block-transfer already
   did). A second frame a peer queued on the same stream is never read or parsed.

### New shared module

`packages/db-p2p/src/protocol-limits.ts` defines two documented constants:

- `MAX_CONTROL_MESSAGE_BYTES = 1 MiB` — control-plane protocols (cluster records,
  dispute votes, sync **requests**).
- `MAX_BLOCK_MESSAGE_BYTES = 8 MiB` — block-carrying protocols (repo ops,
  block-transfer push payloads, and the block-bearing responses those return).

### Per-call-site caps applied

Server request decodes:

| Handler | cap |
|---|---|
| `cluster/service.ts` | control |
| `dispute/service.ts` | control |
| `sync/service.ts` | control (request is a tiny `SyncRequest`) |
| `repo/service.ts` | block |
| `cluster/block-transfer-service.ts` | block |

Client response decode: an optional `maxDataLength` was threaded through
`ProtocolClient.processMessage`'s `options` and applied to the response `lpDecode`,
**defaulting to the block cap** so no existing caller regresses. Each client passes
the cap matching the response it reads:

| Client | cap | note |
|---|---|---|
| `cluster/client.ts` | control | response is a `ClusterRecord` |
| `dispute/client.ts` | control | both challenge-vote and resolution-ack |
| `sync/client.ts` | **block** | response is a `BlockArchive` — request/response asymmetry |
| `repo/client.ts` | block | get returns block data |
| `block-transfer` client | block | both pull and push |

The sync asymmetry (server request = control cap, client response = block cap) is
intentional and commented at both sites.

## How to validate

- Build/typecheck: `cd packages/db-p2p && npx tsc --noEmit` → clean (EXIT 0).
- Full suite: `yarn workspace @optimystic/db-p2p test` → **1119 passing, 36 pending,
  0 failing** (~54s). Stream with `2>&1 | tee /tmp/db-p2p-test.log`, do not silently
  redirect (10-min idle timeout).
- New spec in isolation: `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/inbound-message-caps.spec.ts" --reporter spec` → **10 passing**.

### Test coverage (the floor, not the ceiling)

`test/inbound-message-caps.spec.ts` captures each service's registered handler and
drives it with a mock duplex stream:

- **Oversized frame → abort**, for all five server handlers (cluster, repo, dispute,
  sync, block-transfer). A prefix-only frame declaring `cap + 1` bytes.
- **Two back-to-back valid requests → exactly one processed**, for cluster/repo/
  dispute (asserts the stubbed handler method is invoked once, and the stream closes
  normally).
- **Block handlers do NOT apply the control cap** — repo and block-transfer accept a
  frame declaring `MAX_CONTROL_MESSAGE_BYTES + 1` (guards the request/response
  asymmetry so a block handler is never accidentally narrowed to the small cap).

## Known gaps / where to push (reviewer: treat tests as a floor)

- **Block-cap oversized tests are weaker regression guards than the control ones.**
  The block-cap oversized frames declare `8 MiB + 1`, which also exceeds the library's
  own 4 MiB default — so those two "abort" tests would still pass if the `maxDataLength`
  edit on the block handlers were reverted. The *control*-cap tests (1 MiB + 1, below the
  4 MiB default) are the strong guards that prove the cap is actually threaded and
  enforced; the block handlers share the identical code path. The added "does NOT apply
  the control cap" tests bracket the block cap from below. The exact 8 MiB upper boundary
  is **not** asserted (would require constructing a valid multi-MB JSON body — deemed too
  heavy for a unit test). If you want a tighter guard, that's the place.
- **No test for the client-side response cap.** The threading of `maxDataLength` into
  `ProtocolClient.processMessage`'s response `lpDecode` is covered only by typecheck +
  the fact that clients compile with their caps. `rpc-response-deadline.spec.ts` exercises
  the response-read path but not an oversized *response*. A test where a mock peer returns
  an over-cap response frame and the client rejects it would close this.
- **Not exercised over a real libp2p transport/multiplexer.** Tests invoke the handler
  callbacks directly with mock streams; the interaction with `maxInboundStreams` (32
  concurrent) and real stream teardown on `abort()` is not integration-tested here.
- **Behavioral note on the client default.** Callers that omit `maxDataLength` now get
  the 8 MiB block cap on their response read, where previously the implicit library
  default was 4 MiB. This is intentional (the ticket specifies defaulting to the block
  cap so block-bearing responses aren't rejected) but is a deliberate loosening of the
  default for the response path — confirm that matches intent.

## Review findings

- **Tripwire (parked, not a ticket):** The 8 MiB `MAX_BLOCK_MESSAGE_BYTES` is a
  heuristic because the repo enforces no hard per-block byte ceiling. Recorded as a
  `NOTE:` comment on the constant in `packages/db-p2p/src/protocol-limits.ts`. It
  becomes work only if a legitimate block/transform ever exceeds 8 MiB (transfers
  would then be rejected); if the repo later grows a real max-block constant, derive
  this cap from it.
