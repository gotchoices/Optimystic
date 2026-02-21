----
description: Add Atomic() wrappers to btree to avoid corruption on errors
dependencies: btree implementation
----

Add Atomic() wrappers to btree operations to avoid corruption on errors. Partial writes during btree mutations could leave the structure in an inconsistent state.
