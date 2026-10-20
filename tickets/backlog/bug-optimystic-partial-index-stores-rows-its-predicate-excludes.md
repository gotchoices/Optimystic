description: An Optimystic index declared with a filter (`create index … where …`) stores an entry for every row of the table, not only the rows the filter admits, so every write pays for index entries the declaration said it would never need, and the index grows as large as an unfiltered one.
files: packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`insertIndexEntries`, `deleteIndexEntries`, `updateIndexEntries`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (the backfill whose `NOTE:` reads "`predicate` (partial indexes) is not honoured here, matching insertIndexEntries on the live DML path"), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`StoredIndexSchema.predicate`)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Evaluating a stored predicate expression per row per index on every write adds work to the write path and needs an expression evaluator over the persisted AST, while the cost of not doing it is extra storage and extra index-tree writes, not a wrong answer that has been observed; a maintainer may defer it until a deployment declares partial indexes on a write-heavy table.
----
# A partial index stores rows its predicate excludes

Reported as suggestion 3 of GitHub [#42](https://github.com/gotchoices/Optimystic/issues/42) (honour a partial index's predicate on write).

## What happens

`IndexManager.insertIndexEntries` stages an entry in every maintained index tree for every row, with no reference to the index's `predicate` (the persisted `where` clause of `create index … where …`). Delete and update do the same. The backfill that populates an index created on an existing table does too, and says so in a `NOTE:` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` ("both over-populate a partial index. Fix them together or not at all").

So a partial index is maintained exactly like a full one: each insert into the table writes the index's collection even when the row is outside the predicate.

## Expected

An index with a predicate holds entries only for rows the predicate admits: an insert or update of a row outside it stages nothing in that index (an update that moves a row out of the predicate deletes its entry; one that moves a row in inserts one), and the backfill agrees.

## What is and is not known

- Read from the code, not run. Confirm with a table declaring `create index I on T (c) where c is not null`, inserting a row with `c` null, and checking the index tree (`plugin.verifyIndexes`, or a direct read of the index collection) holds an entry for it.
- Request cost: #42 counted each index as one more collection written per insert. Once the ticket chain ending in `a-transaction-pends-and-commits-its-collections-together` lands, the collections of one write travel in one request per member per phase, so a needless index entry no longer adds cluster requests. It still adds the index tree's block writes, its log entry, and its storage.
- Wrong results: not observed. Whether a query planned through a partial index can return a row outside the predicate depends on whether the engine re-applies the predicate above an index scan the vtab offers; that was not checked.
- Partial UNIQUE enforcement is a separate, open defect (`bug-optimystic-unique-ignores-collation-and-partial-predicate`); a fix here gives that ticket an index that holds exactly the rows its constraint binds.
