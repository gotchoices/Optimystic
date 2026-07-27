---
description: The documentation still calls transactions by an old name the code stopped using, so anyone following the docs writes code that does not compile.
files: docs/repository.md, docs/transactions.md, docs/internals.md, docs/optimystic.md, docs/architecture.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/readme.md, packages/db-core/src/network/struct.ts
difficulty: easy
---

The codebase renamed its transaction vocabulary — what used to be called a "trx" is now an "action":
`TrxBlocks` → `ActionBlocks`, `trxRef` → `actionRef`, `trxId` → `actionId`. The source finished the
rename; the prose documentation did not. `TrxBlocks` survives in `packages/db-core/src/network/struct.ts`
only as a one-line backwards-compatibility alias (`export type TrxBlocks = ActionBlocks`), so the docs
are describing an API surface that is deprecated rather than current.

Roughly eighteen occurrences remain, spread across seven markdown files:

| File | Occurrences |
| --- | --- |
| `docs/repository.md` | 7 |
| `docs/transactions.md` | 4 |
| `docs/internals.md` | 3 |
| `docs/architecture.md` | 1 |
| `docs/optimystic.md` | 1 |
| `packages/db-p2p/docs/cluster.md` | 1 |
| `packages/db-p2p/readme.md` | 1 |

## Why it matters

`docs/repository.md` documents the repository interface method-by-method — `cancel(trxRef)`,
`commit(tailId, trxRef)` — and the real interface (`packages/db-core/src/network/i-repo.ts`) takes
`actionRef: ActionBlocks`. A reader implementing against that page writes a signature that does not
match, and the mismatch only surfaces at compile time in their own project.

## Expected outcome

Every prose reference to the old vocabulary names the current one, and the code snippets in these
files typecheck against the real interfaces rather than against the deprecated alias. Whether the
`TrxBlocks` alias itself should be deleted is a separate call — deleting it is a breaking change for
downstream consumers and is deliberately **not** part of this ticket.

## Scope note

This is a documentation sweep, not a rename. No source file changes. Do not renumber, restructure or
rewrite these documents beyond the naming — several of them have other drift, but mixing that in makes
the diff unreviewable.

Found during review of the foreign-peer interop fixture, which corrected the same class of drift in
`packages/db-p2p/docs/repo.md` (the one file that ticket touched) and left the rest untouched rather
than expanding scope.
