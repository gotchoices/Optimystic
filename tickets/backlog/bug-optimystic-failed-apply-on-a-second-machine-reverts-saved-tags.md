description: When two machines run the same schema upgrade and the second one's upgrade fails part-way, the second machine puts its old table tags back into the shared stored description, undoing the first machine's tag change — for Sereus, the control-schema version tag.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`followTableTags`, `saveTableTags`, `alterCatalogOnly` and `AdoptedChanges` for the rule the ALTER arms follow), packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`persistTags`, `retagged`), packages/quereus-plugin-optimystic/src/schema/tag-overlay.ts (`withTagsOf`), packages/quereus-plugin-optimystic/src/schema/catalog-only-change.ts
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a second machine's apply to fail after its tag step, on a table another machine already upgraded, and re-applying the schema on any upgraded machine puts the tag back, so a maintainer may wait until a failed apply shows it in the field.
----

## What happens

A tag change never reaches the module as a statement: Quereus applies `set tags` to its own catalog and announces `table_modified`, and the module's listener (`followTableTags` → `saveTableTags` → `SchemaManager.persistTags`) overlays **every** tag of the engine's new table schema onto the catalog record. That is right for one machine. It is wrong for the second machine of an upgrade when that machine's `apply schema` fails after its tag step:

1. Machine A applies v2 (table tag `version = 2`) and commits.
2. Machine B, which hydrated v1 earlier, applies v2. Its `set tags (version = 2)` is saved as `unchanged` (the record already says 2).
3. A later step of B's apply fails, and Quereus unwinds: the undo of the tag step is `set tags (version = 1)` on B's catalog, the listener hears it, and saves `version = 1` over A's record.

The record now describes A's upgraded table with the old version tag. Any machine that hydrates it reads version 1.

Verified with two sessions over one `MemoryRawStorage` (harness in `test/alter-table-arms.spec.ts`): A declares `table t { … } with tags (version = 1)` and `table u { id integer primary key, c text null }`; B hydrates; A applies the same with `version = 2`; B applies that plus `constraint one_c unique (c)` on `u` (refused by the module, and `u`'s steps run after `t`'s tag step); after `plugin.whenCatalogPersisted()`, a third session that hydrates sees `t` tagged `version = 1`.

The same path reverts the tags of other objects too: the undo of a dropped CHECK re-adds it with its pre-apply tags, and the listener overlays them onto the record's CHECK of that name even when the record holds another machine's newer CHECK under it. And any structural `table_modified` during the unwind re-overlays all of B's (old) tags as well, so skipping only the tag statement's own event would not be enough.

## Expected

The rule the catalog-only `ALTER` arms follow (`catalog-only-drop-check-constraint`): a change a machine finds already saved is adopted, and the undo of an adopted change touches only that machine's catalog, never the record. For tags this needs the save to know which tags an event changed (the event carries `oldObject` and `newObject`) rather than overlaying all of them, so an unwind event can be recognised as undoing an adopted tag change.
