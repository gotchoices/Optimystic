description: A node behind a router, reverse proxy, or DNS front can now tell other peers a different address than the one it actually listens on.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/announce-addrs.spec.ts, packages/db-p2p/readme.md, docs/optimystic.md
----

# Expose libp2p's announce-address options on `NodeOptions` — complete

## What shipped

`NodeOptions` (`packages/db-p2p/src/libp2p-node-base.ts`) gained two optional fields next to
`listenAddrs`:

- `announceAddrs?: string[]` — advertise these **instead of** the bound addresses.
- `appendAnnounceAddrs?: string[]` — advertise these **in addition to** them.

`createLibp2pNodeBase` spreads them into the `addresses` block of the `Libp2pInit` it passes to
`createLibp2p`, each only when set — a straight passthrough to libp2p's `AddressManagerInit`. With
neither set, the assembled object is `{ listen: listenAddrs }`, identical to pre-change behavior.

Covered by `packages/db-p2p/test/announce-addrs.spec.ts`: five cases against real libp2p nodes over
loopback (neither option, `announceAddrs` alone, `appendAnnounceAddrs` alone, both together, both as
empty arrays).

## Review findings

### Verified, no defect

- **Passthrough correctness against the installed libp2p.** Read
  `libp2p/dist/src/address-manager/index.js`. `getAddressesWithMetadata` returns the announce set
  verbatim and returns early when it is non-empty, so `announce` genuinely replaces observed,
  relayed and appended addresses; `appendAnnounce` is concatenated onto the transport addresses only
  on the non-early-return path. The implementation's precedence claim holds for this version.
- **Empty-array handling.** `options.announceAddrs ? …` is truthy for `[]`, so `announce: []` can
  reach libp2p. Harmless: libp2p's constructor spreads it into an empty `Set` and its length check
  treats it exactly like the absent key. Not a defect, but it was undocumented and untested — see
  fixes below.
- **Cross-peer (identify) view, flagged as unproven by the implementer.** `libp2p.getMultiaddrs()`
  is `addressManager.getAddresses()` (`libp2p/dist/src/libp2p.js:247`) and `@libp2p/identify` pushes
  `addressManager.getAddresses()` (`identify.js:118`) — one source, read by both. A fourth test
  dialing a sibling node would re-prove libp2p's own plumbing, not this change, so it was not added.
- **Invalid multiaddr strings.** `getAnnounceAddrs()` parses lazily via `multiaddr(a)`, but that
  runs during node start (self-record publication), so a malformed announce address fails at start
  rather than silently later. No deferred-failure hazard; nothing added.
- **React Native entrypoint** (`libp2p-node-rn.ts`) re-exports the same `NodeOptions` and needs no
  change.

### Fixed in this pass (minor)

- **Undocumented precedence.** `announceAddrs`' doc comment did not say it drops observed/relayed
  addresses and overrides `appendAnnounceAddrs`; a caller setting both would reasonably expect a
  union. Both doc comments now state the precedence and the empty-array-means-unset semantics.
- **Two untested behaviors that the docs now assert.** Added specs for both options set together
  (`announceAddrs` wins, appended address absent) and for both set to empty arrays (behaves as
  unset). Both pass — closing the implementer's own "plausible but unverified" gap.
- **Public API undocumented.** `packages/db-p2p/readme.md` § Libp2p Integration documents comparable
  `NodeOptions` (e.g. `authorizeInboundStream`) but had nothing on announcing; added a short
  subsection with an example and the precedence rule.
- **`docs/optimystic.md` described the exact use case without the fix.** Its WebSocket-bootstrap
  paragraph says a production bootstrap is "fronted by a TLS-terminating proxy and reached by clients
  as `/dns4/<host>/tcp/443/wss/p2p/<id>`" — a bind-one-advertise-another setup — but said nothing
  about advertising it. Added a sentence pointing at the new options.

### Filed as a ticket (major, out of this ticket's scope)

- `backlog/feat-reference-peer-announce-addr-flag` — the reference-peer CLI has no announce flag, so
  its own README "Browser Bootstrap (WebSocket / WSS)" recipe (run the peer behind Caddy, hand
  browsers a `wss` dns4 address) cannot be completed with the CLI: the peer still advertises the
  address it bound. The library layer is now capable; only the CLI option and the
  `createLibp2pNode({ … })` call site in `packages/reference-peer/src/cli.ts` are missing. The
  README was deliberately left alone — documenting a flag that does not exist would be worse than
  the current silence.

### Tripwires (recorded, not ticketed)

- libp2p's `AddressManagerInit` also carries `noAnnounce` (suppress one specific advertised address)
  and `announceFilter`; neither is exposed and no consumer has asked. Parked as a `NOTE:` comment on
  the `addresses` block in `libp2p-node-base.ts` next to where they would be added, and mentioned
  under "Not in scope" in the reference-peer ticket.

### Categories with nothing to report

- **Resource cleanup** — the spec's `afterEach` nulls its handle before `stop()`, so a failed stop
  cannot leak the node into the next test; nothing else allocates.
- **Source hygiene** — the production change is 5 lines of passthrough inside an existing options
  object; no function grew, no file needs splitting (`libp2p-node-base.ts` was already large before
  this change and this ticket does not move that needle).
- **Type safety / `any`** — no casts introduced; the `addresses` object stays fully typed as part of
  `Libp2pInit`.
- **Error handling** — there is no failure path to handle: the option is forwarded or absent.

## Validation

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test --grep "NodeOptions announce address passthrough"` — 5/5
  passing (156ms).
- `yarn workspace @optimystic/db-p2p test` (full package suite) — **1442 passing, 41 pending
  (pre-existing env-gated skips), 0 failing.**
- `yarn lint` (repo-wide `eslint .`) — clean.
