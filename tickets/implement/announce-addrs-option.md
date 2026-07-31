description: Add a way for a node behind a router or reverse proxy to tell other peers a different address than the one it actually listens on.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/relay-address-propagation.spec.ts (pattern reference), packages/db-p2p/test/util/peer-store-wait.ts
difficulty: easy
----

# Expose libp2p's announce-address options on `NodeOptions`

## Gap

Node listens on `0.0.0.0:4001` but reachable at `mynode.example.com:4001` (port-forward /
reverse proxy / DNS front) needs to *advertise* the reachable address while *binding* the local
one. libp2p supports via `addresses.announce` / `addresses.appendAnnounce` on `Libp2pInit`
(`@libp2p/interface`'s `AddressManagerInit`). `NodeOptions` has no field for either; `addresses`
object `createLibp2pNodeBase` assembles only ever sets `listen`.

Confirmed locations (read directly, current line numbers):
- `NodeOptions` type: `packages/db-p2p/src/libp2p-node-base.ts:138`, `listenAddrs?: string[]` sits
  at line 211 — new fields go next to it.
- `listenAddrs` resolved from options at line 457.
- `addresses` object assembled at lines 477-482:
  ```ts
  const libp2pOptions: Libp2pInit = {
    ...
    addresses: {
      listen: listenAddrs
    },
    ...
  };
  ```

No supported way to reach libp2p's `AddressManager` post-construction, so this can only be fixed
here — pure passthrough, no new behavior, no risk to consumers who leave the fields unset.

## Consumer

Sereus (project built on this library) has `NetworkConfig.announceAddrs` fully plumbed through
its own config (`cadre.yaml`, env var, Docker entrypoint) but currently a no-op at the libp2p
layer for exactly this reason (its `implement/14.1-cadre-announce-addrs-upstream` ticket).

## TODO

- Add to `NodeOptions` (next to `listenAddrs` at line 211):
  ```ts
  /** Multiaddrs to advertise instead of the listen addrs (NAT / reverse proxy / DNS front). */
  announceAddrs?: string[];
  /** Multiaddrs to advertise IN ADDITION to the listen addrs. */
  appendAnnounceAddrs?: string[];
  ```
- Forward into the `addresses` block in `createLibp2pNodeBase` (lines 477-482):
  ```ts
  addresses: {
      listen: listenAddrs,
      ...(options.announceAddrs && { announce: options.announceAddrs }),
      ...(options.appendAnnounceAddrs && { appendAnnounce: options.appendAnnounceAddrs })
  }
  ```
- Add a test (new file, e.g. `packages/db-p2p/test/announce-addrs.spec.ts`) pinning behavior, real
  libp2p nodes over loopback per the `relay-address-propagation.spec.ts` pattern
  (`createLibp2pNode`, `node.getMultiaddrs()`):
  - node built with `announceAddrs` set → `getMultiaddrs()` (or a peer's identify view of it)
    reflects ONLY the announced addrs, not the listen addrs.
  - node built with `appendAnnounceAddrs` set → reflects listen addrs PLUS the appended ones.
  - node with neither set → behaves exactly as today (no `announce`/`appendAnnounce` key reaches
    `Libp2pInit`); cheapest way to pin this is a unit-level check on the assembled `libp2pOptions`
    object rather than a full node boot, if `createLibp2pNodeBase`'s internals are reachable for
    that — otherwise assert via `getMultiaddrs()` matching listen addrs only.
- Run `yarn workspace @optimystic/db-p2p test --grep "announce"` (or full suite if grep too
  narrow) and confirm no regressions.
