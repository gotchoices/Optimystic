description: The optimystic vtab's collection-change → watch subscription leaks past Database close — it is released on DROP TABLE (module.destroy) but not when a Database is closed with its tables still defined. After close, every external commit drives a logged no-op (notifyExternalChange → checkOpen throws). Benign but noisy; needs a db-close / connection-close teardown hook.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../quereus/packages/quereus/src/core/database.ts
----

# optimystic vtab: release collection-change subscription on Database close

## Problem

`OptimysticVirtualTable` subscribes to optimystic collection-change notifications
once after init and bridges each into `Database.notifyExternalChange` (the reactive
watch path). The subscription is torn down in `OptimysticModule.destroy`
(DROP TABLE / module teardown) via `teardownChangeSubscription()`.

There is **no teardown on `Database.close()`**. If a consumer closes a `Database`
without first dropping its optimystic tables, the storage-side listener stays
attached to the (factory-cached, longer-lived) `StorageRepo` until the
`CollectionFactory` is garbage-collected. While it lingers, every external commit
to that collection still invokes the vtab listener →
`db.notifyExternalChange(...)` → `checkOpen()` throws → the error is caught and
logged. The result is a benign but noisy "one warning per stale listener per
commit" leak, and the listener set never shrinks for the closed db's tables.

This is the documented gap #2 from the `optimystic-vtab-reactive-watch-bridge`
implement/review pass (see `docs/internals.md` → "Reactive Watch Bridge" →
"Lifetime").

## Expected behavior

Closing a `Database` should release every collection-change subscription owned by
that database's optimystic tables, so no stale listener remains attached to the
shared `StorageRepo` and no post-close `notifyExternalChange` dispatch occurs.

## Constraints / context

- Quereus's vtab lifecycle today exposes only `connection.disconnect()` (a
  per-statement no-op in this vtab — must NOT unsubscribe there, or reactivity
  dies after the first scan) and `module.destroy` (DROP TABLE). There is no
  vtab-visible "database is closing" hook.
- A clean fix likely needs one of:
  - a Quereus-side close/teardown callback the module can register against the
    `Database`, invoked on `db.close()`; or
  - module-level tracking of which `(db, table)` subscriptions exist, torn down
    when the owning `Database` is observed closed.
- Must remain idempotent and must not double-fire with the existing
  DROP TABLE teardown.

## Out of scope

- The redundant self-wakeup behavior (separate accepted v1 limitation).
- Author-suppression of self-authored change events.
