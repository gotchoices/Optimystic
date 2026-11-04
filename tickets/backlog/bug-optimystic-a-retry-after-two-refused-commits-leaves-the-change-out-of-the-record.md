description: When a schema upgrade's save is refused twice in a row, retrying the upgrade reports success but leaves part of it out of the shared stored description, so other machines never see that part. The machine that ran it only repairs the record after a restart.
architecture: docs/transactions.md#end-commit-failure
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`endSchemaBatch`, `beginSchemaBatch`, `adoptedByRefusedBatch`), packages/quereus-plugin-optimystic/src/schema/catalog-only-change.ts (`AdoptedChanges`, `tagsToSave`, `classifyCheckChange`)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It takes two consecutive commit refusals in one apply that also creates a table, and the next restart's `apply schema` repairs a declared change, while Quereus does not tell the module which batch is an unwind, so a maintainer may prefer to wait for that signal from Quereus.
----

## What happens

A machine applies a schema upgrade that changes a table's tags or adds a CHECK, and also creates a table. Its catalog commit is refused, and Quereus opens a second batch to run the undo statements. That second batch's commit is refused as well. The machine then retries the same `apply schema`, and the retry succeeds. Its own catalog holds the change, but the shared record does not.

| Change in the apply | This machine's catalog after the retry | Record after the retry | Should be |
| --- | --- | --- | --- |
| `with tags (version = 2)`, from `version = 1` | `version = 2` | `version = 1` | `version = 2` |
| `constraint small check (a < 100)` added | has `small` | no `small` | has `small` |

The CHECK row behaves this way without the tag change, so the defect predates tag adoption. A column added by the same kind of apply should behave the same way, since it follows the same rule, but that case was read from the code and not run.

## Reproduction

Run with one session over a `MemoryRawStorage` through `refusingCommits` (in `packages/quereus-plugin-optimystic/test/shared-local-transactor.ts`):

1. Apply `declare schema main { table t { id integer primary key, a integer null } with tags (version = 1) } apply schema main;`.
2. Call `refuse(2)`, then apply the same declaration with `version = 2` plus `table v { id integer primary key }`. It fails with the injected refusal. The new table is what makes the second batch stage a write: its undo stages a gravestone (the record a dropped table leaves), so the second commit is attempted and refused. Without a staged write, the second batch makes no commit and nothing is refused.
3. Call `refuse(0)` and apply the upgrade again. It succeeds.
4. Open a new session and hydrate it. The record says `version = 1`.

## Root cause

The undo of a change this machine wrote and had refused finds the record already agreeing with the undo, because the refused change never landed. So it is recorded as adopted, with the change's new state as its pre-change state. `endSchemaBatch` then carries those entries forward through `adoptedByRefusedBatch` when the second batch is refused too. The retry's forward step puts the object into exactly that state, so `AdoptedChanges.undoes` reads it as an undo and keeps it off the record.

The carried entries exist for a real reason: when the first batch is refused, the second batch needs them to recognise the undo of a change another machine committed. The module cannot simply drop them on every refusal, because a batch that follows a refusal may be the next apply rather than the unwind (after a data-destroying step Quereus opens no second batch), and the hooks are not told which it is. The `NOTE:` on `adoptedByRefusedBatch` describes that ambiguity.

## Expected behaviour

A retry that reports success leaves its whole change in the record, however many commits were refused before it.
