---
description: Our tests only ever talked to peers our own code built, so a networking mistake made everywhere at once would still pass. A test peer assembled by hand — the way an outside project would — now proves the real thing interoperates.
files: packages/db-p2p/test/foreign-peer-interop.integration.spec.ts, packages/db-p2p/docs/repo.md, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/util/peer-store-wait.ts, packages/db-p2p/test/util/protocol-ids.ts
difficulty: medium
---

Closes the test-debt ticket `debt-foreign-peer-interop-fixture`. No production behaviour changed —
this adds one integration spec plus the documentation that spec is built from.

## What shipped

**`packages/db-p2p/test/foreign-peer-interop.integration.spec.ts`** — a peer assembled by plain
`createLibp2p(...)` inside the test: real TCP, `noise()`, `yamux()`, a hand-configured `identify()`,
and one hand-registered repo stream handler. Nothing is imported from `src/` except
`createLibp2pNode` (the thing under test). Every expected protocol id is a written-out literal.

Two cases:

- **`completes identify, serves a repo request, and settles to 'serves' for a hand-built peer'`** —
  the main fixture. Five checks, in that order deliberately (fastest, most specific failure first):
  1. the outsider *negotiates* `/optimystic/<net>/id/1.0.0` by explicit dial (fails in milliseconds
     with `UnsupportedProtocolError` if the id is wrong — this is the #6 catch);
  2. the outsider dials `/optimystic/<net>/repo/1.0.0`, sends one length-prefixed JSON `RepoMessage`
     `get`, and reads back the block committed before it joined (`block.header.id`, `state.latest.rev`);
  3. identify's *payload* delivered the whole documented id set into the outsider's peerStore, and
     nothing the node advertises is malformed (`expectWellFormedProtocolIds`, now applied from
     outside the process for the first time);
  4. the node's own peerStore lists the outsider's protocols;
  5. `membershipOf` on the node's own key network settles the outsider to `serves`, polled.
- **`control: a dial on the #6-malformed repo id fails as UnsupportedProtocolError, not a timeout`** —
  proves the fixture's failure mode is diagnosable rather than a hang. Fails fast (~60 ms), so it is
  not gated behind a second env var.

**`packages/db-p2p/docs/repo.md`** — the fixture claims to be built "from the documentation", which
was only honest once the documentation was right. Added a **§ Protocol id conventions** table (all six
advertised id families, who builds each, the slash-less identify trap, and the `/db-p2p/` infix on
`sync`/`block-transfer`) and a **§ Peer classification** section (`serves`/`foreign`/`unknown`).
Corrected two stale claims: the repo protocol id was documented as `/db-p2p/repo/1.0.0` (it is
network-scoped), and `RepoMessage` still showed `cancel: { trxRef: TrxBlocks }` and no `invalidate`.

## The load-bearing evidence: does it actually catch anything?

This is the whole point of the ticket, so it was measured rather than asserted. Three mutations were
applied to `src/`, the spec re-run, and the source restored (`git diff` over `packages/db-p2p/src/`
empty after each — verified).

| Mutation | Result | Wall clock | Message |
| --- | --- | --- | --- |
| identify prefix reverted to the `#6` slash-prefixed form | **fails** | 1 s | `could not negotiate identify at the documented id /optimystic/…/id/1.0.0: UnsupportedProtocolError`, and prints the node's real list with `//optimystic/…/id/1.0.0` at the head |
| `repoService` prefix bumped (`…/<net>/v2`) | **fails** | 1 s | `could not negotiate the documented repo protocol /optimystic/…/repo/1.0.0: UnsupportedProtocolError` |
| `membershipOf`'s repo suffix changed to `/repo/2.0.0` | **fails** | 21 s | `the outsider settled to 'foreign', not 'serves'`, printing the exact peerStore list |

The first is the exact defect this fixture exists for, and it is the one the entire pre-existing
integration tier could not see.

## How to exercise it

```
# from the repo root — fans out to both workspaces (~2m19s total)
yarn test:integration

# just this package's integration tier (26 passing / 2 pending, 10 s)
yarn workspace @optimystic/db-p2p test:integration

# just this file
# PowerShell:
$env:OPTIMYSTIC_INTEGRATION=1; yarn workspace @optimystic/db-p2p test --grep "Foreign-peer interop"
# bash:
OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test --grep "Foreign-peer interop"
```

Confirmed picked up by the root glob rather than assumed: it appears first in `yarn test:integration`
output. In the default `yarn test` it self-skips on the missing env var, like its neighbours.

## Validation

| What | Result |
| --- | --- |
| `yarn lint` (root) | clean |
| `yarn build` (all workspaces) | clean |
| `yarn workspace @optimystic/db-p2p build` (`tsc` over `src` + `test`) | clean |
| Default `db-p2p` suite | **1318 passing, 40 pending, 0 failing**, 39 s |
| `db-p2p` integration tier | **26 passing, 2 pending, 0 failing**, 10 s |
| Root `yarn test:integration` (both workspaces) | **329 passing, 8 pending, 0 failing**, 2m19s |
| Mutation probes | fail as expected — table above |

Pending count moved 38 → 40 because the two new cases skip in the default suite. No pre-existing
failures were encountered, so `tickets/.pre-existing-error.md` was not written.

### Runtime, for the "is the tier still fast enough to run willingly?" question

The two new cases cost **192 ms + 59 ms** of test-body time inside the tier (plus node boot, already
counted). The `db-p2p` integration tier stayed at **10 s** going from 24 to 26 cases. Nothing here
makes the tier less likely to be run.

## Known gaps — please treat these as the starting point, not the finish line

- **Two failure paths still take ~20 s to report.** Checks 3 and 5 assert that something *arrives*
  (identify's payload; the `serves` classification), and "never arrives" is only observable by
  timeout. Both print the full expected-vs-actual protocol lists, so the diagnosis is instant once you
  read it — but the wait is real. Checks 1 and 2 were deliberately ordered ahead of them precisely so
  the common regressions fail in ~1 s instead. If the ordering is ever shuffled, that property is lost.
- **Only four of the six advertised id families are named as literals** (identify, identify/push,
  cluster, repo). `sync` and `block-transfer` are covered only by the whole-list well-formedness
  check. That was a scope call: the four named ones are the negotiation surface an integrator needs
  and the two `membershipOf` keys on. A reviewer may reasonably want the other two named too — the
  literals are in `docs/repo.md` § Protocol id conventions.
- **The foreign peer's repo handler is a no-op** (`stream => void stream.close()`). Nothing dials it;
  it exists so the peer's advertised list is not a lie, since check 5 asserts the node treats that
  advertisement as a promise to serve. Deliberate per the ticket's scope guard, but it *is* dead code
  in the strict sense — worth a second opinion.
- **The foreign peer registers `identify` but not `identifyPush`.** Its repo handler is registered
  before any connection, so the initial exchange carries it and push is not needed. The
  register-after-connect path is covered by `identify-push-propagation.spec.ts`.
- **Check 5 reaches a `private` method** (`Libp2pKeyPeerNetwork.membershipOf`) through a structural
  cast, following the precedent set by `identify-push-propagation.spec.ts`. There is no public
  surface that exposes the classification without running a full coordinator selection.
- **`responsibilityK: 8` is a test-only lever.** It forces `RepoService.checkRedirect` down its
  small-mesh bypass so check 2's response shape is deterministic rather than dependent on where FRET
  placed the cohort. Documented at the call site. If redirect behaviour is what a future reviewer
  wants covered from a foreign peer, that is a *different* assertion, not a tweak to this one.
- **`pickLocalTcpMultiaddr` is now duplicated in six spec files**, and `test/util/relay-topology.ts`
  exports a seventh variant (`pickRelayTcpAddr`) with **different** behaviour — the inline copies
  prefer `/ip4/127.0.0.1`, the util one takes the first `/tcp/` address it finds. Consolidating needs
  someone to decide which behaviour is correct and edit all six; it was left alone here rather than
  churning five files this ticket has no other business in.

## On `packages/quereus-plugin-optimystic`

**Not worth duplicating the fixture there.** Both of its node-construction paths
(`optimystic-adapter/collection-factory.ts:147`, `optimystic-adapter/key-network.ts:43`) call
`createLibp2pNode` from `@optimystic/db-p2p` — the same factory, the same protocol ids, no distinct
wire surface. A copy would re-test the same code and double the maintenance of the literal list.

There *is* an untested foreign-input seam in that package, but it is a different shape:
`registerLibp2pNode(networkName, node, coordinatedRepo)` (`collection-factory.ts:420`) accepts a
libp2p node the plugin did not build. The file already carries a `NOTE:` at line 406 that such a node
carries no identity key. That is an injected-object seam, not a foreign-peer seam, and covering it is
its own ticket if anyone wants it.
