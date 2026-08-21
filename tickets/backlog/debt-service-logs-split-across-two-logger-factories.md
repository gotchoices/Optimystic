description: Six of this package's background services write their diagnostic logs to a channel name that the debug filter our own documentation tells operators to switch on does not match, so turning that filter on silently hides them. Make it impossible to create a log channel outside the documented tree by accident.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/dispute/service.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, docs/debugging.md
difficulty: medium
tradeoffs: These are service-lifecycle and error logs rather than the per-request diagnostics people usually chase, and an operator who already knows to also set `DEBUG=db-p2p:*` sees everything today — so a maintainer could reasonably rank this below work with user-visible effects.
----

# Two logger factories in one package, only one of them inside the documented namespace

## What is wrong

`packages/db-p2p` builds `debug` log channels ("namespaces") two different ways, and only one of
them lands inside the tree the docs advertise:

- `createLogger('x')` (`src/logger.ts`) → `optimystic:db-p2p:x`. Matched by
  `DEBUG=optimystic:db-p2p:*`, the filter `docs/debugging.md` tells people to set.
- `components.logger.forComponent('db-p2p:x')` (libp2p's own factory, which adds no prefix of its
  own) → `db-p2p:x`, and `.error(...)` on that logger writes to `db-p2p:x:error`. **Neither is
  matched by `optimystic:db-p2p:*`.**

Six services still use the second form for their own logging:

| File | Namespace produced |
|---|---|
| `src/cluster/service.ts:93` | `db-p2p:cluster` |
| `src/repo/service.ts:101` | `db-p2p:repo-service` |
| `src/sync/service.ts:46` | `db-p2p:sync-service` |
| `src/dispute/service.ts:50` | `db-p2p:dispute` |
| `src/network/network-manager-service.ts:48` | `db-p2p:network-manager` |
| `src/cluster/block-transfer-service.ts:101` | `db-p2p:block-transfer` |

Two of those names collide with real `createLogger` namespaces that cover the *same* subsystem —
`optimystic:db-p2p:cluster` (`src/repo/cluster-coordinator.ts:13`) and
`optimystic:db-p2p:repo-service` (`src/repo/service.ts:14`). So `docs/debugging.md`'s
"Cluster consensus" and "Routing and redirect decisions" recipes each show a real but *partial*
view: the coordinator half appears, the service half does not, with no hint anything is missing.

## Why it matters

This is the defect class behind [gotchoices/Optimystic#12](https://github.com/gotchoices/Optimystic/issues/12),
where an outside reporter counted zero occurrences of a log line under the documented filter and
concluded the code path never executed — it had executed, under the other tree. Two tickets have
now fixed instances of it one call site at a time (`peer-address-book`'s inbound sink, and the two
`peer-address-book:*` sinks inside `ClusterService` / `RepoService`). Each fix is one line; the
trap that produces them is that an author writing a new service picks whichever factory is closest
to hand, and nothing tells them one of the two is wrong.

## What "done" looks like

Fix the class, not the six instances:

- A new log channel inside this package cannot end up outside `optimystic:db-p2p:` without the
  author going out of their way. Whether that is "`forComponent` is never called directly in this
  package" (a lint rule or a shared wrapper that takes the libp2p `Logger` shape and returns one
  rooted in our tree), or something else, is the design question this ticket exists to answer.
- Deciding what happens to libp2p `Logger` extras is part of the work: `.error` (which today
  silently forks to a `:error` sub-namespace), `.trace`, and `.enabled` are used by some of these
  services, so a wrapper has to either preserve that surface or the call sites have to stop needing
  it.
- The six namespaces above end up matched by `DEBUG=optimystic:db-p2p:*`.
- `docs/debugging.md`'s db-p2p sub-namespace table lists every namespace the package can emit; the
  table is currently a subset.

## Repro

Static — read from the code, not observed in a running system. `test/logger.spec.ts` shows the
shape of a test that would confirm it: capture under `optimystic:db-p2p:*` while exercising one of
the six services, and assert its lines appear.
