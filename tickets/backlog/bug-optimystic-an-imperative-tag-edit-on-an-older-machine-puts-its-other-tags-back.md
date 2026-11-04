description: A machine holding an older copy of a table's tags that adds or drops one tag with an `alter` statement also writes its older values of every other tag on that object into the shared stored description, undoing another machine's change to those tags.
architecture: docs/internals.md#a-first-touch-writes-only-what-the-table-owes
files: packages/quereus-plugin-optimystic/src/schema/catalog-only-change.ts (`tagsToSave`), packages/quereus-plugin-optimystic/src/schema/tag-overlay.ts (`tagChangesBetween`, `withTagsAt`), packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs an imperative tag edit on a shared table from a machine that hydrated before another machine's tag change, and hosts that change tags only through `apply schema` never reach it; comparing by key also has to settle what `set tags` means on such a machine.
----

## What happens

Sessions share one `MemoryRawStorage`, as in `openSession` in `packages/quereus-plugin-optimystic/test/alter-table-arms.spec.ts`.

1. Machine A declares `t` with `with tags (version = 1)`.
2. Machine B hydrates.
3. A applies the same declaration with `version = 2`.
4. B runs `alter table main.t add tags (x = 1)`, then `await plugin.whenCatalogPersisted()`.
5. A new session hydrates to read the record.

| | Tags |
| --- | --- |
| Record | `{ version: 1, x: 1 }` |
| Expected | `{ version: 2, x: 1 }` |

## Root cause

The listener saves one tag location at a time and writes that location's whole tag set. That matches `set tags`, which replaces the set, but `add tags` and `drop tags` name only some keys (`mergeTableTags` in `@quereus/quereus/src/schema/manager.ts`). The announcement carries only the old and new sets, so B's `version = 1` is written as part of the new set even though the statement did not touch it.

## Expected behaviour

A tag edit changes in the record only the keys it changed on this machine. The event's old and new sets are enough to tell which those are. Decide what a `set tags` on a machine holding older tags should do with a key another machine added: today it removes the key, since the set it writes does not list it.
