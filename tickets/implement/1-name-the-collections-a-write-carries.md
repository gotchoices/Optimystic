description: When a row is saved to a table that has a secondary index, nothing in the logs says which pieces of storage the save actually touched. A long-running bug report claims the index piece is being left out entirely, and after two investigations nobody can confirm or deny that from a log file. Add the two log lines that would settle it.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
difficulty: medium
----

# Make "which collections did this write carry?" answerable from a log

## Why this exists

A table declared with a secondary index is backed by **two or more separate Optimystic
collections**: the main table tree at the table's `collectionUri`, and one index tree per
maintained index at `<collectionUri>/index/<indexName>`. A single SQL `insert` must stage into
all of them and flush all of them.

For twelve days a downstream project (`sereus`) has reported that on a two-machine deployment
this does not happen: a row replicates fine and is found by a full scan on the sibling machine,
but every lookup routed through the secondary index comes back empty on that sibling, silently
and permanently. Their sharpest claim about the mechanism is that **the index collection is
absent from the write transaction entirely**.

That claim has never been confirmed or refuted, and it cannot be from any log this repository
currently emits. Three separate investigations have now run aground on the same wall:

- 2026-08-13 (`secondary-index-update-never-reaches-the-sibling`) — could not reproduce; filed
  two tickets that made an *unmaintained* index loud.
- 2026-08-22 — those two tickets landed; the downstream failure was re-measured unchanged, with
  nothing raised anywhere.
- 2026-08-24 (`1-two-node-index-divergence-guard-never-fires`, this ticket's parent) — see its
  findings below; still not reproducible here, on either the mock mesh or real libp2p.

Every one of those passes ended by *reading source and reasoning*. None could look at a
downstream log and say "the index collection was / was not in that commit". This ticket ends
that, and it is deliberately scoped to observability: **it fixes nothing and claims to fix
nothing.** Its value is that the next downstream run becomes decisive instead of another guess.

## What the parent investigation established (do not re-derive)

Measured, not inferred:

- **The read-repair corroboration floor is not the cause.** The parent ticket carried a
  hypothesis that a two-machine cohort can never repair a block when the deployment declares no
  cohort size (see `tickets/complete/1-repair-deadlock-is-never-named.md`). Checked directly:
  sereus declares `assumedClusterSize: 2` in *both* its control and strand cluster policies, and
  has since 2026-08-02 — twenty days before the failing measurement. The corroboration floor
  therefore relaxes to one voter and repair is possible. Ruled out.
- **The guards cannot fire on this path, and no change to them will make them fire.** The guard
  shipped by `index-maintenance-must-track-the-declared-index-set` throws when the query planner
  routes a seek into an index the table does not maintain. In the downstream symptom each machine
  *does* serve its own rows through that same seek, which proves each one maintains the index. The
  guard is correct and the condition it looks for is simply absent.
- **A forked data collection is ruled out**, by the downstream project's own control
  measurement: on the same sibling, in the same window, a primary-key descent converges while the
  secondary-index seek does not, and a full scan of the same table sees the row. A forked or
  unrepaired data collection cannot produce that shape. So this is *not* the same defect as
  `forked-control-collection-sync-livelocks` / `control-peer-row-refresh-invisible-to-third-node`,
  and the secondary-index attribution survives.
- **Still not reproducible in this repository.** A new spec (below) puts two real libp2p nodes,
  each driving its own Quereus `Database` over its own `NetworkTransactor`, against a table with a
  secondary index, under the downstream project's own cluster configuration (replication factor 16
  with `assumedClusterSize: 2`), in both a sequential-single-writer and a concurrent-both-writers
  shape. Both converge. So the trigger is **not** the mock transport, **not** write concurrency,
  **not** the cluster-size configuration, and **not** composite text primary keys.

Landed by the parent as part of that work, already in the tree:

- `packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts` —
  the plugin-layer, two-real-node instrument described above (gated on `OPTIMYSTIC_INTEGRATION=1`).
- `packages/db-p2p/test/two-node-convergence-invention-race.spec.ts` — one added case for the
  pure-**reader** arm of the collection-invention race (a node that invents a collection and then
  only ever reads it, which is the shape an index sub-collection takes on a sibling that never
  writes to the indexed table). It converges; the case exists so a change to
  `Collection.updateInternal`'s header re-probe cannot silently strand such a reader.

## What is left, and why a trace is the right next move

The differences that remain between the passing instrument in this repo and the failing
downstream run are all *host wiring*, not distributed-systems behaviour: the sibling machine opens
its database through catalog **hydration** rather than a re-declared `create table`; it runs a
write-through raw-storage cache; the two machines hold different node roles (one owner/storage, one
plain member); the index is declared through a batch schema script rather than a standalone
`create index`; and the schema has many tables rather than one.

Enumerating and re-testing that cross product from here is guesswork. Two log lines make the
downstream run itself answer the question.

## Arm 1 — name every collection a commit carries

Site: the commit path in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`, at the point where the
bridge has resolved the set of trees it is about to flush (the legacy commit sweep over
`dirtyTrees`, and the session-mode path that hands `collectionRegistry` to the coordinator). Both
modes must emit it — the downstream host runs legacy mode today, but a trace that exists in only
one mode is one more thing to disbelieve later.

One debug line per commit carrying, at minimum:

- the collection id of every collection the commit will flush, in a stable order;
- for each, whether it had staged changes or was skipped as clean (`flushDirtyTrees` already makes
  that distinction via `hasUnsyncedChanges()`);
- the count, so a truncated line is still readable.

The bar to design against: **an operator reading one downstream log line must be able to say
whether the index collection was in that commit.** That means the ids must be the real collection
ids (the same strings `openIndexTree` derives), not tree labels or array indexes.

## Arm 2 — name the index collection each maintained index resolves to

Site: `openIndexTree` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` — already
documented as the single place an index sub-collection URI is derived, which is why the trace
belongs there and nowhere else.

One debug line per index tree opened, carrying the table name, the index name as this vtab knows
it, and the derived collection URI. Once per open is enough; this is a bring-up-time fact, not a
per-write one.

This arm exists because Arm 1 alone cannot distinguish "the index collection was not in the
commit" from "both machines committed, to *different* index collections". Two machines that
resolve different index-tree ids for the same logical index would produce exactly the reported
symmetric symptom — each machine's index holding only its own rows — while leaving the main table
untouched. Nothing in this repo currently prints enough to tell those two apart, and the second is
consistent with every downstream observation. Neither is claimed here to be the cause; the point of
the pair is that one downstream run can now eliminate one of them.

## Deliberately NOT in scope

- Any behavioural change to index maintenance, the commit sweep, or the guards. If the trace
  reveals the defect, that is the *next* ticket, filed against whatever it reveals.
- Widening the guards from `index-maintenance-must-track-the-declared-index-set`. Their
  precondition is provably absent on this path (see above); making them louder cannot help.
- Reproducing the downstream host's wiring in this repository. That is a large piece of work and
  the trace may make it unnecessary.

## Logging discipline

These are `debug`-namespace lines through the package's existing `createLogger`, not warnings.
They fire on every commit and every index open, so they must be cheap when the namespace is off —
in particular, do not build the id list eagerly outside the logger call. Follow the existing
`cluster-fetch:*` naming convention in `db-p2p` for the tag shape so the two repositories' logs
read alike.

## TODO

Phase 1 — the trace

- [ ] Add the per-commit collection-set line in `txn-bridge.ts`, covering **both** the legacy
      commit sweep and the session-mode coordinator hand-off.
- [ ] Add the per-index-tree resolution line in `openIndexTree` in `optimystic-module.ts`.
- [ ] Confirm both lines are no-ops (no list construction, no string building) when the debug
      namespace is disabled.

Phase 2 — pin them

- [ ] Extend `packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts`
      (mock mesh, fast) with a case that captures the emitted lines and asserts the index
      collection id appears in the commit set for an `insert` into an indexed table. A trace that
      can silently stop being emitted is worth nothing on the run that needs it.
- [ ] Assert both nodes resolve the **same** index collection id for the same logical index.

Phase 3 — hand it downstream

- [ ] Record in the review handoff the exact debug namespace(s) to enable and what each line looks
      like, so the downstream re-run of
      `strand-formation-concurrent-redemption.integration.ts` needs no source reading to interpret
      the output.

## Validation

```
yarn lint && yarn build && yarn typecheck        # from repo root (typecheck must follow build)
yarn workspace @optimystic/quereus-plugin-optimystic test
```

The new real-libp2p instrument is integration-gated and is not in the default suite:

```
yarn workspace @optimystic/quereus-plugin-optimystic test:integration
```
