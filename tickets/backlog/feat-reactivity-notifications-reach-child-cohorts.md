description: When a collection's announcement tree grows past its root, watchers sent to the next level down are registered with groups that never receive announcements, so they only wake on their periodic check; the root needs to pass announcements down to those groups.
architecture: docs/reactivity.md#propagation
files: packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-core/src/reactivity/push-state.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/reactivity.md
tradeoffs: The root accepts `cap_promote` (64) direct subscribers before redirecting anyone, and the watch service's 30 s tail check still wakes every watcher, so this only matters for collections with more than about 64 watchers on the network; building it means designing the parent-to-child fan-out, its back-pressure and the re-link on tail rotation.
----

# Reactivity notifications reach child cohorts

A reactivity root that passes `cap_promote` direct subscribers promotes: later subscribers are redirected to tier-1 cohorts, which cold-start and link to the root over `ChildLinkV1` (the host records them in its child registry — `childCohortCount` in `packages/db-p2p/src/cohort-topic/host.ts`). But the forwarder never fans a notification out to them: `PushState.childCohorts` is never populated (the comment at `resolveChildPrimary` in `packages/db-p2p/src/libp2p-node-base.ts` says so), so `ReactivityForwarderHost`'s child loop in `packages/db-p2p/src/reactivity/forwarder-host.ts` iterates nothing. Every subscriber below the root is registered with a cohort that never hears an announcement; it wakes only on the watch service's tail check. `docs/reactivity.md` § Mock-tier e2e coverage lists the multi-tier serving fan-out as unimplemented.

## Expected behavior

- A forwarder's push state learns its child cohorts from the host's child registry (the links it already verifies and records), and fans each verified notification out to each child's primary, unmodified (forwarders never re-sign).
- A child cohort forwards to its own direct subscribers and children the same way, so a notification reaches every tier.
- **Re-link on tail rotation.** Once tiers `d ≥ 1` stop rotating (`reactivity-tiers-below-the-root-use-the-collection-anchor`), the root moves to each new tail's storage group while tier-1 cohorts stay put; a tier-1 cohort must re-link to the new root (its `ChildLinkV1` carries the root key) when it learns the tail moved, and the new root must accept the link. Where the tier-1 cohort learns of the move from is part of this design: a notification naming a new `tailId` reaches it only through the old root.
- Back-pressure and per-child queues follow § Slow-subscriber backpressure.
