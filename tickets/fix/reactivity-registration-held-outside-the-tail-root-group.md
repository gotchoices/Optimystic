description: A machine that registers for a table's change notifications right after the commit that creates the table's log tail can have its registration recorded by a machine outside the tail's root group. No announcer then sees the registration, so the watcher gets no pushes for about 90 s, until the renewal's 3-strike failover re-registers it. Reported from Sereus (`sereus` `tickets/blocked/report-reactivity-registration-lands-outside-the-root-group`).
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/libp2p-key-network.ts (`servingCohortAt`, `assembleServingCohort`), packages/db-p2p/src/cohort-topic/host.ts (`prepareRootPlacedCoord`, `dispatchRegister`, `rootGroupMembersFor`), packages/db-p2p/src/cohort-topic/topic-router.ts (`dialRootGroup`), packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch.tick`)
----

## Symptom

Sereus scenario `packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts` (three machines, strand replication breadth 2, so exactly one machine is outside the storage group of a table's log tail). On Optimystic 1.29.0 (`e81f33e3`) and Quereus 5.6.1, its push assertion fails intermittently. Every machine watches `default/app/Data`, one machine commits, and the machine outside the tail group is not woken by push. It wakes only from its own 30 s tail read.

- 2026-11-20: 2 of 4 isolated runs failed.
- 2026-11-21: 2 of 12 failed, with a Sereus-side wait that holds the first commit until every machine names the same serving cohort for eight fixed ring coordinates.

No data is lost and no commit is missed. The cost is that, for about 90 s after a machine's first registration, change notifications reach nobody.

## What was measured (temporary probe, three instrumented runs, all reproduced it)

The probe printed each machine's registration handle, the registration records each cohort engine held at the tail's root coordinate, and each machine's `keyNetwork.servingCohortAt` of that coordinate.

- **Where the record landed.** In the failing runs, the machine that registered 0 ms after the seed commit named a root group (`p[0] + p[1]`) different from the settled one (`p[2] + p[1]`). Its record was held only by `p[0]`, outside the settled group. A machine registering on a later renewal tick, 27–30 s after the commit, named the settled group and was pushed normally.
- **The keep-alive never reached the record.** The misplaced record's `lastPing` stayed equal to its `attachedAt` for 74 s: the participant pings the primary assigned over the wrong member list, which holds no record. Meanwhile `reactivityWatch.isAttached` reports the watch as registered.
- **The repair is the 3-strike failover**, about 90 s later (`MAX_PING_FAILURES` × `ttl/3`, Core TTL 90 s): a re-attach, or a re-walk after the record has been TTL-evicted.
- **The machines agree about who serves the network.** Sampled every 300 ms across the seed commit, all three machines gave identical `servingCohortAt` answers for six fixed coordinates, and those answers never changed. So the disagreement is specific to the tail's own root coordinate.
- **Which registration goes wrong.** Registering at the instant of the seed commit is usually fine: 8 of 10 such runs pushed normally. Both failures had the same configuration. Exactly one machine registered at the seed commit, the other two registered at separate later ticks (about 27 s and 29 s), and the lone early registrant was the machine outside the tail group. That staggered pattern occurred 3 times in 12 runs, and the one where the early registrant was inside the group passed.

## Path, as read from the code

1. The cohort-topic host binds `servingCohortAt` as the root group (`rootGroup: { membersAt: rootGroupAt }` in `libp2p-node-base.ts`).
2. The registering node dials the members its own read names (`FretTopicRouter.dialRootGroup`).
3. The admitting member checks its membership with its own `snapshots.ensure(coord)` in `prepareRootPlacedCoord`. Because both sides were wrong together, the `RootPlacementRefusedError("not-member")` guard does not fire. The reply's member list becomes the handle's `cohortMembers`.
4. Pushes read `host.registry.findByCoord(reactivityRootCoord(rootTail))` on the announcing member, so a record held outside the settled group is invisible to every announcer.
5. Nothing re-validates a live registration's member list. A holder that stops being a group member keeps the record.

## Open question for this ticket

Why does the root group differ at the tail's coordinate when it does not at stable coordinates? Two candidates:
- `servingCohortAt` answers differently at a coordinate derived from a tail that has just been written.
- The registration is made against a tail that the commit then rotates, and the root coordinate moves with it.

The two candidates call for different fixes. The second needs the registration to follow the tail, or to be made after the rotation.

## Fix directions

- **Re-validate on the watch tick (recommended if the cause is a moved view).** `ReactivityCollectionWatch.tick` already runs at the renewal cadence and holds the tail. Compare the handle's `cohortMembers` (or `cohortEpoch`) with a fresh `rootGroupMembers(rootKey)` read, and call `register` again when they differ. That cuts the deaf period from about 90 s to at most one tick, for one local read per tick. A cheaper variant compares the register reply's members with a read taken after the walk returns, and retries at once.
- **Second choices:**
  - Act on the first `unknown_registration` rather than the third. This only shortens the window, and it weakens the tolerance for replication lag.
  - Have a holder that is no longer a group member hand the record over. This is correct in principle but needs a handoff path.
  - Delay registration until the view settles. The measurement shows the view is already settled, so this would not help.

## Reproduce

From Sereus: `yarn vitest run src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `packages/integration-tests`, run from `C:\Projects\sereus` (uppercase drive letter). The scenario prints `[reactivity] registered, from the seed commit:` before its assertions. A run whose lone seed-commit registrant is inside the tail group cannot fail and can be discarded. Without the fix, roughly 1 run in 6 fails.
