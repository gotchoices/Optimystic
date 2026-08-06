description: The example peer program now has command-line flags for telling other peers a public address that differs from the one it binds, so the documented "run it behind a TLS proxy" setup can actually be completed with it.
files: packages/reference-peer/src/cli.ts, packages/reference-peer/README.md
difficulty: easy
---

# `optimystic-peer` announce-address flags

## What changed

`packages/db-p2p`'s `createLibp2pNode` already accepted `announceAddrs` / `appendAnnounceAddrs` on
`NodeOptions` (`packages/db-p2p/src/libp2p-node-base.ts:192,197`), but the reference-peer CLI never
exposed either. Design was already fully resolved by the plan ticket (flag names, forwarding
target, additive-vs-replace semantics already exist in the library) — no open question remained, so
this pass went straight from plan to implementation rather than handing off an already-decided
ticket.

Added to `withCommonPeerOptions` (`packages/reference-peer/src/cli.ts`, in the option block ending
around line 777):
- `--announce-addr <multiaddr>` — repeatable (commander `collect` pattern, `(val: string, prev:
  string[]) => prev.concat([val])`, default `[] as string[]`). Forwards to
  `announceAddrs` on the `createLibp2pNode({...})` call. An empty array is "unset" per the
  library's own semantics (matches `NodeOptions.announceAddrs` doc comment).
- `--append-announce-addr <multiaddr>` — same repeatable pattern, forwards to `appendAnnounceAddrs`.
  Per the library, this is ignored while `announceAddrs` is non-empty (i.e. while any
  `--announce-addr` is given) — not re-validated in the CLI, since the library already enforces
  the precedence.

Both are threaded through `PeerSession.startNetwork`'s `options` type
(`announceAddr?: string[]; appendAnnounceAddr?: string[];`) and passed at the `createLibp2pNode`
call site alongside the existing `relayServerInit` field.

`packages/reference-peer/README.md`'s "Browser Bootstrap (WebSocket / WSS)" recipe (originally lines
65-94) now includes `--announce-addr /dns4/bootstrap.example.com/tcp/443/wss` in the example
command, explains why it's needed (the peer's own identify/relay-reservation info otherwise still
points at the unreachable `0.0.0.0:9091` bind address), and notes `--append-announce-addr` as the
alternative when `--no-tcp` is dropped (i.e. the bootstrap also serves local TCP peers and should
keep advertising its bound address too). The full flag reference table (around line 183) gained
matching entries for both flags.

## Verification done

- `yarn build` (tsc) in `packages/reference-peer` compiles clean with the new flags and the
  `createLibp2pNode` call site changes.
- No live-network / integration check was run — no existing test in `packages/reference-peer`
  exercises CLI flag parsing or `node.getMultiaddrs()` output (the two `.spec.ts` files there cover
  diary/storage logic, not CLI wiring). Confirming that a running node actually reports the
  announced address (e.g. via `node.getMultiaddrs()` after passing `--announce-addr`) was not
  independently verified beyond reading `libp2p-node-base.ts:481-482`, which passes
  `options.announceAddrs` straight through to libp2p's `addresses.announce` — a well-established
  libp2p option, but the reference-peer's own plumbing to that point wasn't exercised end-to-end.

## Review findings

(none yet — first pass)
