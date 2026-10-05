description: A machine told at startup which other machine to join used to wait a full second before contacting it, and anything it opened in that second it created from scratch, so a joining machine built its own copy of the shared table catalog. It now reaches out at once, waits briefly for the answer, and refuses to conclude "this does not exist yet" while a machine it was told about has never answered. The sibling project sereus cannot start a second machine on this build until it changes its own start-up order.
prereq: a-joiner-reads-a-missing-block-from-a-self-only-cohort-view
architecture: docs/internals.md#consensus-execution
files:
  - packages/db-p2p/src/network/bootstrap-contact.ts (new: `planBootstrapTargets`, `BootstrapContactTracker`, the `BootstrapContact` interface the key network reads)
  - packages/db-p2p/src/network/identify-on-open.ts (new: `identifyOnConnectionOpen`, `IdentifyOutcome`)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.bootstrapNodes` doc, new `NodeOptions.bootstrapContactTimeoutMs`; identify built with `runOnConnectionOpen: false`; tracker built before `start()`, dialed right after; the `bootstrap(...)` discovery entry kept, with a comment saying why)
  - packages/db-p2p/src/libp2p-key-network.ts (constructor's fourth argument is now `BootstrapContactOptions`; `ServingCohort.alone`; `assembleServingCohortAt` loop; `bootstrapContactImminent`, `identifiedBootstrapPeerJoiningRing`, `nextBootstrapSignal`, `awaitingBootstrapContact`, `heardFromBootstrapPeer`; NOTE at `membershipOf`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`absenceFlagFor`, with the accepted-tradeoff NOTE; `readRepairBlock` calls it)
  - packages/db-p2p/src/rpc-deadline.ts (`LinkDeadlines.bootstrapContactTimeoutMs`, `resolveBootstrapContactTimeoutMs`)
  - packages/db-core/src/network/i-key-network.ts (optional `awaitingBootstrapContact`), packages/db-core/src/network/struct.ts (`'cohort-unreachable'` doc)
  - packages/db-p2p/test/two-node-convergence.integration.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/bootstrap-contact.spec.ts (new), packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts, packages/db-p2p/test/link-deadlines.spec.ts
  - docs/internals.md (absence table and the paragraphs under it), docs/debugging.md (two new log namespaces), docs/transactions.md, docs/optimystic.md, packages/db-p2p/readme.md (new "Joining through bootstrap peers"), packages/db-p2p/docs/cluster.md
  - tickets/blocked/sereus-cannot-start-a-machine-that-was-given-a-peer-to-join-through.md (the downstream break, filed from this ticket)
difficulty: hard
----

# A node with a bootstrap peer does not found a collection before it has heard from that peer

GitHub issue #27, second half. The first half (ticket `a-joiner-reads-a-missing-block-from-a-self-only-cohort-view`) made a read fail in a typed way; this removes the state that read was made in.

## What changed

Three rules, in the order a start-up meets them:

1. **Bootstrap peers are dialed the moment the node has started.** `BootstrapContactTracker.dial` runs right after `node.start()`. The `@libp2p/bootstrap` discovery entry is still registered: a second later it writes each bootstrap address and the `bootstrap` tag to the peerStore (FRET needs the address to re-probe a peer that was down at start; the tag protects the connection from pruning), and its own dial at that point is a no-op or one retry.
2. **A cohort assembly that finds this node alone waits, bounded, and is made again.** `assembleServingCohortAt` loops while `bootstrapContactImminent()` says a bootstrap peer is on its way: a dial or an identify exchange with one is in flight, or a connected bootstrap peer is identified as serving and FRET has not admitted it yet. The bound is `bootstrapContactTimeoutMs` (twelve link round trips, never under 10 s; a node option). The first time the wait ends without contact it is closed for the life of the process.
3. **While any configured bootstrap peer has never been heard from, a view that asked nobody does not rule a block absent.** `CoordinatorRepo.absenceFlagFor` maps the `'unasked'` verdict to `'cohort-unreachable'` when `keyNetwork.awaitingBootstrapContact()` is true. `Collection.createOrOpen` and `open` already throw `BlockUnavailableError` on a flagged header probe, so nothing changed in db-core beyond one optional interface method.

A founder (no bootstrap peers) is untouched: no wait, no flag, same one-round probe.

## Where this departs from the ticket text — please weigh each

- **"Heard from" is the identify exchange's outcome, not "the protocol list has been read".** The ticket's definition does not survive two facts about libp2p, both read from the installed source and one measured. (a) Identify here is network-namespaced, so a bootstrap peer on another network (a relay, another group's node used as infrastructure — sereus does this) never completes it; its list fills only when some other stream negotiates. Measured in this repo: a node bootstrapping through such a peer waited the whole 10 s on its first lookup, until the connection monitor's first ping. (b) libp2p adds every negotiated protocol, in either direction, to a peer's list (`connection.js`, both `newStream` and `onIncomingStream`), so a peer of *this* network shows a partial list for a moment before its identify lands, and that list reads as foreign. On loopback the moment is too short to hit; on a real link it is up to half a round trip, and acting on it would close the wait and clear the flag — the fork again. So a peer is heard from when identify answered with its list, or refused this network's identify protocol (`UnsupportedProtocolError`, the definite "not one of ours"), or its serving verdict was restored from persisted state.
- **The node now triggers identify itself.** The library's trigger discards the outcome (`.catch(() => {})`), so the node is built with `runOnConnectionOpen: false` and `identifyOnConnectionOpen` makes the same call on the same event and reports how it ended. This applies to every connection on every node, not only bootstrap peers. All existing identify-dependent specs pass (identify-push propagation, the protocol-id lock, relay and DCUtR-adjacent specs in the default tiers), but it is a wider change than the ticket described and deserves a second pair of eyes.
- **A read that carried a floor keeps `'named-by-log'`** even while awaiting contact. The ticket says "floor or no floor … the reason is `'cohort-unreachable'`"; I kept the sharper reason because it ranks higher in the transactor's merge and the documented rule is that the sharpest evidence wins. Both are flagged either way.
- **The constructor slot was reused, not converted to an options bag.** `Libp2pKeyPeerNetwork`'s fourth positional argument changed type from the mode string to `BootstrapContactOptions`, so every spec passing `'forming'` now passes `undefined` (about 100 call sites, mechanical). The `mode=` label in the `retry-futile` log line is derived from it.
- **Any unheard peer keeps the node awaiting**, as the ticket words it. With a list of several bootstrap peers one of which is permanently gone, a node that is alone in its view, or runs `clusterSize: 1`, cannot create collections until that entry is removed. I considered "one serving peer heard is enough" and did not adopt it: with `clusterSize: 1` it reopens the window for a block whose true holder is the unheard peer. Worth a decision rather than a default.

## Tests added

- `two-node-convergence.integration.spec.ts`
  - "a joiner that opens a collection the moment it starts finds the founder's, not its own": the reproduction. B is created with A as bootstrap and opens the tree with no mesh wait; both read each other's rows and B holds A's action at revision 1 of the header block. Failed at HEAD (B read `undefined` for A's row); passes in about 100 ms.
  - "a joiner whose bootstrap peer never answers refuses to found a collection": `createOrOpen` rejects with `BlockUnavailableError('cohort-unreachable')` and nothing is committed. Failed at HEAD (it founded). This also answers the ticket's question about the transactor's second-chance round with self as the only candidate: the retry's coordinator lookup fails, the flagged entry from the first round survives the merge, and the caller gets the typed error, not a coordinator-selection error.
  - "a node that bootstraps through a peer on another network founds its collection without waiting out the deadline": 10 008 ms before identify outcomes were observed, about 40 ms after.
- `libp2p-key-network.spec.ts` → "bootstrap contact": the wait holds through identify in flight and through identified-but-not-yet-in-the-ring, then answers with the peer in the cohort; a refused identify ends it and the peer is no longer awaited; a failed dial ends it, leaves the peer awaited, and it is not re-entered; the deadline ends it and it is not re-entered; a connection and a serving-looking protocol list are not an answer; a restored serving verdict is.
- `coordinator-repo-absence-write-bypass.spec.ts`: a self-only absent is `'cohort-unreachable'` while awaiting, `'named-by-log'` with a floor, and authoritative once heard.
- `bootstrap-contact.spec.ts` (new): a circuit address names the partner, not the relay; this node itself is never a peer to hear from; a failed exchange is no answer and the first answer stands; identify outcomes are told apart (completed, refused, failed).
- Removed: the two "networkMode defaults" cases, which tested a constructor default that no longer exists. `link-deadlines.spec.ts` gained the new field in its expected objects.

## Validation run (2026-10-05, Windows, Node 24.2.0)

- `yarn lint`, `yarn lint:docs`, `yarn lint:deps`, `yarn build`, `yarn typecheck`, `yarn check:rn`: clean.
- db-core `yarn test`: 1861 passing. db-p2p: 3215 passing, 68 pending, 0 failing. quereus-plugin-optimystic: 1001 passing, 14 pending.
- `yarn test:integration`: db-p2p 49 passing, 2 pending; quereus-plugin-optimystic 1007 passing, 8 pending. The integration run was made before two comment-only edits and the new unit spec file; nothing it exercises changed after it.
- No existing spec failed on the new flag, so none needed the ticket's "founder or old behaviour" decision.

## Downstream: sereus start-up breaks

Run against the sibling `../sereus` checkout (HEAD `3e48935c`, `@serfab/cadre-core` 1.12.0), which links to this one. Nothing there was edited.

- **The reporter's script, one store per scope, now fails at the second machine's start**: `Block optimystic/schema is unavailable (cohort-unreachable)`. The log shows why: `bootstrap-contact dial:failed … DialDeniedError: The dial request is blocked by gater.allowDialPeer`. Sereus's own connection gate refuses every dial while its control database is being built (its "bring-up quiet period"), so the node never hears from the peer it was configured with, and the catalog read is refused. This is the risk the ticket named, in a stronger form: sereus builds that database in isolation on purpose.
- **`@serfab/quereus-plugin-sereus`**: 12 files, 156 passed, 1 todo.
- **`@serfab/integration-tests`**: the suite is 64 files run one at a time and did not finish inside ten minutes, so it was run in batches covering 19 files. Batch one (strand creation, second-machine membership, two-party two-machine, happy path, basic connectivity, enrollment, two-node control convergence, bring-up quiet period): 25 passed, 1 failed (`control-bring-up-quiet-period`). Batch two, the scenarios that configure bootstrap peers (multi-party workflows, strand formation, circuit same-party, websocket chat, strand-addr seed, chat participants, signed write, push wake, cross-party seed, closed-strand membership, convergence stress): 23 passed, 29 failed, every failure the same `cohort-unreachable` on `optimystic/schema`. Two traced failures show the same gate denial. The other 45 files were not run.
- **With the control node built without a bootstrap peer and dialed after start** (a variant of the script, standing in for a host that has adapted): the trial passes; `collection:invented id=optimystic/schema` appears once per database founder and not at all from the joiner's strand node; no `collection:lineage-divergence`; the joiner's strand node made no solo commit. Its first lookup found it alone at 19:55:08.187 and its first two-member cohort came at .228 — 41 ms, against 1077 and 1120 ms before.

The rule was not weakened to make sereus pass. `tickets/blocked/sereus-cannot-start-a-machine-that-was-given-a-peer-to-join-through.md` carries the proposal for the human who decides the order of releases.

## Known gaps

- The reporter's script exactly as published (one store shared by both databases) was not re-run; it would stop at the same start-up refusal.
- The partial-protocol-list window (departure one, part b) is established from libp2p's source and pinned by a unit test with a fake; no test puts latency on a real link to hit it.
- No integration test bootstraps through a real circuit address. The planning rule is unit-tested, and the existing relay lifecycle spec passes.
- `resolveBootstrapContactTimeoutMs` has no test of its refusal of a bad value.
- Two tripwires are parked as `NOTE:`s in `libp2p-key-network.ts`: at `identifiedBootstrapPeerJoiningRing` (a peer FRET never admits holds one lookup to the deadline, once) and at `membershipOf` (the partial-list reading, which still affects ordinary cohort assembly for one reading).
- Scope limits from the ticket stand: a write to a collection the node already holds, made before contact, still commits alone; existing forks are not repaired.

## For the reporter (posting is a human's call)

- The "cohort of one for the whole trial" seen on 1.8.1 was not reproduced at HEAD and is not explained by this work.
- The published script hands one `MemoryRawStorage` to every scope, so its control and strand databases share a catalog block. The fork does not depend on that, but an application wired the same way has two databases overwriting one catalog.
