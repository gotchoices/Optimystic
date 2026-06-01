----
description: Optimystic vtab/storage layer does not surface remote commits, forcing reactive Strand watchers to poll
files: packages/cadre-core/src/strand-watcher.ts (sereus), Quereus database-watchers.ts, Quereus database.ts, optimystic Quereus vtab/plugin
----
Sereus's stated goal is reactive watching of the `CadreControl.Strand` table: a node should learn about new and changed strands as they are committed, with low latency and without continuous query load. Today this goal cannot be met across nodes because the optimystic storage/sync layer does not propagate remote commits into Quereus's reactive watch machinery. As an interim workaround the Sereus-side `StrandWatcher` polls the control database every `pollInterval` (default 5000ms) — see `packages/cadre-core/src/strand-watcher.ts:38-43,104-139,154-166`, which carries the doc note "Uses polling until Optimystic supports reactive subscriptions." This yields up to ~5s detection latency and ongoing query overhead. This ticket tracks the upstream gap; the polling on the Sereus side is acceptable until this capability exists.

The root cause is at the optimystic/Quereus boundary. Quereus already provides `Database.watch` -> `WatcherManager.runPostCommit`, but post-commit watchers fire only for transactions committed through that same `Database` instance (Quereus `database-watchers.ts:151-169`; `database.ts:1716-1724`). When a remote peer writes `CadreControl.Strand` via its own `Database`/optimystic backend, this node's post-commit watchers are never triggered. The optimystic plugin/vtab also emits no change event when a backing block changes due to a remote commit or a sync that pulls in another peer's writes. Consequently there is no signal that local reactive consumers can subscribe to, and polling is the only option.

Expected behavior: the optimystic storage/sync layer surfaces remote-change notifications — when a backing block (or the collection underlying a vtab) changes due to a remote commit or sync, the optimystic Quereus vtab receives that signal and translates it into a Quereus watch invalidation. With that in place, `StrandWatcher` (and any other reactive consumer) can subscribe via the Quereus engine instead of polling, and remote strand commits are observed promptly rather than on the next poll tick.

Use case: a node hosting a cadre wants to react to strands created or updated by peers (e.g. to begin syncing, validating, or processing them) without a fixed multi-second delay and without repeatedly re-querying the control DB. More broadly, any Quereus table backed by optimystic should be able to participate in reactive watching regardless of which peer authored the committing transaction.

Key references:
- Sereus: `packages/cadre-core/src/strand-watcher.ts` (current polling implementation and the doc note describing the limitation).
- Quereus: `database-watchers.ts:151-169` and `database.ts:1716-1724` (post-commit watcher dispatch scoped to the local `Database` instance); `quereus-engine.ts` subscribe path that reactive consumers would use.
- Optimystic: the Quereus vtab/plugin and the underlying block storage/sync layer, which must originate and route remote-change notifications into vtab-level watch invalidations.

Specifications / requirements:
- A remote commit or sync that mutates an optimystic-backed collection must be detectable by the local node that has that collection open, scoped to the affected collection/block so consumers are not woken for unrelated changes.
- The optimystic Quereus vtab must be able to translate such a notification into a Quereus watch invalidation so existing `Database.watch`/subscribe consumers receive it through the normal reactive path.
- Notifications should carry enough scope (collection / key range or block identity) to support targeted invalidation rather than waking all watchers.
- The mechanism must be cross-platform (browser, node, RN) consistent with the rest of optimystic, and must not depend on the change having been authored through the local `Database` instance.
