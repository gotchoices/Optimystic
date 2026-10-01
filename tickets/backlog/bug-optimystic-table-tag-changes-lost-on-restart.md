description: Changing a table's tags after it was created works for the rest of the session but is not saved for Optimystic-backed tables, so after a restart the table has its original tags again — which matters now that a tag decides whether a table's changes are announced across the network.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, ../quereus/packages/quereus/src/runtime/emit/alter-table.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: A host that runs `apply schema` on every start re-applies its declared tags each time and never notices, and only one tag (`optimystic.network_watch`) has any effect in this plugin, so a maintainer may judge the imperative-ALTER case too rare to be worth a schema-event listener.
----

# Table tag edits on Optimystic tables do not survive a restart

`alter table t set tags (…)` (and `add tags` / `drop tags`, and `apply schema`, whose differ emits the same statement for a tag-only change) never reaches the module: Quereus swaps the in-memory table schema and fires `table_modified` on its schema manager's change notifier, and nothing else (`runSetTableTags` in `@quereus/quereus/src/runtime/emit/alter-table.ts`; its NOTE says store-backed modules must recover the change by listening to that event). The Optimystic plugin persists table tags only when it writes the table's catalog record — at create, and when a later DDL statement handled by the module rewrites the record — and `hydrate` restores tags from that record (`copyTags` in `packages/quereus-plugin-optimystic/src/schema/schema-manager.ts`). Nothing in the plugin listens to `table_modified` (searched: the only schema-event listener is the transaction engine's cache invalidation in `packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts`).

So a tag edit lasts until restart, unless a later DDL statement on the same table happens to rewrite the record first. The same applies to column and named-constraint tags.

To confirm: create an optimystic table with `with tags (a = 1)`, run `alter table t set tags (a = 2)`, restart with `plugin.hydrate(db)`, and read the table's tags back.

Expected: the edited tags are what a restart restores. The `table_modified` listener added by `quereus-tables-opt-in-to-network-change-notification` (which follows `optimystic.network_watch` live) is the natural place to also rewrite the catalog record.
