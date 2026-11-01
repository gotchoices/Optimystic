description: Before sending a queued offline change, re-check its foreign keys and cross-row checks against the latest data, so a change whose parent row was deleted elsewhere fails instead of landing dangling.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#what-is-re-judged-when-an-entry-is-rebased
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, docs/offline-sync.md
difficulty: hard
tradeoffs: It is an open question whether Quereus can evaluate a table's constraints for given rows outside a statement, so this may need a Quereus API first; until then legacy mode re-judges exactly what it re-judges for two connected writers today.
----

From stage 11 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages), and the open question "Constraint re-check" in [§Open questions](../../docs/offline-sync.md#open-questions).

Before submitting an entry, re-evaluate the foreign keys and subquery CHECKs of the tables it wrote, for the rows it wrote, against the committed state plus the entry; a violation fails the entry with reason `constraint`. Once this lands, the outlook moves those decisions from `unchecked` to `exposures`. First step: find out whether the vtab can do this with today's Quereus, and if not, file the needed API in the Quereus repository.
