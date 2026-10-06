description: The change that stops a joining machine from founding its own copy of shared data also stops the sibling project sereus from starting any machine that was given another machine to join through. Sereus deliberately talks to nobody while it builds its first database, so the machine never hears from the peer it was told about and its start-up is refused. Sereus has to change before it takes this build, and someone has to decide which side moves first.
files:
  - ../sereus/packages/cadre-core/src/membership-connection-gater.ts (the "bring-up quiet period": `denyDialPeer` and `denyInboundEncryptedConnection` while `bringUpInFlight`) — outside this repository, read-only from here
  - ../sereus/packages/cadre-core/src/cadre-node.ts (where `controlNetwork.bootstrapNodes` reaches the control node; `resolveCohortSeed`, `mergeStrandPeerAddrs` for strand nodes)
  - packages/db-p2p/src/libp2p-node-base.ts (`NodeOptions.bootstrapNodes`), packages/db-p2p/src/repo/coordinator-repo.ts (`absenceFlagFor`), packages/db-p2p/src/libp2p-key-network.ts (`awaitingBootstrapContact`)
  - tickets/review/a-joiner-builds-its-own-catalog-while-its-cohort-view-is-self-only.md (the change, with the measurements)
----

**Blocked on a dependency outside this repository.** It is unblocked when sereus stops handing bootstrap peers to a node it then forbids to dial them, and a human has chosen whether Optimystic publishes the new rule before or after that sereus change.

# Sereus cannot start a machine that was given a peer to join through

## What happens

Ticket `a-joiner-builds-its-own-catalog-while-its-cohort-view-is-self-only` added a rule: a node built with `bootstrapNodes` does not conclude "this block was never created" until it has heard from each of those peers. Opening or creating a collection before then fails with `BlockUnavailableError`, reason `'cohort-unreachable'`.

Sereus starts its control node with `controlNetwork.bootstrapNodes` and then builds the control database while its connection gate refuses every connection in both directions (its documented "bring-up quiet period", in `membership-connection-gater.ts`). The node's first bootstrap dial is refused by its own gate (`DialDeniedError: The dial request is blocked by gater.allowDialPeer`), so no bootstrap peer is heard from, the first read of the table catalog is refused, and `start()` rejects.

Measured on 2026-10-05 against sereus HEAD `3e48935c` (`@serfab/cadre-core` 1.12.0) linked to this checkout, with nothing in sereus edited:

- The script from GitHub issue #27 fails at the second machine's start with `Block optimystic/schema is unavailable (cohort-unreachable)`.
- Of 19 scenario files run from `@serfab/integration-tests` (the full 64 do not finish inside ten minutes), 30 of 78 tests fail, all with that error, in 12 files: `control-bring-up-quiet-period` and the eleven that pass a non-empty bootstrap list (multi-party workflows, strand formation, circuit same-party, websocket chat, strand-addr seed, chat participants, signed write, push wake, cross-party seed, closed-strand membership, convergence stress). The other 45 files were not run.
- `@serfab/quereus-plugin-sereus` is unaffected: 156 passed.

It affects both shapes sereus uses: a second machine of the same group bootstrapping through the first, and a machine bootstrapping through another group's node used only as infrastructure. For the second shape Optimystic already does the right thing when the dial is allowed — the other group's node refuses this network's identify, that refusal counts as its answer, and the machine founds its own database about 40 ms later — but the gate refuses the dial before that can happen.

## Proposed default

Change sereus, not the rule: a node whose database sereus means to build in isolation is built with an empty `bootstrapNodes`, and sereus dials the configured peers itself once bring-up is done. Sereus already merges peer addresses into a running node for strands, so the mechanism exists.

This was tried from the outside, with a copy of the issue's script that builds the second machine's control node without a bootstrap peer and dials the first after `start()`: the trial passes, the joining machine's strand node founds no catalog of its own, no `collection:lineage-divergence` is logged, and the strand node's wait for its founder is 41 ms. So with that one change sereus keeps starting as it does today and gains the fix on strand networks.

What it does not fix: a second machine of the same group still builds its control database alone and reconciles afterwards, as it does now. Removing that needs the second machine to be authorized by the first before it builds anything, which is a sereus design question (the quiet period exists because the first machine refuses an unenrolled machine's database streams).

## Alternatives considered

- **Treat a dial the node's own gate refused as an answer.** Rejected. The refusal says nothing about what the peer holds; it reproduces the fork for exactly the host that asked for isolation.
- **Have sereus let the bootstrap dial through during bring-up.** Enough for the infrastructure shape, not for a same-group second machine: once connected, the first machine is in the cohort and refuses the newcomer's reads, which is the failure the quiet period was built to avoid.
- **A node option meaning "these are addresses to dial, not peers I must hear from."** It would let a host keep FRET seeding and the peerStore's bootstrap tag while opting out of the rule. Not built: it is a switch that turns the fix off, and the empty-list route already works. Worth reconsidering only if sereus finds it needs the seeding.

## If nothing is done

Any sereus build that picks up this Optimystic build cannot start a second machine or a machine that bootstraps through another group's node. Sereus pinned to the current published Optimystic is unaffected and keeps the fork described in issue #27.

## Reversibility

Complete on both sides. No stored data or wire format changed; the rule is three decisions made at read time, and the sereus change is where a list of addresses is passed.

## Resolution (2026-10-05)

Maintainer chose to release the rule now (Option 1). Nothing changes here; sereus builds an isolated-bring-up node with an empty `bootstrapNodes` and dials its peers after bring-up before taking this release. Stated as a breaking change in `.release-notes.pending.md`.
