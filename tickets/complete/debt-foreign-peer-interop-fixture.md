---
description: Our tests only ever talked to peers our own code built, so a networking mistake made everywhere at once would still pass. A test peer assembled by hand — the way an outside project would — now proves the real thing interoperates.
files: packages/db-p2p/test/foreign-peer-interop.integration.spec.ts, packages/db-p2p/test/util/multiaddrs.ts, packages/db-p2p/docs/repo.md, packages/db-p2p/readme.md, docs/architecture.md
difficulty: medium
---

Completed. No production behaviour changed: this is one integration spec, one shared test helper, and
the documentation corrections that spec is built from.

## What shipped

**`packages/db-p2p/test/foreign-peer-interop.integration.spec.ts`** — a peer assembled by plain
`createLibp2p(...)` inside the test: real TCP, `noise()`, `yamux()`, a hand-configured `identify()`,
and one hand-registered repo stream handler. Nothing is imported from `src/` except
`createLibp2pNode` (the thing under test). Every expected protocol id is a written-out literal, so
the expectation cannot be derived from the code it is checking.

Three cases:

- **the main fixture** — the outsider negotiates `/optimystic/<net>/id/1.0.0` by explicit dial, then
  dials `/optimystic/<net>/repo/1.0.0` and reads back a block committed before it joined; then
  identify's payload is checked to have delivered the documented id set into the outsider's peer
  store, the node's own peer store is checked to list the outsider's protocols, and the outsider is
  checked to settle to the `serves` classification. Ordered fastest-failure-first deliberately.
- **`serves` negative control** (added in review) — the same hand-built peer minus its repo handler
  must settle to `foreign`, not `serves`.
- **malformed-id control** — a dial on the doubled-slash repo id fails as `UnsupportedProtocolError`
  in ~70 ms, proving the fixture's failure mode is a named error rather than a hang.

**`packages/db-p2p/test/util/multiaddrs.ts`** (added in review) — the `pickLocalTcpMultiaddr` helper
that five specs each had a private copy of.

**Documentation** — `packages/db-p2p/docs/repo.md` gained a **§ Protocol id conventions** table (every
advertised id family, who builds each, the slash-less identify trap, the `/db-p2p/` infix on
`sync`/`block-transfer`, and which ids are *not* network-scoped) and a **§ Peer classification**
section (`serves` / `foreign` / `unknown`). Stale claims about the repo protocol id and the
`RepoMessage` shape were corrected here, in `packages/db-p2p/readme.md`, and in `docs/architecture.md`.

## Evidence the fixture catches anything

Verified independently during review, not taken on the implementer's word. The identify prefix in
`packages/db-p2p/src/libp2p-node-base.ts` was reverted to the slash-prefixed form that shipped as
[gotchoices/Optimystic#6](https://github.com/gotchoices/Optimystic/issues/6), the spec re-run, and the
source restored (`git status` clean afterwards — confirmed). It failed in **1 second** with:

```
a foreign peer could not negotiate identify at the documented id
/optimystic/foreign-peer-interop-it/id/1.0.0: UnsupportedProtocolError …
The node advertises: ["//optimystic/foreign-peer-interop-it/id/1.0.0", …]
```

That is the exact defect the whole pre-existing integration tier passed through unnoticed. The
implementer's two further mutation probes (repo prefix bumped; `membershipOf`'s repo suffix changed)
were reported as failing at 1 s and 21 s respectively and were not re-run in review.

## Review findings

### Checked and clean

- **The load-bearing claim.** Re-ran the #6 mutation independently; the fixture catches it. Source
  restored and verified clean.
- **Every documented protocol id against its builder in `src/`.** The `sync` and `block-transfer`
  `/db-p2p/` infix, the identify slash asymmetry, and the network scoping are all as documented.
- **`membershipOf`'s classification rules** (`packages/db-p2p/src/libp2p-key-network.ts:768`) against
  the new § Peer classification section — accurate.
- **The "one request per stream" claim** against `RepoService.handleIncomingStream` — accurate; the
  generator returns after the first response.
- **`responsibilityK: 8` in the fixture** against `RepoService.checkRedirect` — the small-mesh bypass
  triggers as claimed (`cluster.length < responsibilityK`), so the round-trip assertion is
  deterministic rather than dependent on cohort placement.
- **The `RepoMessage` type** in `packages/db-core/src/network/repo-protocol.ts` against the corrected
  documentation — matches.
- **Resource cleanup, error paths, timeout handling** in the new spec — both nodes stopped in
  `afterEach`, every wait bounded, every failure path throwing a named error with the expected and
  actual protocol lists printed.
- **Comment density.** High (roughly 40% of the file), but consistent with its neighbours
  (`test/util/peer-store-wait.ts`, `src/libp2p-node-base.ts`) — this repository documents wire-format
  reasoning at length by convention. No change.

### Found and fixed in this pass

- **The documented id table was incomplete.** It omitted the five FRET routing ids
  (`/optimystic/<network>/fret/1.0.0/{ping,neighbors,neighbors/announce,maybeAct,leave}`), which a
  node genuinely advertises — discovered from the real advertised list printed by the mutation run.
  It also stated "every id is network-scoped", which is false: the stock libp2p ids (`/ipfs/ping/1.0.0`,
  `/meshsub/…`, `/libp2p/dcutr`, …) keep their upstream form, so two different Optimystic networks
  can still ping and gossip each other. Both corrected, and the spec's header comment brought in line.
- **Four stale copies of the wrong repo protocol id survived in the very file the ticket corrected.**
  `packages/db-p2p/docs/repo.md` still said `/db-p2p/repo/1.0.0` at four other places (the RepoService
  protocol details, its implementation snippet, and two configuration examples), plus
  `packages/db-p2p/readme.md` (2) and `docs/architecture.md` (1). All corrected; the examples now show
  `protocolPrefix` because that is how the id is actually built.
- **`cancel(trxRef: TrxBlocks)` in the same file** — the real signature is
  `cancel(actionRef: ActionBlocks)`. Corrected.
- **`invalidate` was documented into `RepoMessage` without saying the repo service never handles it.**
  It arrives only through cluster consensus; `RepoService` dispatches `get`/`pend`/`cancel`/`commit`.
  Sending it on the repo protocol produces no meaningful response. Now stated.
- **The `serves` assertion was vacuously satisfiable.** `membershipOf` returns `serves`
  unconditionally when no `protocolPrefix` is configured, so a build that lost network scoping
  entirely would still have passed the fixture's headline assertion. Added a negative control: the
  same hand-built peer *without* the repo handler must settle to `foreign`. Polls for the reached
  state rather than asserting immediately, because the peer passes through `unknown` first.
- **`pickLocalTcpMultiaddr` was copy-pasted into five specs.** The implementer flagged it (as six —
  it was five, four named functions plus one nested copy) and deferred it because the copies had
  drifted. Made the call: the loopback-preferred-with-fallback form is the correct one and a superset
  of the new spec's stricter variant, so it moved to `packages/db-p2p/test/util/multiaddrs.ts` and all
  five call sites now import it. `pickRelayTcpAddr` in `test/util/relay-topology.ts` is deliberately
  *not* folded in — it excludes WebSocket and circuit addresses and returns a `Multiaddr`, which is a
  different function wearing a similar name; the new helper's docblock says so.

### Filed as a new ticket

- **`backlog/debt-docs-stale-transaction-naming`** — the `trx` → `action` rename finished in the
  source but left roughly eighteen stale references across seven markdown files. Only the occurrences
  inside the files this ticket already touched were fixed here; sweeping the rest is a bounded
  documentation pass that does not belong in a test ticket.

### Considered and deliberately not filed

- **The `quereus-plugin-optimystic` injected-node seam** (`registerLibp2pNode`, `collection-factory.ts`).
  The implementer raised it as possible follow-up work. On inspection its own docblock says it exists
  so *tests* can inject pre-created nodes — it is not a consumer-facing integration path, and the one
  real caveat (an injected node carries no identity key, so signing silently disables) is already
  documented in a `NOTE:` at the site. No ticket, no new tripwire: the concern is already parked where
  a reader meets it.
- **The implementer's own listed gaps** — the ~20 s worst-case failure reporting on the two
  arrival-based checks, `sync`/`block-transfer` not named as literals, and the deliberately inert
  foreign repo handler. All three are correct as designed and argued for in the spec's own comments;
  the first is inherent to asserting that something arrives, and the ordering that keeps the common
  regressions at ~1 s is documented at the site.

### Tripwires

None recorded. Nothing found in this pass was of the "fine now, becomes work if X happens later"
shape — the findings were either wrong today (and fixed) or genuinely out of scope (and ticketed).

## Validation

| What | Result |
| --- | --- |
| `yarn lint` (root) | clean |
| `yarn build` (all workspaces) | clean |
| `yarn workspace @optimystic/db-p2p build` (`tsc` over `src` + `test`) | clean |
| Default `db-p2p` suite | **1318 passing, 41 pending, 0 failing**, 45 s |
| `db-p2p` integration tier | **27 passing, 2 pending, 0 failing**, 10 s |
| Root `yarn test:integration` (both workspaces) | **26 + 329 passing, 11 pending, 0 failing**, 2m |
| #6 mutation probe | fails in 1 s with a named negotiation error |

Pending counts move by one against the implement-stage numbers because the review added one more
case that self-skips in the default suite.

`test:integration` reports the db-p2p tier as either 27/2 or 26/3 between runs. That is not flake:
`multi-coordinator-write-relay.integration.spec.ts` probes 24 candidate block ids for one whose cohort
includes the relay-only coordinator, and calls `this.skip()` when random per-run peer ids place none
of them there — a deliberate skip-rather-than-assert-vacuously guard that predates this ticket.

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not written.

## How to exercise it

```
# from the repo root — fans out to both workspaces (~2m)
yarn test:integration

# just this package's integration tier (27 passing / 2 pending, 10 s)
yarn workspace @optimystic/db-p2p test:integration

# just this file
# PowerShell:
$env:OPTIMYSTIC_INTEGRATION=1; yarn workspace @optimystic/db-p2p test --grep "Foreign-peer"
# bash:
OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test --grep "Foreign-peer"
```

In the default `yarn test` it self-skips on the missing environment variable, like its neighbours.
