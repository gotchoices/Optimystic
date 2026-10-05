description: A node joining a freshly founded two-node group can adopt the founder's newer catalog revision mid-`apply schema` and then fail with a hard `Missing block`, because its cohort view is still self-only, so the read consults nobody and treats local absence as final.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (the `cluster-fetch:solo-self-skip` exit in the repair pass, and its comment that a self-only view is also what `findCluster` returns while peers are mid-identify)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster`, `membershipOf`; the strand network stays at `cohort=1 connected=0` while the same process's other network reaches 2)
  - packages/db-core/src/blocks/helpers.ts (`get` throws `Missing block`)
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `advanceContext`: adopting `readRev=3` while a schema batch is open)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (`CatalogBatch.commit`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`endSchemaBatch`)
difficulty: hard
repro: reported
severity: crash
likelihood: unusual

# A joiner reads a missing block from a self-only cohort view

GitHub issue #27: https://github.com/gotchoices/Optimystic/issues/27. Reproduced by the reporter on 1.8.1 and 1.9.0;
the issue carries a standalone `repro.mjs` (two `CadreNode`s on loopback websockets, `MemoryRawStorage`, N tables
each with one index).

## Repro (from the issue)

Stock packages almost never lose the race, because the joiner's `apply schema` runs as one microtask chain.
Inserting `await new Promise(r => setTimeout(r, 0))` after each step of Quereus's `runStepsWithUndoJournal` (which
the reporter needs so timers fire during a long apply) makes it reliable: 5 of 6 trials fail at `TABLES=100`.

Joiner trace:

```
collection:lineage-divergence id=optimystic/schema site=refresh forkRev=1 heldRev=2 readRev=3
findCluster key=… cohort=1 connected=0
cluster-fetch:solo-self-skip { blockId: 'CpS_…' }
cache miss:absent id=CpS_…
endSchemaBatch: catalog commit failed: Error: Missing block (CpS_…)
```

The founder committed that block about a second earlier at quorum `local`, cohort of one.

## Questions to settle

1. A block named by a revision this node has adopted (so known to exist) read under a self-only view: wait for the
   cohort (bounded, e.g. by `readRepairWindowMs`) or throw a retryable `BlockUnavailableError`, rather than a hard
   `Missing block`. The existence evidence is the log entry the refresh just walked, as floors already use it.
2. Whether a joiner should refrain from adopting a newer catalog revision while it holds an open schema batch.
3. Why the strand network's cohort stays at 1 for seconds on loopback while the control network forms; possibly a
   separate membership/identify ticket (related: #23 and sereus#18, cohort of one after a restart).
