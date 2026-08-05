----
description: The written documentation states two things the code no longer does — an old agreement threshold and an old name for transactions — so a reader who follows it budgets against the wrong safety margin or writes code that does not compile.
files: docs/correctness.md, docs/right-is-right.md, docs/repository.md, docs/transactions.md, docs/internals.md, docs/optimystic.md, docs/architecture.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/readme.md, packages/db-p2p/src/cluster/cluster-repo.ts (~993), packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts (~12), packages/db-core/src/cluster/structs.ts (~58), packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts
difficulty: easy
repro: verified
severity: cosmetic
likelihood: normal-use
tradeoffs: It is prose only — no behaviour changes and no user data is at risk — so a maintainer under time pressure can defer it indefinitely; the counter-argument is that both drifts actively mislead a reader who is making a change, and the sweep is an hour's work.
----

# Documentation restates code facts that have since drifted

Two independent sweeps, one root weakness: the docs **restate** a value or a name that lives in the
source, rather than citing the symbol that owns it. When the source moves, the prose does not, and
nothing catches it.

Severity is recorded as `cosmetic` because no running system misbehaves. That is the *lower* of two
defensible readings — Arm A causes a reader to budget a safety change against a wrong number, and
Arm B causes a reader to write a signature that does not compile, which is closer to `wrong-result`
for the reader. Filed at the lower value deliberately; the body says why it still matters.

## Arm A — prose still quotes the pre-unification super-majority default

`DEFAULT_SUPER_MAJORITY_THRESHOLD` (`packages/db-core/src/cluster/structs.ts:58`) is `0.75`. The
composition root applies it with no override (`resolveClusterPolicy` in
`packages/db-p2p/src/cluster/cluster-policy.ts`), so an unconfigured node — including a
reference-peer started without `--super-majority-threshold` — runs at `0.75`.

Several documents still state the default is `0.67`. That was true before ticket
`6.2-implement-supermajority-threshold-coupling` collapsed three drifting defaults (member `1.0`,
coordinator `0.75`, node composition root `0.67`) onto the one shared constant. The prose was not
swept afterwards. Verified by reading the constant and each quoted site, not inferred.

Most sites are merely a wrong number in an explanation. One is not. `docs/correctness.md`
(Theorem 2 status note) derives the partition-safety condition
`2 · membershipAdmissionFraction · superMajorityThreshold > 1` and evaluates it as
`2 · 0.75 · 0.67 = 1.005`, describing the result as "true, but with almost no margin", and instructs
the reader to "re-derive this product before changing either" default. With the actual `0.75` the
product is `2 · 0.75 · 0.75 = 1.125`. The safety property still holds — the document *understates*
the margin — but a reader making a change to either default is budgeting against a figure that is
wrong, and the document's own instruction to re-derive was not followed when the default moved.

| File | What it says |
| --- | --- |
| `docs/correctness.md` (5 places: implementation-status notice, §1.5 status, Theorem 1 Case 3, Theorem 2, Theorem 10) | `superMajorityThreshold = 0.67`, and the `1.005` product above |
| `packages/db-p2p/src/cluster/cluster-repo.ts:993` | the `1.005` product in a `NOTE:` comment |
| `docs/right-is-right.md:142` | "configurable `superMajorityThreshold` (default: 0.67)" |
| `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts:12` | comment calls `0.67` "the default"; the spec's own `0.67` cases are deliberate overrides and are correct as tests |

The same drift in `packages/reference-peer/src/cli.ts` (`--super-majority-threshold` help text) and
`packages/reference-peer/README.md` was already corrected during review of
`corroboration-floor-defaults-to-two-for-large-meshes`; those two need no further work.

`docs/correctness.md` also cites `libp2p-node-base.ts:605` as the resolution site five times. That
line number is stale twice over — the defaults now live in
`packages/db-p2p/src/cluster/cluster-policy.ts`.

Found during review of `corroboration-floor-defaults-to-two-for-large-meshes`; not caused by it.

## Arm B — docs still use the retired transaction vocabulary

The codebase renamed its transaction vocabulary — what used to be called a "trx" is now an "action":
`TrxBlocks` → `ActionBlocks`, `trxRef` → `actionRef`, `trxId` → `actionId`. The source finished the
rename; the prose did not. `TrxBlocks` survives in `packages/db-core/src/network/struct.ts` only as a
one-line backwards-compatibility alias (`export type TrxBlocks = ActionBlocks`), so the docs describe
an API surface that is deprecated rather than current.

Roughly eighteen occurrences remain across seven markdown files:

| File | Occurrences |
| --- | --- |
| `docs/repository.md` | 7 |
| `docs/transactions.md` | 4 |
| `docs/internals.md` | 3 |
| `docs/architecture.md` | 1 |
| `docs/optimystic.md` | 1 |
| `packages/db-p2p/docs/cluster.md` | 1 |
| `packages/db-p2p/readme.md` | 1 |

`docs/repository.md` documents the repository interface method-by-method — `cancel(trxRef)`,
`commit(tailId, trxRef)` — and the real interface (`packages/db-core/src/network/i-repo.ts`) takes
`actionRef: ActionBlocks`. A reader implementing against that page writes a signature that does not
match, and the mismatch only surfaces at compile time in their own project.

Found during review of the foreign-peer interop fixture, which corrected the same class of drift in
`packages/db-p2p/docs/repo.md` (the one file that ticket touched) and left the rest untouched rather
than expanding scope.

## Expected outcome

- Every prose statement of the super-majority default names the value the code actually resolves, the
  partition-safety product is re-derived at that value, and code references point at
  `resolveClusterPolicy` **by file and symbol** rather than a line number, so they cannot rot again.
- Every prose reference to the old transaction vocabulary names the current one, and the code
  snippets typecheck against the real interfaces rather than the deprecated alias.
- Where a document must quote a number that lives in code, it says which constant owns it, so the
  next change to that constant has an obvious sweep target.

## Scope notes

- No behaviour change. Tests that deliberately pass `0.67` keep doing so; only their "this is the
  default" comments change. The threshold itself is not up for revision here.
- Whether the `TrxBlocks` alias should be deleted is a separate call — deleting it is a breaking
  change for downstream consumers and is deliberately **not** part of this ticket.
- Do not renumber, restructure or otherwise rewrite these documents beyond the naming and the
  numbers — several of them have other drift, but mixing that in makes the diff unreviewable.

Merged from `bug-docs-quote-superseded-super-majority-default` (Arm A) and
`debt-docs-stale-transaction-naming` (Arm B) during backlog gardening.
