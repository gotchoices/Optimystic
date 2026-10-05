description: A machine told at startup which other machine to join does not start contacting it for a full second, and during that second it believes it is alone. Anything it opens in that window that it does not find locally it creates from scratch, so a joining machine builds its own copy of the shared table catalog and the two copies collide later. Make the machine reach out at once, wait briefly for the answer, and refuse to conclude "this does not exist yet" while a machine it was told about has never answered.
prereq: a-joiner-reads-a-missing-block-from-a-self-only-cohort-view
architecture: docs/internals.md
files:
  - packages/db-p2p/src/libp2p-node-base.ts (the `bootstrap({ list: options.bootstrapNodes })` peer-discovery entry; `await node.start()`; construction of `Libp2pKeyPeerNetwork` with `networkMode`)
  - packages/db-p2p/src/libp2p-key-network.ts (`assembleServingCohortAt`, `membershipOf`, `retryCouldImprove`, `dialsInFlight`, the `networkMode` field and its NOTE)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster`: the empty-cohort exit and the "Solo-cluster short-circuit" exit; `readRepairBlock`; `flagUnconfirmedAbsence`; `AbsenceVerdict`)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableReason`), packages/db-core/src/transactor/network-transactor.ts (`get`: second-chance round for a flagged entry)
  - packages/db-p2p/test/two-node-convergence.integration.spec.ts (real two-node fixture; it waits for the mesh before opening anything, which is why it never saw this)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts (existing fixtures for the two unit-level rules)
  - docs/internals.md (the absence table and "Note the second row" under "A block read has three answers"), docs/debugging.md
  - ../sereus/packages/cadre-core/src/cadre-node.ts (`resolveCohortSeed`, `mergeStrandPeerAddrs`), ../sereus/packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`) — the downstream host; read-only from here
difficulty: hard
repro: verified
----

# A node with a bootstrap peer must not found a collection before it has heard from that peer

Split from GitHub issue #27 (https://github.com/gotchoices/Optimystic/issues/27). The read failure in that issue is ticket `a-joiner-reads-a-missing-block-from-a-self-only-cohort-view`; this ticket removes the state that read was made in.

## What was reproduced

The reporter's script (in the issue, under "repro.mjs") was run against this checkout on 2026-10-05 through the sibling `../sereus` checkout, which links to it: `@optimystic/*` 1.10.1 at HEAD `4b1fc118`, `@serfab/cadre-core` 1.12.0, `@quereus/quereus` 4.20.1, `libp2p` 3.3.11, Node 24.2.0, Windows. Command, from a scratch directory holding the script: `YIELD=1 TABLES=100 TRIALS=1 DEPS_FROM=<sereus>/packages/cadre-core DEBUG='optimystic:*' VERBOSE=1 node repro.mjs`. The Quereus yield the issue describes was applied in memory with a Node module `load` hook that inserts the one line into `runtime/emit/schema-declarative.js`, so no sibling repository was edited.

All four trials run here **passed** (no `Missing block`), and both traced trials still showed the defect this ticket is about:

```
18:39:43.347  joiner's strand node: first cohort lookup          band=1 serves=1 unknown=0 cohort=1
18:39:43.380  collection:invented id=optimystic/schema            (joiner; founder invented its own at 18:39:40.472)
18:39:43.400  commit:solo-cohort … cohortSize: 1, soleIsSelf: true, quorum: 'local'   (joiner commits catalog rev 1)
18:39:44.424  joiner's strand node: first lookup with            band=2 serves=2 cohort=2
18:39:46.099  joiner pends catalog rev 2 → founder votes: "stale revision: block optimystic/schema at rev 2, requested rev 2"
18:39:46.552  collection:lineage-divergence id=optimystic/schema site=refresh forkRev=1 … heldRev=1 readRev=2
```

The two logs are `tickets/.logs/joiner-own-catalog.repro1.log` (script as published) and `tickets/.logs/joiner-own-catalog.repro2-scoped.log` (one store per scope, see below). That directory is pruned after 14 days, so the lines above are the record.

## What the trace settles

- **The joiner invents the catalog because it asks before it has dialed anyone.** Its first header probe for `optimystic/schema` ran in the same millisecond its node finished starting. The cohort was self-only, `fetchBlockFromCluster` took the "Solo-cluster short-circuit" exit, the answer was an authoritative absent, and `Collection.createOrOpen` staged a fresh collection which was then committed at quorum `local`.
- **The self-only window is about one second on every start, on any hardware.** `createLibp2pNodeBase` registers `bootstrap({ list })` from `@libp2p/bootstrap` with no `timeout`, and that module waits `DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT` (1000 ms) before it adds the bootstrap peers to the peer store and dials them. Measured gap from the joiner node's first lookup to its first two-member cohort: 1077 ms and 1120 ms in the two traced runs. Nothing races: a joiner that opens a database inside its first second always opens it alone. The host cannot close the window either — sereus merges the seed addresses into the node's address book only after its strand database has initialized (`mergeStrandPeerAddrs` after `startStrand`).
- **The same thing happens on the control network.** Machine B was started with machine A as its bootstrap peer, and B's control node logged `collection:invented id=optimystic/schema` and a `commit:solo-cohort` about 300 ms after start, a second before it first saw A.
- **How the founder's history reached the joiner (the open question in the fix ticket).** Neither candidate. There were zero `source=connected-fallback` and zero `self-read-declined` lines, and nothing above the storage layer copied blocks. Once the joiner's cohort widened to two, its next catalog write was pended to both machines, the founder refused it as stale, and the refresh that follows a refused write read the founder's log. Block content then arrived through ordinary read-repair, which accepts the founder's higher revision because a solo commit self-signs a one-peer commit proof (`cluster-fetch:certified-selected … claimants: 1`). That is the behaviour backlog `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` describes: the higher revision wins and the other machine's revisions are dropped without comparison. Here both machines applied the same schema, so nothing visible was lost. Whether content is lost when the two differ was not tested.
- **Not reproduced: a strand network that stays at a cohort of one for the whole trial.** The reporter saw that on 1.8.1. At HEAD both strand nodes reach `cohort=2` (the joiner about 1.1 s after start, the founder at its next lookup after that). This ticket does not explain the reporter's observation; it may have been fixed between 1.8.1 and 1.10.1.
- **The published script shares one store between two databases.** Its `storage: { provider: () => storage }` returns the same `MemoryRawStorage` for every scope, where cadre-core calls the provider once per scope (control, and each strand). Both databases keep their catalog in a block named `optimystic/schema`, so in the reporter's trace each machine's strand database was reading and writing its control database's catalog block. The fork does not depend on that: with a store per scope (`provider: (scope) => …`) the joiner still invents and commits its own strand catalog, as the table above shows. Worth telling the reporter, since an application harness wired the same way has two databases overwriting one catalog.

## The rule to implement

A node built with bootstrap peers knows, from its own configuration, that other machines belong to its network. Until it has heard from them it has no basis for "this block was never created". Three changes, in the order a start-up meets them:

1. **Dial the bootstrap peers at start, not a second later.** Either pass `timeout: 0` to `bootstrap(...)`, or have `createLibp2pNodeBase` dial each bootstrap address itself right after `node.start()`. The second is preferred because it hands the next step what it needs: a per-address outcome (connected, or failed) with no dependence on a timer inside another package. A circuit address (`<relay>/p2p/<relay>/p2p-circuit/p2p/<partner>`) names the partner, the last peer id, as the peer to hear from.

2. **A cohort lookup that would come back self-only waits, once and bounded, for bootstrap contact.** In `Libp2pKeyPeerNetwork`, when the assembled cohort is self-only and a bootstrap dial is still in flight, or a bootstrap peer is connected but its protocol list has not arrived (identify not finished), await that and assemble again before answering. The wait ends at the first of: a remote serving peer is in the cohort; no bootstrap dial is in flight and no connected bootstrap peer is unidentified; a deadline. The deadline needs a default that covers a dial plus identify on the slowest supported link — derive it from the node's existing dial deadline rather than inventing a constant, and make it a node option. Once a wait has ended for a reason other than contact it is never entered again, so a node whose bootstrap peer is down pays for this at most once per process, and a node with no bootstrap peers never pays. This follows the rule `retryCouldImprove` already states: wait only on evidence available now (a dial in flight), never on configuration alone.

3. **While a configured bootstrap peer has never been heard from, a missing block is not ruled absent.** "Heard from" means its protocol list has been read at least once in this process (it classified as serving this network or as foreign), or it is a peer whose serving verdict was restored from persisted state. The key network exposes that as a yes/no (suggested: an optional `awaitingBootstrapContact()` beside `findCluster` on the interface `CoordinatorRepo` already holds). In `CoordinatorRepo.readRepairBlock`, the "nobody was asked" verdict the prerequisite ticket adds (`'unasked'`, returned by the empty-cohort and solo-self exits of `fetchBlockFromCluster`) is mapped to `flagUnconfirmedAbsence` when the key network says it is still awaiting contact, floor or no floor. The reason is the existing `'cohort-unreachable'`: its documented meaning is "this node knows of cohort members outside itself and could reach none of them", and a configured bootstrap peer that never answered is exactly that. No new reason value is needed.

Consequences, which are the expected behaviour from the fix ticket:

- `Collection.createOrOpen` and `Collection.open` already throw `BlockUnavailableError` when the header probe comes back flagged, so a joiner that cannot reach its bootstrap peer fails to open in a typed, retryable way and commits nothing. No change in db-core is expected.
- A joiner that can reach its bootstrap peer waits for it (step 2), gets a two-member cohort, consults the founder, and finds the existing collection.
- A founder (no bootstrap peers) is untouched: its self-only absences stay authoritative and its one-round `createOrOpen` probe is unchanged.
- Issue question 2 (should a joiner decline a newer catalog revision while a schema batch is open?) needs no change: with one catalog history, adopting a newer revision mid-batch and replaying staged work is the designed behaviour.
- Issue question 3: at HEAD a strand network on loopback is at a cohort of one for about a second after the joiner starts, for the reason above; after this ticket it should be a few tens of milliseconds, and nothing is decided inside that time.

## Tradeoff being accepted — record it at the code site

A node configured with a bootstrap peer that is permanently gone, and holding no persisted network state, can no longer create a collection or read a block it lacks: both fail with `'cohort-unreachable'` for as long as that peer is never heard from. Blocks it holds locally are served as before. This is the same cost `membershipOf` already accepts for a remembered peer that never returns (see its accepted-tradeoff `NOTE:`), extended from "a peer I saw before a restart" to "a peer I was configured with". The alternative — treat the view as settled once the wait in step 2 gives up — was rejected because it reproduces this ticket's fork whenever the bootstrap peer is slower than the deadline. Write an accepted-tradeoff `NOTE:` where the mapping is made, with the revisit condition: a deployment reports it cannot create collections because a configured bootstrap peer is permanently gone; the remedies are then a declared member list (backlog `feat-declared-membership-feeds-cohort-assembly`) or the host building the node without that peer.

The existing NOTE on the `networkMode` field explains why a frozen "bootstrap peers were configured" flag stopped gating the coordinator retry window (it kept paying a delay forever). This ticket does not bring that back: the delay in step 2 is bounded and paid once, and step 3 costs no time at all. Update that NOTE so the two do not read as contradicting each other.

## Scope limits

- **Writes to a collection the node already holds, made before contact, still commit alone** (`commit:solo-cohort`, quorum `local`). A restarted joiner without persisted state can still fork an existing collection that way. That is GitHub #23 / gotchoices/sereus#18 territory and is not changed here.
- **This does not reduce to `feat-declared-membership-feeds-cohort-assembly`.** A declared member list would close the same window, but strands have no authenticated per-strand serving list yet (that ticket says so), so it cannot be the fix today. If it lands later, step 3's "configured bootstrap peer never heard from" becomes "declared member never heard from" and the bootstrap-specific tracking can go.
- **Forks that already exist are not repaired**, and repair still prefers the higher revision (`debt-repair-cannot-tell-a-fork-from-a-lagging-cohort`, `6.5-partition-healing`).

## Downstream risk — measure it, do not assume

Sereus currently starts a second machine's control node with the first as bootstrap, and that node creates its whole control schema alone in its first 300 ms. After this change it will instead wait for the first machine and read the catalog and tables from it. In the traced runs the first machine did answer the second's reads before enrolment (`cluster-fetch:synced` on the second machine's control node), so this is expected to work and to remove a fork sereus has been living with, but it changes sereus's start-up order and was not run. If the first machine refuses the second's streams before enrolment, the second machine's start will now fail with `'cohort-unreachable'` where it used to succeed.

## TODO

- Write the reproducing test first, as a new case in (or beside) `packages/db-p2p/test/two-node-convergence.integration.spec.ts`: node A starts with no bootstrap peers, creates a `Tree` and commits a row; node B is created with `bootstrapNodes: [A]` and, with **no** wait for the mesh, immediately calls `Tree.createOrOpen` on the same id and writes a row. Assert B reads A's row and A reads B's, and that B's storage holds A's action at revision 1 of the header block (B never committed its own revision 1). See it fail at HEAD.
- Dial bootstrap peers at start in `createLibp2pNodeBase` and hand the per-peer outcomes to the key network; keep the `bootstrap(...)` discovery entry only if something else still needs its peer-store tagging, and say which in a comment.
- Add the bounded wait to the self-only result of `assembleServingCohortAt` (step 2) and the awaiting-contact state (step 3) to `Libp2pKeyPeerNetwork`. The constructor already takes seven positional parameters and a NOTE says to convert to an options bag before adding an eighth; do that conversion if this needs one, or reuse the `networkMode` slot.
- Map the `'unasked'` verdict in `CoordinatorRepo.readRepairBlock` (step 3), with the accepted-tradeoff `NOTE:`. Check what `NetworkTransactor.get`'s second-chance round does with this flagged entry when self is the only candidate, and that the caller ends with `BlockUnavailableError` carrying `'cohort-unreachable'` rather than a coordinator-selection error.
- Unit tests, one per rule with real branching: in `test/libp2p-key-network.spec.ts`, the wait ends on contact, on dial failure and on the deadline, and is not re-entered; in `test/coordinator-repo-absence-write-bypass.spec.ts`, a self-only absent is flagged while awaiting contact and unflagged otherwise.
- Run `yarn build`, `yarn test` for `db-core`, `db-p2p` and `quereus-plugin-optimystic`, and `yarn test:integration`. Existing specs that build a node with a bootstrap peer that is never started will now see flagged absences; decide case by case whether the spec meant a founder (drop the bootstrap peer) or is asserting the old behaviour.
- Re-run the issue's script as described under "What was reproduced" and confirm: one `collection:invented id=optimystic/schema` per database founder and none from joiners, no `collection:lineage-divergence`, and the trial still passes. Then run sereus's own suites from `../sereus` (`yarn workspace @serfab/quereus-plugin-sereus test`, and the `integration-tests` package) without editing that repository. Report the results in the review handoff whatever they are; if sereus start-up breaks, say so plainly there rather than weakening the rule.
- Update docs: in docs/internals.md, the "there was nobody to ask" row of the absence table and the "Note the second row" paragraph (a cold boot with configured bootstrap peers is no longer served as an authoritative absent), plus a sentence where node start-up is described saying bootstrap peers are dialed at start; docs/debugging.md if it lists when `'cohort-unreachable'` appears. Run `yarn lint:docs`.
- In the review handoff, state that the reporter's "cohort of one for the whole trial" was not reproduced at HEAD and is not explained, and that the shared-store detail in the published script should be passed back to the reporter on the issue (posting there is a human's call).
