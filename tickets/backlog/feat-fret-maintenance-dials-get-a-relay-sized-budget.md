description: After a restart, two relay-only machines (phones) never reconnect, because FRET's maintenance ping gives its dial only 2 s and a relayed dial on a slow link takes about 9 s. Once FRET accepts a host-supplied dial budget, pass one through from the node options, so a phone that restarts can reach its partner again.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts (the `fretService({ ... })` construction; `NodeOptions`)
  - p2p-fret (outside this repo; sibling checkout `../Fret`, sereus filed `tickets/fix/maintenance-ping-dial-budget-below-a-relayed-dial` there)
----

# FRET maintenance dials get a relay-sized budget

Found by sereus (sereus-sam, 2026-10-11) while chasing sereus GH #44 (https://github.com/gotchoices/sereus/issues/44): the two phones never reconnected after restart. FRET's maintenance ping dials inside its 2 s whole-call budget; a relayed dial on a slow link takes about 9 s, so every reconnect aborted at ~2.05 s (32 attempts in 180 s, all failing in the Noise handshake). That is why the lone-written rows never reached the founder. Once the machines reconnect, delivery works (~5 s, see `complete/a-write-made-alone-names-the-members-it-is-owed-to.md`).

The fix belongs in FRET first (keep 2 s for the ping exchange; bound the dial by a host-supplied budget, or skip dialing in maintenance). This ticket is the optimystic half: when that FRET release exists, expose the budget on `NodeOptions` (or derive it from `clusterPolicy.linkRoundTripMs`, which already sizes relayed budgets) and pass it to `fretService`. Sereus would supply its `relayedDialBudgetMs`.

Blocked in effect on the FRET release; promote when it ships (and bump `p2p-fret`).
