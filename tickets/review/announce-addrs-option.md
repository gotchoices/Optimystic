description: Added a way for a node behind a router or reverse proxy to tell other peers a different address than the one it actually listens on.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/announce-addrs.spec.ts
----

# Expose libp2p's announce-address options on `NodeOptions` — implementation summary

## What changed

`packages/db-p2p/src/libp2p-node-base.ts`:

- `NodeOptions` (around line 211, next to `listenAddrs`): added two new optional fields,
  `announceAddrs?: string[]` and `appendAnnounceAddrs?: string[]`, both documented inline.
- `createLibp2pNodeBase`'s assembled `addresses` block (around line 480): now conditionally spreads
  `announce: options.announceAddrs` and `appendAnnounce: options.appendAnnounceAddrs` into the
  `Libp2pInit` passed to `createLibp2p`, only when the corresponding option is set. Pure passthrough
  to libp2p's own `AddressManagerInit` — no new logic, no new defaults.
- When neither option is set, the `addresses` object is `{ listen: listenAddrs }` exactly as before
  — byte-identical to pre-change behavior for every existing caller.

New test file `packages/db-p2p/test/announce-addrs.spec.ts` — 3 cases, all against real libp2p nodes
booted over loopback (no `createLibp2p` mocking), following the `relay-address-propagation.spec.ts`
pattern:

1. **Neither option set** — `node.getMultiaddrs()` contains only the loopback listen addr, confirming
   default behavior is unchanged.
2. **`announceAddrs` set** — `node.getMultiaddrs()` contains ONLY the announced addr
   (`/dns4/example.com/tcp/4321`), NOT the loopback listen addr. Confirms libp2p's `announce` fully
   replaces the self-address record.
3. **`appendAnnounceAddrs` set** — `node.getMultiaddrs()` contains BOTH the loopback listen addr AND
   the appended addr. Confirms `appendAnnounce` is additive.

## Test / validation results

- `yarn workspace @optimystic/db-p2p test --grep "NodeOptions announce address passthrough"` — 3/3
  passing (~130ms).
- `yarn workspace @optimystic/db-p2p test --grep "announce"` — 7/7 passing (picks up the 3 new specs
  plus 4 pre-existing tests whose names happen to match "announce"; no interaction between them).
- `yarn workspace @optimystic/db-p2p build` — clean, no type errors.
- Full package suite: `yarn workspace @optimystic/db-p2p test` — **1440 passing, 41 pending
  (pre-existing skips/gated long-tests, unrelated to this change), 0 failing.**

## Known gaps / things the reviewer should sanity-check

- Tests assert via `node.getMultiaddrs()` on the announcing node itself, not via a peer's `identify`
  view of it (the ticket offered either approach; this is the cheaper of the two and doesn't require
  a second node + propagation wait). `AddressManager` is the single source both `getMultiaddrs()` and
  `identify` read from, so the cross-peer case is very likely already covered by the same fix — but
  not itself proven here. If the reviewer wants the stronger cross-peer proof, that would mean a 4th
  test dialing a sibling node and reading the sibling's peerStore entry, analogous to
  `waitForPeerStoreAddresses` in `test/util/peer-store-wait.ts`. Not implemented here since the
  ticket only asked to "pin behavior" and didn't treat cross-peer observation as a blocker — left for
  the reviewer's judgment rather than spawned as a follow-up ticket.
- No unit-level test on the assembled `libp2pOptions` object shape (the ticket's cheaper suggested
  alternative) — the addresses-object shape is fully exercised indirectly via `getMultiaddrs()`
  instead, one layer higher, but the `Libp2pInit` object itself is never inspected directly.
- `announceAddrs`/`appendAnnounceAddrs` set together was not tested (libp2p's own `AddressManagerInit`
  types allow both simultaneously — `announce` wins and `appendAnnounce` becomes a no-op on top of it,
  per libp2p's `AddressManager` construction order). Plausible but unverified against this libp2p
  version; worth a quick reviewer check if this combination matters to Sereus's use case.
