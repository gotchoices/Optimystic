description: Let an offline update that changes one column of a row survive another machine changing a different column of the same row, instead of failing because the whole row was rewritten.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#guards-that-make-idempotent-writes-assured
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: hard
tradeoffs: Changes the tree's action format and how index changes are computed, which needs its own design and an upgrade path for logs older releases wrote, to rescue concurrent edits to different columns of one row.
----

From stage 11 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages); the "further step" paragraph at the end of [§Guards that make idempotent writes assured](../../docs/offline-sync.md#guards-that-make-idempotent-writes-assured). A blind partial update (`update t set status = 'done' where id = ?`) is refused today when a rival changed any column, because the action writes the whole row image. An action writing only the changed columns, guarded only on the columns the statement read and those its index delta needs, would be refused only by a rival that changed those or deleted the row. Needs a design pass first; `packages/upgrade-check` must keep reading logs written in the current format.
