description: When starting a peer-to-peer node fails partway through setup, the already-started node (with its open network connections) is left running instead of being shut down, so a failed startup can leak network resources.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts
difficulty: medium
----

Pre-existing (not introduced by `libp2p-node-base-swallowed-wiring`; surfaced during its review).

## Problem

In `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`), `await node.start()` (~line 565)
starts the libp2p node — opening transports/listeners — well before the function returns. A large
stretch of async setup runs *after* start and *before* the node is handed back to the caller:

- `keyNetwork.initFromPersistedState()` (~line 579) — reachable failure: corrupt/unreadable persisted
  state throws.
- cluster-member wiring, coordinator repo, feed subscriptions, and other construction between
  ~line 580 and the cohort-topic host activation (~line 1042).

Only three failure points stop the node before rethrowing:
- `setReputation` injection (~line 586, added by the wiring ticket),
- the two cohort-topic hard-fail blocks (~line 1042 and ~line 1071).

Every *other* throw in that stretch propagates out of `createLibp2pNodeBase` as a rejection while the
started node keeps running — open transports and listeners with no owner. The caller gets an error and
no handle, so it cannot stop the node either. Result: a leaked, started node on any startup failure
after `node.start()` outside the three guarded spots.

## Expected behavior

A failure anywhere between `await node.start()` and the successful return of `createLibp2pNodeBase`
should `await node.stop()` (which is idempotent here — the code already relies on double-stop being
safe, see the `previousStop` wrappers) before the error propagates, so a failed startup leaves nothing
running. The natural shape is a single `try { …post-start setup… } catch (err) { await node.stop(); throw err; }`
spanning the post-start body, which would also subsume the three existing ad-hoc stop-on-throw blocks.

## Why debt, not bug

Reachable but only on the error path, and pre-existing for the life of this factory — no current
deployment is known to hit it. Scoped as hardening of startup rollback, broader than the wiring
injection change that exposed it.
