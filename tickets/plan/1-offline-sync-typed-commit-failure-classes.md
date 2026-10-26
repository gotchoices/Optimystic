description: Give every way a commit can fail a distinct error type the writer can check, so a background sender of queued changes can tell "wait and retry" from "this change is refused for good" without reading error message text.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/errors.ts, packages/db-core/src/transactor/network-transactor.ts, docs/offline-sync.md
----

Stage 1 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages). Useful on its own; it is the prerequisite of the offline queue's drain.

## What is wanted

The offline-sync drain (later stages) decides, for every failed network commit of a queued transaction, which of these the failure is: cohort unreachable (wait), contention it could not get past (back off), a guard refusal on rebase (fail: `constraint` / `concurrent-modification`), a validity rejection (fail: `rejected`), an expired attempt (retry under a fresh expiry), a torn action proven not saved (resubmit), a torn action of unknown outcome (in doubt), or a partial commit. The table in [§Classifying an attempt's outcome](../../docs/offline-sync.md#classifying-an-attempts-outcome) is the specification.

Two of those rows have no stable type at the writer today:

- **The super-majority shortfall.** `ClusterCoordinator` throws a plain `Error` ("Failed to get super-majority: 1/2 approvals …", `packages/db-p2p/src/repo/cluster-coordinator.ts`) when a cohort with absent or silent members cannot reach its promise bar. That text is what reaches the writer. It needs a typed error (carrying approval count, peer count, the needed count and rejection count as fields) that survives the trip back to a remote writer — the repo protocol is JSON, so the type must be recoverable on the writer's side (a failure shape in the result, or a structured field on the aggregate error), not only on the coordinating node.
- **The validator rejection.** `ValidatorRejectionError` exists inside db-p2p, but what reaches the writer after `CoordinatorRepo.pend` has decided it is not a confirmed revision loss is not a stable class. The writer needs to tell "a validator judged this invalid" (permanent) from transport failure.

Then one db-core predicate (a pure function over an `unknown` error, returning a discriminated classification) sorts any commit failure into the table's rows. It must never inspect `message` text. An error it does not recognize is classified as transient-unknown, per the doc.

## Related

- backlog `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` — another application parses our aggregate error text to tell commit-phase from get/pend-phase failures. The same structured field may serve both; the planner should decide whether this ticket absorbs it (and delete that backlog ticket if so) or leaves it.

## Done when

- Both failures above arrive at a writer — local and remote coordinator — as typed, field-carrying values.
- The classification predicate exists in db-core with a test per table row that has real branching.
- [docs/offline-sync.md](../../docs/offline-sync.md) records this stage as implemented (status line and the stage list), and [docs/internals.md](../../docs/internals.md) names the new types where it describes the corresponding failures.
