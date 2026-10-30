description: A machine that serves many groups sends each other member one separately signed status message per group, so the receiver checks one signature per watched table. Combining everything headed to the same machine in one round into a single signed message would make the cost one signature check per round, however many tables are watched.
prereq: cohort-gossip-sends-a-frame-only-when-something-changed, cohort-gossip-is-verified-once-off-the-synchronous-path
architecture: docs/cohort-topic.md#cohort-gossip
files: packages/db-p2p/src/cohort-topic/host.ts (`driveTick`, `gossipRound`, `signAndBroadcast`, the `protocols.gossip` handler), packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (`broadcast`, `deliver`), packages/db-core/src/cohort-topic/wire/ (the `CohortGossipV1` codec and `cohortGossipSigningPayload`), packages/db-p2p/src/cohort-topic/protocols.ts
tradeoffs: It changes the cohort-gossip wire format, so it needs a new protocol id or a version field plus a fallback for members on older builds, and once the two prerequisite tickets land each engine sends only about one frame per ping interval, so the remaining saving is mostly for a machine watching dozens of tables on a phone without native signature checks.
----
# Cohort gossip: one frame per peer per round

GitHub [#49](https://github.com/gotchoices/Optimystic/issues/49), the reporter's second remedy. Parked by the plan `feat-idle-cohort-gossip-costs-a-phone-little`. Its other two remedies became the implement tickets named in `prereq:`.

## Current shape

The host's gossip tick (`driveTick` in `packages/db-p2p/src/cohort-topic/host.ts`) runs `gossipRound` for each coord engine, one per served coord. Each engine that has something to send builds its own `CohortGossipV1`, signs it with the node key, and broadcasts it to the cohort around its coord (`FretCohortGossipTransport.broadcast`). Every frame is a separate stream and a separate signature check at every receiver. A node watching N tables, in a group where every machine is in every table's cohort, sends each other member up to N frames per round.

## What to build

In each tick, collect the frames from every engine that is due, group them by destination peer (the union of the cohorts they go to), and send each peer one envelope. The envelope carries the per-coord frame bodies and one signature over the whole envelope. The receiver verifies once and then routes each body by its `coord`, as single frames are routed today. Each body's sender binding (`fromMember`) and per-coord membership check stay as they are.

Expected behaviour:

- One signature, one stream and one verify per (sender, receiver, round), whatever the number of coords.
- The per-coord merge semantics stay exactly as they are: epoch matching, last-writer-wins keys, child deltas.
- A member on an older build keeps receiving single frames. Detect support through identify (whether the peer lists the new protocol id) and fall back per peer.

## Measured motivation

In the reported case (18 watched tables, two members), each party received 108 frames per 30 s on 1.19.0, each verified at about 40 ms on a Galaxy S7. After the two prerequisite tickets the expected rate is roughly one frame per engine per ping interval: about 18 per 30 s, an estimate not yet measured. This ticket would bring that to at most one per gossip round per peer, about 6 per 30 s at the 5 s round, and fewer when rounds are quiet. Measure after the prerequisites land before promoting: if a native verifier is present on the target phones, the remaining cost may not justify a wire change.
