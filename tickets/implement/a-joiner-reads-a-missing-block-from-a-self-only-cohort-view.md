description: A node that has just learned from the shared log that a block exists, but does not hold it and currently sees itself as the only machine responsible for it, answers "this block was never created" and the read fails hard. It should instead say "I could not find out", so the read is retried against another machine and, failing that, ends in a retryable error.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`AbsenceVerdict`; `fetchBlockFromCluster`'s empty-cohort exit and its "Solo-cluster short-circuit" exit; `readRepairBlock`'s `isMissing && absence !== 'confirmed'` mapping; `flagUnconfirmedAbsence`)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableReason`, `BlockGets.floors`)
  - packages/db-core/src/transactor/network-transactor.ts (`get`: the second-chance round for a flagged entry, and `unavailableRank`)
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet` sends the floor; `answeredBlock` turns a flagged blockless entry into `BlockUnavailableError`)
  - packages/db-core/src/collection/collection.ts (`raiseFloors` — where the existence evidence comes from)
  - packages/db-core/src/blocks/helpers.ts (`get` — the `Missing block` throw the report ends in)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts, packages/db-p2p/test/coordinator-repo-absence-window.spec.ts (existing self-only-absence specs and their fixtures)
  - docs/internals.md (the absence table under "A block read has three answers"), docs/transactions.md (§ Lazy read-repair window)
difficulty: medium
repro: static
----

# A self-only view must not rule out a block the asker's log says exists

GitHub issue #27 (https://github.com/gotchoices/Optimystic/issues/27), reproduced by the reporter on 1.8.1 and 1.9.0 with a standalone two-`CadreNode` script. Not re-run here: the script needs the sibling sereus packages plus a one-line patch to Quereus that yields to the event loop between schema-migration steps. What follows was established by reading the code against the reporter's trace (`repro: static`); the first TODO is the in-repo test that confirms it.

## What happens

The joiner's refresh of the catalog collection (`optimystic/schema`) walks a log entry at revision 3 that names block `CpS_…`. `Collection.forgetAndAdopt` drops that block from the read cache and records a *floor* for it: "a log entry I walked says this block was changed at revision 3" (`raiseFloors`). The next read of the block goes out through `TransactorSource.tryGet`, which puts the floor on the request (`BlockGets.floors`).

The read is routed to the joiner's own `CoordinatorRepo`, because its key network currently reports a cohort of exactly itself for the block. Local storage does not hold the block, so `readRepairBlock` runs `fetchBlockFromCluster`, which takes the "Solo-cluster short-circuit" exit: nobody is asked, and the verdict is `absence: 'confirmed'`. `readRepairBlock` therefore leaves the entry unflagged — an **authoritative absent**. `NetworkTransactor.get` treats an authoritative absent as final (no second-chance round), `tryGet` returns `undefined`, and `get` in `packages/db-core/src/blocks/helpers.ts` throws `Missing block`.

The comment at the solo exit already says a self-only cohort is also what `findCluster` returns while real peers are not yet identified. The absence table in docs/internals.md accepts "nobody to ask → authoritative absent" on the grounds that the node has no evidence either way. That reasoning does not hold for this read: the request itself carries the evidence. A floor on a block this node does not hold at all means the asker read a log entry committing a revision of the block, so "never created" contradicts what the asker already knows.

## The change

A read of a block that is **missing locally**, **carries a floor**, and whose consult **asked nobody** (empty cohort, or self-only) is answered `unavailable` rather than as an authoritative absent.

- `fetchBlockFromCluster` must let its caller tell "nobody was asked" from "every member answered that it holds nothing". Today both are `'confirmed'`. Add a distinct `AbsenceVerdict` (suggested name `'unasked'`) returned by the empty-cohort exit and the solo-self exit. The no-`clusterLatestCallback` exit stays `'confirmed'`: such a coordinator has no cluster by construction.
- `readRepairBlock` maps the new verdict: with no floor on the block it stays an unflagged absent, exactly as today (this keeps the one-round `createOrOpen` probe on a one-machine deployment, and every existing self-only spec); with a floor it calls `flagUnconfirmedAbsence`.
- The reason needs a new `BlockUnavailableReason` value (suggested `'named-by-log'`: nothing held here, nobody to ask, but the asker's log names the block). Do not reuse `'cohort-unreachable'`: its doc says a caller may treat it permissively as "this node's local view is all there is", which is the opposite of what is known here. In `NetworkTransactor.get`'s `unavailableRank` it belongs with `'claimed-elsewhere'` (the block is known to exist).
- Nothing changes for a block that is present locally, for a cohort that was actually consulted (even one whose members all answered "holds nothing" under a floor — out of scope, see below), or for the arming and log-line rules at the solo exit (`soloAbsenceNamedThisWindow`).

What this buys, in order:

1. `NetworkTransactor.get` counts a flagged entry as not answered, so it earns the existing second-chance round with this node excluded. `findCoordinator`'s connected-peer fallback can then pick a connected, identified serving peer even though it is outside the self-only cohort view — in the report, the founder, which holds the block.
2. When no other machine can be reached, `TransactorSource.tryGet` throws `BlockUnavailableError` naming the block and reason, instead of the untyped `Missing block`. A host can recognise and retry that; the storage layer's bound for the view to widen is unchanged (`readRepairWindowMs`).

This answers question 1 of the issue with "retryable error, after asking another machine", not "wait for the cohort". Waiting was rejected: in the reporter's trace the strand network's cohort never grows past one for the whole trial, in passing runs too, so a bounded wait on the cohort would only add delay before the same failure.

## Risks the implementer must check

- **Deleted blocks carry floors too.** `raiseFloors` floors every id in `entry.blockIds`, and a log entry lists blocks its action deleted. After this change a floored read of a deleted block on a genuinely one-machine deployment would throw `BlockUnavailableError` where it returned `undefined`. No reader is expected to ask for a block its own adopted revision deleted (nothing references it), but confirm by running the full `db-core`, `db-p2p` and `quereus-plugin-optimystic` suites; a new failure there is this case. If one appears, the fix belongs at the floor (do not floor a deleted id, which needs the entry to say which ids it deleted), not in relaxing the flag.
- **A log entry whose blocks never landed** (backlog `bug-a-refused-write-can-leave-its-log-entry-behind`). For an inserted block that landed nowhere, the floored read on a one-machine deployment changes from `Missing block` to `BlockUnavailableError` — still an error, now typed. Acceptable; record it as a `NOTE:` at the mapping site with the revisit condition "log entries become proof their blocks landed".
- A coordinator on an older build ignores `floors` and answers as before; an asker on an older build sends none. No version gate.

## Not in this ticket

- Why two machines each end up with their own copy of the catalog, and why the strand network's cohort stays at one: ticket `a-joiner-builds-its-own-catalog-while-its-cohort-view-is-self-only` (fix stage). That ticket also carries the issue's questions 2 and 3.
- A consulted cohort whose every member answers "holds nothing" for a floored block stays an authoritative absent. It is the same contradiction with a weaker cause (every reachable member is behind), and nothing reported hits it.
- Retrying inside the Quereus plugin (`CatalogBatch.commit` / `endSchemaBatch`). The typed error reaches the host unchanged.

## TODO

- Add the reproducing test in `packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts` (it already builds a coordinator whose `findCluster` is self-only): a `get` for a block missing locally with `floors: { [id]: n }` must come back flagged `unavailable`; the same `get` without `floors` must stay unflagged. Run it first and see the flagged case fail.
- Add the `AbsenceVerdict` member and return it from the two ask-nobody exits of `fetchBlockFromCluster`; update the type's doc comment and the method's doc comment ("Paths that consult nobody … are `'confirmed'`" is no longer true).
- Add the `BlockUnavailableReason` value with its doc comment; place it in `unavailableRank`.
- Map the verdict in `readRepairBlock`, with the `NOTE:` described under Risks.
- Run `yarn build`, then `yarn test` for `db-core`, `db-p2p` and `quereus-plugin-optimystic`, and `yarn test:integration`; treat any new `BlockUnavailableError` as the deleted-block risk above.
- Update docs: the absence table and the "Note the second row" paragraph under "A block read has three answers" in docs/internals.md; § Lazy read-repair window in docs/transactions.md if it restates the solo rule; the reason list in docs/debugging.md if it enumerates `unavailable` reasons. Run `yarn lint:docs`.
- In the review handoff, say plainly that the end-to-end scenario from the issue was not re-run in this repository, and whether the second-chance round was observed reaching a second machine in any test.
