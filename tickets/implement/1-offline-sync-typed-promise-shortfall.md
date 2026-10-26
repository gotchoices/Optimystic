description: When a write fails because too few machines in its group answered, the writer should get a distinct error carrying the counts (how many approved, how many were needed, which machines were silent), on its own machine and across the network, instead of a plain message it would have to parse.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/network/transaction-expired-error.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/index.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/util/node-count-mesh.ts, packages/db-p2p/test/transaction-node-count-sweep.spec.ts, packages/db-p2p/test/member-leaves-and-returns.spec.ts, docs/internals.md, docs/correctness.md, tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md
----

Part of stage 1 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages) (the "Cohort unreachable, nothing sent" row of the classification table). The whole stage is four tickets: this one, `signed-validity-marker-on-reject-votes`, `offline-sync-typed-validity-rejection`, then `offline-sync-commit-failure-classifier`, which adds the db-core predicate and marks the stage implemented.

## The defect

When a cohort with absent or silent members cannot reach its promise bar, `ClusterCoordinator.executeClusterTransaction` (`packages/db-p2p/src/repo/cluster-coordinator.ts`) throws a plain `Error('Failed to get super-majority: a/n approvals (needed k, r rejections)')`. What a writer sees:

- **Local coordinator** (writer and coordinator in one process): `NetworkTransactor.pend` wraps it as the `cause` of its plain aggregate `Error('Some peers did not complete: …')`, which escapes `Collection.sync` unretried. The only way to read the counts is a regex over the cause's message — which is exactly what the test helper `expectPromiseShortfall` in `packages/db-p2p/test/util/node-count-mesh.ts` does.
- **Remote coordinator**: `CoordinatorRepo.pendThroughCluster` rethrows, `RepoService` aborts the stream, and the writer sees a stream reset. The type and the counts are gone.

## Design

Follow the `ExpiredFailure` precedent exactly (`TransactionExpiry` data, `ExpiredFailure` shape, `isExpiryFailure`, `TransactionExpiredError` with `toFailure()` — see "Pend retryability is an explicit field" in [docs/internals.md](../../docs/internals.md)): a returned, typed refusal that crosses the JSON repo protocol as data.

### Data, shape, predicate, error (db-core)

```ts
/** Why a cohort's promise round fell short with no member refusing it as a lost race or a held block:
 *  too few members answered. Plain data, so it crosses the repo protocol intact. */
export type PromiseShortfall = {
	approvals: number;        // approve votes received
	rejections: number;       // reject votes received (below the rejection bar, or this would be a rejection)
	peerCount: number;        // cohort size the round ran on
	needed: number;           // ceil(peerCount × superMajorityThreshold)
	silentPeers: string[];    // peer-id strings of cohort members that cast no promise vote
};

export type ShortfallFailure = {
	success: false;
	reason?: string;          // for a log line; never branch on it
	conflict: false;
	shortfall: PromiseShortfall;
	// every other sibling's discriminating field typed `never`, as ExpiredFailure does
};
export type WriteFailure = StaleFailure | ExpiredFailure | ShortfallFailure;

export function isShortfallFailure(failure: WriteFailure): failure is ShortfallFailure;  // presence of `shortfall`

export class PromiseShortfallError extends Error {
	readonly approvals; readonly rejections; readonly peerCount; readonly needed; readonly silentPeers;
	constructor(shortfall: PromiseShortfall);
	toFailure(): ShortfallFailure;
}
```

- Place the type beside `TransactionExpiry`/`ExpiredFailure` in `packages/db-core/src/network/struct.ts`, the predicate beside `isExpiryFailure` in `packages/db-core/src/network/stale-failure.ts`, the class in its own file beside `transaction-expired-error.ts`; export all from `packages/db-core/src/index.ts`. Add `shortfall?: never` to `StaleFailure` and `ExpiredFailure` (and `expired?: never` to `ShortfallFailure`) so consumers keep reading fields unnarrowed.
- **The message stays byte-identical**: `Failed to get super-majority: ${approvals}/${peerCount} approvals (needed ${needed}, ${rejections} rejections)`. A downstream application (sereus `control-write-retry`) matches that text; keeping it means only the error's *position* changes for it (see Interactions).
- `isConflictFailure` must answer false for it (it does once `conflict: false` is set, but state it in the doc comment).

### Producer (db-p2p)

- `ClusterCoordinator.executeClusterTransaction` throws `new PromiseShortfallError({...})` at the generic shortfall site (the `peerCount > 1 && approvalCount < superMajority` branch). `silentPeers` = `Object.keys(record.peers)` minus `Object.keys(promises)` of the merged record. Keep the existing NOTE about not broadcasting; rewrite the "load-bearing wire text" NOTE to say the text is preserved in this class's message and that consumers should test `instanceof PromiseShortfallError` / `isShortfallFailure`.
- `CoordinatorRepo.pendThroughCluster`'s catch returns `error.toFailure()` for a `PromiseShortfallError`, next to the expiry arm and ahead of the stale classifier.
- **Pend only.** `CoordinatorRepo.commit`'s catch rethrows a `PromiseShortfallError` unchanged (today's behaviour). Reason: a returned commit refusal is read by `NetworkTransactor.commitTailThenSweep` as a confirmed conflict, while a thrown sweep is tolerated as a torn success; returning the shortfall there would turn today's tolerated torn sweep into a refused write with its log tail left behind. A commit-phase shortfall therefore still reaches a remote writer as a reset stream, and the stage-1 classifier treats it as unknown — correct for the offline drain, since a commit attempt is in doubt until a refresh settles it. Leave a `NOTE:` at that catch: *if a writer ever needs to tell a commit-phase silent cohort from other commit faults, return it here — but first make the sweep treat a returned shortfall as transport-shaped.*

### Writer consumers (db-core)

- `refusalFrom` in `packages/db-core/src/transactor/network-transactor.ts`: precedence **expiry > shortfall > stale**. A shortfall in any batch is the answer (the first one, verbatim): a retry cannot succeed while that cohort is silent, so a conflict beside it must not make the write look retryable — the same reason the function already gives for expiry. Update its doc comment.
- `Collection.syncAttempts` (`packages/db-core/src/collection/collection.ts`): stop on it by name, exactly like the expiry arm — `throw new PromiseShortfallError(attempt.shortfall)`, no retry, nothing on the instance touched (the attempt ran on the snapshot tracker). This preserves today's "a shortfall is not retried by sync" behaviour; the error is now top-level instead of nested in the transactor aggregate.
- `TransactionCoordinator` (`packages/db-core/src/transaction/coordinator.ts`): `pendRefusalError` maps a shortfall to `PromiseShortfallError`; `pendFailure` carries it whole the way it carries `expired`, and `commit()` throws it by name (and `execute()` reports it as a failed result), never as a stale loss.

## Edge cases & interactions

- **No coordinator re-pick any more for a pend shortfall.** A thrown pend used to make `processBatches` exclude that coordinator and try another; a returned refusal does not. Accepted: the other coordinators of the same cohort meet the same silent members, and in the common two-member case the only other candidate is the absent machine, so the re-pick cost a dial timeout and bought nothing. Record this as a `NOTE:` at the new return in `pendThroughCluster`. Verified by inspection.
- **Cancel still runs.** `NetworkTransactor.pend` cancels on any batch that did not succeed, returned or thrown, so members that approved still release their reservation. By inspection.
- **Batched multi-collection pend** (`NetworkTransactor.pendMany` → `CoordinatorRepo.pendMany`): the same catch serves it, so a shortfall answers the whole batch; the coordinator must not fall back to per-collection pends on a *returned* refusal (it does that only on a throw today). By inspection.
- **`Collection.settleUnfinished` re-send refused by a shortfall** lands in the existing "a cause that can clear" arm (`completion-refused`), as an expiry does. By inspection; no change.
- **Mixed versions.** A writer on an older build receiving `ShortfallFailure` sees a reason-only non-conflict refusal and retries it with backoff up to its budget (about 21 s by default) before failing, where it used to fail at once. A coordinator on an older build keeps throwing, which a new writer sees as before (aggregate/stream reset). Note both in the handoff; no gate.
- **Downstream text matcher (sereus).** The super-majority sentence is unchanged, but a local writer now gets it as the top-level `PromiseShortfallError` rather than as the `cause` of a `Some peers did not complete:` aggregate. Say so explicitly in the handoff. The backlog ticket `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` already records the move (its 2026-10-25 update, written at planning); correct it only if the implementation lands differently.
- **The solo path** (`pendSolo`) never runs a promise round and is untouched.

## Tests

- Switch `expectPromiseShortfall` in `packages/db-p2p/test/util/node-count-mesh.ts` to assert `instanceOf(PromiseShortfallError)` and read the counts from its fields (drop the regex and the aggregate-message assertion), and return `silentPeers` too. `transaction-node-count-sweep.spec.ts` and `member-leaves-and-returns.spec.ts` then pin the local-coordinator path end to end with no new test. Have the helper also assert the message still matches the old sentence, since that text is a downstream contract.
- No new test for the remote path: the shape is plain numbers and strings (by inspection, the `ExpiredFailure` precedent), and `refusalFrom`'s new precedence branch is covered by inspection beside the expiry one. Add a test only if `refusalFrom` grows real branching beyond "first of this kind wins".

## TODO

- db-core: `PromiseShortfall`, `ShortfallFailure` (+ `never` fields on siblings), `isShortfallFailure`, `PromiseShortfallError` with `toFailure()`; exports.
- db-p2p: throw `PromiseShortfallError` at the shortfall site with `silentPeers`; rewrite the wire-text NOTE.
- db-p2p: return it from `pendThroughCluster`'s catch (with the re-pick NOTE); leave `commit`'s catch rethrowing, with the commit-phase NOTE.
- db-core: `refusalFrom` precedence; `Collection.syncAttempts` stop-by-name; `TransactionCoordinator` pend-phase mapping, `commit()`/`execute()` surfacing.
- Tests: rework `expectPromiseShortfall`.
- Docs: in `docs/internals.md` add the shortfall to the "Pend retryability is an explicit field" bullet (beside expiry) and fix the expiry bullet's "the 'super-majority' shortfall a writer retries" wording; in `docs/correctness.md` replace "the legacy super-majority error" with `PromiseShortfallError`.
- `yarn build`, then `yarn test` in db-core and db-p2p (the sweep spec lives in db-p2p).
