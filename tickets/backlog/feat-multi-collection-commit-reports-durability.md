description: A change that touches several collections at once gives the caller no way to tell whether it is held by the whole group or only by the machine that wrote it, even though a change touching a single collection now does.
prereq: write-durability-reaches-the-writer
files:
  - packages/db-core/src/transaction/coordinator.ts (`TransactionCoordinator.commit`, `commitOnce`, `commitOnceLatched` — returns nothing today, and folds partial commits across collections)
  - packages/db-core/src/transaction/session.ts (`TransactionSession.commit` — returns an `ExecutionResult` with no durability in it)
  - packages/db-core/src/network/durability.ts (`WriteDurability`, `mergeDurability` — the type and merge this would reuse)
tradeoffs: The single-collection path covers every write a row-level application actually makes today, so a maintainer can reasonably say the multi-collection lane can stay silent until someone asks for it; the counter-argument is that a schema change or a cross-collection transaction is exactly the kind of write a user most wants to see confirmed.
----

# What is missing

The ticket `write-durability-reaches-the-writer` threads a write's durability class — whether every machine in the group holds the change, only a majority, or only the writing machine — from the storage layer up to the collection API, for writes that touch a single collection.

Writes that span several collections go a different way: `TransactionCoordinator.commit`, which returns nothing. So a caller committing across collections gets the same bare "it worked" this whole line of work exists to replace.

# Why it was left out

Merging durability across collections is not the same problem as merging it across the coordinators of one action, and it is not obviously the weakest-wins rule the single-collection path uses. `TransactionCoordinator` can end an attempt with some collections durably committed and others dropped for a later attempt — it has an explicit partial-commit fold for exactly that. So the answer for a multi-collection commit has to say *which collections landed and how well*, not just a single class, or it will be wrong in the case the coordinator was built to handle.

That is a design question, not an edit, which is why it did not ride along.

# What a caller needs

At minimum: per collection, whether it committed and at what durability class; and one overall class a simple caller can read without unpacking the detail. The existing `WriteDurability` type and its `mergeDurability` helper are the right building blocks — the per-collection reports are the same shape the per-cohort reports already are.

Worth settling at the same time: whether `TransactionSession.commit`'s `ExecutionResult` should carry it, since that is the surface the Quereus plugin's transaction bridge uses.

# Where it is noted today

`TransactionCoordinator.commit` carries a `NOTE:` pointing at this ticket, so the gap is visible at the place someone would otherwise assume the class is available.
