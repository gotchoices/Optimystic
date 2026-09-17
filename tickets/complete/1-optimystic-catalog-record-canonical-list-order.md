description: A table's catalog record now lists its indexes and CHECK rules in name order, so two machines that end at the same schema version store identical bytes no matter which earlier versions they went through.
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`canonicalizeRecordOrder`, `sortByName`, `compareOptionalNames`; called at the end of `mergePersistedSchemas` and around the return of `tableSchemaToStored`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (connect-time comment, ~L653)
  - packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-catalog-write-path.spec.ts
  - packages/quereus-plugin-optimystic/README.md
----

# What landed

The optimystic plugin keeps one catalog record per table. Before this change, the lists in it whose order carries no meaning followed creation order. So a machine that gained an index through a later schema version stored different bytes than a machine that applied the final version fresh. A downstream host writes that record on every machine before it contacts any peer, so the bytes must match.

`canonicalizeRecordOrder` sorts `indexes` and `orphanedIndexes` by name, and `checkConstraints` by name with unnamed entries first in their original order. Names are compared by UTF-16 code unit, never by locale, and ties fall back to original position. It runs on every record a write produces (the end of `mergePersistedSchemas`, which covers `storeStoredSchema`, the APPLY SCHEMA batch and `mergeWithPersisted`) and on every candidate built from a live table (`tableSchemaToStored`). A hydrated table therefore lists its indexes and CHECKs by name. A `NOTE:` on the helper records the accepted consequence: when two indexes cost the same, the planner may pick a different but equally good one, and when a row breaks several CHECKs a different one may be reported. Neither changes a result.

Tests: a migration property test (12 earlier index versions, each checked for identical bytes against a fresh apply; it was confirmed to fail without the fix), a hydrate-after-migration guard, and unit tests for the write path and for building a record from a live table.

# Review findings

Checked: I read the implement diff (`2cd079c2`) before the handoff notes. I traced every catalog write path (`storeStoredSchema`, the batched write, `mergeWithPersisted`, and `addIndex`'s two writes in `optimystic-module.ts` ~L2869–2931) to confirm each one goes through `mergePersistedSchemas`, and none returns early before the sort. I checked whether anything uses a list entry's position: index columns are addressed by column position, not by index position; `IndexManager` and index trees are keyed by name; `storedToUniqueConstraints` depends only on names. I also read the tests and README, and searched `docs/` for text that describes catalog list order (there is none).

- **Correctness:** No defects found. The sort keeps existing keys in place (spreading onto `record` preserves key order), so it adds no key and changes no JSON key order. Absent or undefined lists are left as they are.
- **Unique-constraint order (the implementer's open question):** No issue. `tableSchemaToStored` persists only the unique constraints that don't come from an index, and those can only come from one declaration. The ones derived from indexes are rebuilt when read and never persisted, so their order can't affect the record's bytes. The only effect is on the in-memory order of a hydrated table's list, which changes no enforcement. No action.
- **Other lists whose order is meaningless (`foreignKeys`, `mutationContext`, stored `uniqueConstraints`):** Not sorted. That's correct for now: this plugin has no ALTER TABLE, so a later version can't add to them on an existing table. CHECKs are the known exception, and `optimystic-alter-add-check-persists` (in implement, with this ticket as its prereq) already carries the CHECK arm of the migration property. No new ticket or tripwire, since that ticket owns the site.
- **Docs:** The README described the change but didn't say that older records keep their order until they are written again. I fixed that inline: one clause added to the session-binding paragraph. `docs/` has no text about catalog list order, so nothing else was out of date.
- **Tests:** Good coverage. The one-time connect-time miss on an older, unsorted record is documented in a comment but has no test. I didn't add one: the cost is a single rewrite that converges, and the write-path unit test already checks that an unsorted persisted record comes back sorted. Not worth a ticket.
- **Code-unit vs code-point order:** Accepted as implemented. Either order is deterministic on every machine, which is all the requirement needs, and the comment names the order it actually uses.
- **Gravestones (records of dropped tables) not re-sorted:** No action. They carry a `droppedAt` timestamp, so they were never byte-identical across machines.
- **Source hygiene / performance / error handling / type safety:** Each helper is small and named, and its comments explain why rather than narrate. The sort costs O(n log n) over a handful of entries on schema writes only. It adds no error paths. The `as T` cast is limited to the spread-return pattern and is sound for both record shapes.

Validation: in `packages/quereus-plugin-optimystic`, `yarn build` passes, `yarn typecheck` exits 0, and `yarn test` gives 970 passing, 13 pending, 0 failing, smoke ok. The package has no lint script.
