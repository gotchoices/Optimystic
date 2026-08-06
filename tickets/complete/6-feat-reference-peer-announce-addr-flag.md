description: The example peer program now has command-line flags for telling other peers a public address that differs from the one it binds, so the documented "run it behind a TLS proxy" setup can actually be completed with it.
files: packages/reference-peer/src/cli.ts, packages/reference-peer/README.md, packages/reference-peer/package.json, docs/optimystic.md
difficulty: easy
---

# `optimystic-peer` announce-address flags

## What changed

`packages/db-p2p`'s `createLibp2pNode` already accepted `announceAddrs` / `appendAnnounceAddrs` on
`NodeOptions` (`packages/db-p2p/src/libp2p-node-base.ts:192,197`), but the reference-peer CLI never
exposed either. Design was already fully resolved by the plan ticket (flag names, forwarding target,
additive-vs-replace semantics already exist in the library), so that pass went straight from plan to
implementation.

Added to `withCommonPeerOptions` (`packages/reference-peer/src/cli.ts`), and so accepted by all
three commands that helper feeds — `interactive`, `service`, and `run`:

- `--announce-addr <multiaddr>` — repeatable; forwards to `announceAddrs`. Replaces the advertised
  set entirely.
- `--append-announce-addr <multiaddr>` — repeatable; forwards to `appendAnnounceAddrs`. Ignored by
  the library while `announceAddrs` is non-empty, so the CLI does not re-validate that precedence.

Both are threaded through `PeerSession.startNetwork`'s `options` type and passed at the
`createLibp2pNode` call site.

Documented in `packages/reference-peer/README.md` — the "Browser Bootstrap (WebSocket / WSS)" recipe
now uses `--announce-addr` and explains why the recipe is incomplete without it, and the flag
reference table gained both entries.

## Added during review

- **Input validation at the flag boundary.** Both flags now parse each value through
  `multiaddr()` in their commander reducer (`collectMultiaddr`, `cli.ts`) and reject bad input with
  a clean `error: option '--announce-addr <multiaddr>' argument '...' is invalid` message and exit
  code 1. Required declaring `@multiformats/multiaddr` (`^13.0.1`, matching db-core and db-p2p) as
  a direct dependency of `packages/reference-peer`. See findings for why this was not cosmetic.
- Two factually wrong README claims corrected, one doc cross-reference completed, and the
  duplicated inline commander reducer extracted to a named function.

## Verification done

- `yarn build` (tsc) in `packages/reference-peer`: clean.
- `npx eslint packages/reference-peer/src/cli.ts`: clean.
- `yarn test` in `packages/reference-peer`: 6 passing. No pre-existing failures surfaced.
- **End-to-end against the built binary** (`node dist/src/cli.js service --offline ...`), which the
  implement pass had explicitly left undone. Four cases, reading the "📡 Listening on:" banner:
  - `--announce-addr /dns4/bootstrap.example.com/tcp/443/wss` → advertises **only**
    `/dns4/bootstrap.example.com/tcp/443/wss/p2p/<id>`; the bound `0.0.0.0` ws address is gone.
  - Two `--announce-addr` flags → both advertised (repeatability confirmed).
  - `--ws-port 9391 --append-announce-addr /dns4/pub.example.com/tcp/443/wss` → all six bound
    TCP/ws addresses **plus** the public one.
  - Invalid value → clean commander error before any node is constructed (see findings).

## Review findings

### Checked

Read the implement diff (`9938b9e`) before the handoff summary. Traced the flags through all three
declaration sites (option → `startNetwork` options type → `createLibp2pNode` call) and confirmed all
three `withCommonPeerOptions` consumers pass their full parsed `options` object through. Read
libp2p's own `AddressManager.getAddressesWithMetadata()`
(`packages/db-p2p/node_modules/libp2p/dist/src/address-manager/index.js:255-285`) to check the
documented semantics against the implementation. Confirmed the empty-array-means-unset passthrough
at `libp2p-node-base.ts:481` is already pinned by `packages/db-p2p/test/announce-addrs.spec.ts:105`.
Grepped every `announce` reference across source and docs for stale claims. Ran lint, build, tests,
and the binary itself.

### Fixed in this pass (minor)

- **`packages/reference-peer/src/cli.ts` — invalid multiaddr crashed the CLI after the node was
  already up.** libp2p does not parse the announce set at construction; it parses lazily inside
  `getAddresses()`. So a malformed `--announce-addr` produced a raw `InvalidMultiaddrError` stack
  trace *after* `✅ Node started with ID:` — port already bound — naming neither the offending flag
  nor the value. Found by accident, in the most realistic way possible: running the verification
  command from Git Bash on Windows, where MSYS rewrites `/dns4/host/tcp/443/wss` into
  `C:/Program Files/Git/dns4/...` before the CLI ever sees it. That is a plain user mistake, not a
  contrived one. Fixed at the parse boundary rather than at the one call site, so it covers both
  flags and any future repeatable multiaddr option. Verified: bad input now exits 1 with a named
  error and no node is started.
- **`README.md` — "prints all listen addresses (bound, not announced)" was backwards.**
  `getMultiaddrs()` returns the *advertised* set; when announce addrs are set they replace the bound
  ones entirely. The line asserted the opposite of the behavior the new flag introduces, and the
  same value is what `--announce-file` writes. Corrected, and confirmed against a live run.
- **`README.md` — the recipe contradicted its own example.** The diff added `--announce-addr` to the
  example command but left the following prose saying "You'll see a multiaddr like
  `/ip4/0.0.0.0/tcp/9091/ws/p2p/<PEER_ID>`", which is exactly what you no longer see once the flag
  is passed. Rewrote the surrounding explanation.
- **`docs/optimystic.md:56` — incomplete cross-reference.** The sentence gives the CLI equivalent
  for `wsPort` but named only the library option names for the announce settings, in the very
  paragraph that sends the reader to the reference-peer recipe. Added both flag names.
- **`cli.ts` — duplicated inline reducer.** The two options each carried an identical anonymous
  `(val, prev) => prev.concat([val])` lambda. Extracted (and subsumed by `collectMultiaddr`).

### Filed as a ticket (major)

- **`backlog/debt-reference-peer-cli-flags-untestable.md`** — the CLI's ~20 options have no
  automated coverage at all, because `cli.ts` calls `program.parse()` at import and does not export
  its shared option builder. A flag can be declared, documented, and accepted while never reaching
  the node, with no failing test anywhere. This ticket's flags could only be verified by launching
  the binary by hand. Filed at the general level (one check covering the whole option set, so future
  flags are covered for free) rather than as a per-flag test, per the architecture-first rule; this
  ticket's flags are cited as the evidence.

### Tripwires

None recorded. The one conditional behavior worth flagging — that an empty announce array must mean
"unset" — is already both documented on `NodeOptions.announceAddrs` and pinned by an existing test,
so it needs no new note.

### Considered and declined

- **`cli.ts` is 891 lines** (`wc -l`). Large, but it is a CLI entry point whose bulk is the REPL
  command switch, it is outside this ticket's diff, and no open ticket claims the file. Splitting it
  is not this ticket's work and the size alone is not evidence of a defect.
- **Unreachable `break;` after `process.exit(0)`** (`cli.ts:685`, a TypeScript hint, not an eslint
  error). Pre-existing, cosmetic, outside the diff. Left alone.
