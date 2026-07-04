description: Confirmed that new size and per-stream limits on incoming P2P consensus messages stop a hostile peer from flooding a node with huge or endless data, and strengthened the tests that guard them.
files: packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/test/inbound-message-caps.spec.ts
----

# Review complete: cap inbound message size and count on P2P consensus protocols

## Summary

Two inbound-flood protections were added to the `db-p2p` consensus stream handlers
(cluster, repo, dispute, sync, block-transfer) and their clients:

1. **Size cap** — every length-prefixed decoder (`it-length-prefixed`) now gets an
   explicit `maxDataLength` (1 MiB for control-plane protocols, 8 MiB for
   block-carrying ones). An oversized frame is rejected at the varint length-prefix
   before any body allocation.
2. **One request per stream** — the cluster/repo/dispute server generators `return`
   after the first response (sync/block-transfer already did), so a second queued
   frame is never read or parsed.

The implementation is sound and the review confirmed it. Findings below.

## Review findings

**What was checked**

- **Security-critical claim verified against the library source.** Read
  `it-length-prefixed/dist/src/decode.js`: when `dataLength > maxDataLength` it throws
  `InvalidDataLengthError('Message length too long')` in `ReadMode.LENGTH`, *before*
  consuming the prefix or entering `ReadMode.DATA` — so no attacker-controlled body is
  ever buffered. The library default (`MAX_DATA_LENGTH`) is 4 MiB. The claim holds.
- **Completeness of coverage.** Grepped every inbound stream handler in `db-p2p/src`.
  The five consensus protocols were the only uncapped length-prefixed decoders; the
  cohort-topic (`stream-util.ts`) and reactivity (`notify-transport.ts`,
  `push-state-gossip.ts`) handlers already bound their reads with `readAllBounded` at
  512 KiB (`DEFAULT_STREAM_MAX_BYTES`). No uncapped inbound decoder remains.
- **One-request-per-stream placement.** Confirmed the added `return` sits inside each
  generator's `for await` loop after the first `yield`, in cluster/repo/dispute, and
  that sync/block-transfer already had it. A generator `return` propagates upstream, so
  the decoder never pulls the second frame. Real clients send exactly one request per
  dial (verified in `ProtocolClient.processMessage`), so this cannot truncate a
  legitimate multi-frame exchange.
- **Docs.** The anti-flood documentation in `docs/cohort-topic.md` / `architecture.md`
  covers the cohort-topic/reactivity substrate, not these RPC handlers, and no doc ever
  claimed a limit on the consensus protocols. Nothing was left stale; the new caps are
  self-documented in `protocol-limits.ts`. No doc change required.
- **Lint + typecheck + full suite** all pass (see below).

**Minor findings — fixed inline in this pass**

The two test gaps the implementer flagged honestly were both real and cheaply closed;
both fixes landed in `test/inbound-message-caps.spec.ts`:

- **Weak block-cap server guards.** The existing "oversized block frame → abort" tests
  declared `8 MiB + 1`, which also exceeds the library's own 4 MiB default — so they
  would have passed even if the `maxDataLength` edit on the block handlers were reverted.
  Added a strong guard for repo and block-transfer: a frame declaring `4 MiB + 1` (above
  the library default, below the block cap) must **not** be aborted. This fails if the
  edit is reverted (the 4 MiB default would reject it), proving the block cap is actually
  threaded and raised.
- **Client response cap was entirely untested.** The `maxDataLength` threading into
  `ProtocolClient.processMessage`'s response decode had no test. Added two: a control-cap
  client (`ClusterClient`) rejecting a response frame declaring `control + 1` (below the
  4 MiB default — so it passes *only* if the client threads the control cap, otherwise it
  would fall back to the default and surface "No response received"), and a block-cap
  client (`SyncClient`) rejecting a `block + 1` frame. Both assert the rejection message
  is `Message length too long`, pinning the failure to the length-prefix cap.

New spec count: 10 → 14 tests, all passing.

**Major findings — new tickets**

None. Coverage is complete and the mechanism is correct.

**Tripwires (conditional — recorded, not ticketed)**

- The 8 MiB `MAX_BLOCK_MESSAGE_BYTES` is a heuristic because the repo enforces no hard
  per-block byte ceiling. Already parked as a `NOTE:` comment on the constant in
  `packages/db-p2p/src/protocol-limits.ts` (carried over from the implement stage). It
  becomes work only if a legitimate block/transform ever exceeds 8 MiB, or if the repo
  later grows a real max-block constant to derive this cap from.
- **Aggregate inbound bound is not enforced.** Each cap bounds a *single* frame; a peer
  can still open up to `maxInboundStreams` (32) concurrent streams, each carrying one
  cap-sized frame (up to 32 × 8 MiB ≈ 256 MiB for repo). This is the standard libp2p
  posture and was out of scope for a per-frame cap; it is only work if concurrent-stream
  memory pressure is ever observed. Noted here (no single code site) rather than
  ticketed.

## Validation

- Typecheck: `cd packages/db-p2p && npx tsc --noEmit` → EXIT 0.
- Lint: `npx eslint` on changed files → EXIT 0. (No lint script in the `db-p2p`
  package; ran the root `eslint.config.js` against the touched files.)
- New spec in isolation → **14 passing** (was 10; +4 added this pass).
- Full suite: `yarn workspace @optimystic/db-p2p test` → **1125 passing, 36 pending,
  0 failing** (~53s).
