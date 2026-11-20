description: When a write gives up after losing too many races, the error does not say whether it lost to other writers we could actually name or spent all its attempts against machines that never answered — two situations a caller should handle differently. Carry the rival's identity through to that error so a caller can tell them apart without reading the message text.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/errors.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, docs/offline-sync.md, docs/internals.md
----

# Why

`SyncRetryExhaustedError` — what `Collection.sync` / `updateAndSync` throws when a write's retry budget runs out — is one error for two situations a caller should treat differently:

- **"I lost ten races to writers I can name, and they are alive."** Re-presenting the write later is sensible: the rivals will resolve and the block will free up.
- **"I spent ten attempts against silence."** Re-presenting buys nothing until something changes.

Today the only thing separating them is the prose in `lastReason` — either `pending conflict: block(s) held by unresolved rival action(s) <id>` or `Pend blocks held: n/m member(s) hold an unresolved rival action (k/m approvals)`. The downstream consumer (sereus, outside this tree) classifies `SyncRetryExhaustedError` as non-transient and does not re-present it at all, so in the runs it measured the write was simply lost.

The evidence exists. It is collected and then dropped, at four boundaries, every one of them verified against the current tree:

1. **`ClusterCoordinator.executeTransaction`** raises `BlocksHeldError` carrying `heldBy` — peer id → the action id that member's storage says holds the blocks — assembled from the members' signed `held` votes. Nothing to fix here.
2. **`CoordinatorRepo.answerBlocksHeld`** drops `heldBy`, because `StaleFailure` has no field for it. Its own `NOTE:` says so, and says a caller that wants to wait on the holder rather than re-race it "needs a typed field added here". On the arm where this node's own storage corroborates the rival it does set `StaleFailure.pending`; on the uncorroborated arm — which its doc calls the normal shape under delivery latency, the refusing member being ahead of the coordinator — it carries nothing but a reason string.
3. **`refusalFrom`** in `network-transactor.ts` rebuilds the one action-level refusal from the per-batch ones, and carries `missing`, `staleAt`, `reason` and `conflict` — **not `pending`**. So even the corroborated rivals never leave the transactor. (The parent ticket did not know this; it matters, because it means fixing hop 2 alone would change nothing a writer can see.)
4. **`AttemptCycle.recordRefusal`** in `write-attempts.ts` keeps `reason` and `staleAt`; `SyncRetryExhaustedError` carries `collectionId`, `attempts`, `lastReason` and `staleAt`.

This is the same shape as the promise shortfall's counts, which landed as `PromiseShortfallError` (ticket `offline-sync-typed-promise-shortfall`): a thing the consumer currently has to infer, said in a field instead.

**Weigh this with `a-member-that-missed-a-commit-refuses-every-later-write` in mind** (landed 2026-09-18, commit `98fd2ab1`). The lost write sereus measured was caused by a pending record that never cleared, not by this missing field. With that fixed, re-presenting on this distinction is useful rather than a way to loop forever.

# What to build

## A field on the wire refusal

In `packages/db-core/src/network/struct.ts`, on `StaleFailure`:

```ts
/** Peer id → the action id that member's storage says holds the blocks this pend needs, from the
 *  members' signed `held` votes (`BlocksHeldError.heldBy`). A SEPARATE claim from `pending`: these
 *  are what the refusing MEMBERS reported, `pending` is what the coordinator read out of its own
 *  storage, and the two must not be merged into one list. */
heldBy?: Record<string, ActionId>;
```

Add `heldBy?: never` to the three sibling failure shapes that already declare `pending?: never` — `ExpiredFailure`, `ShortfallFailure` and `RejectedFailure` — so `WriteFailure` stays readable without narrowing, as those types already do for every other field.

Also in `struct.ts`, beside `StaleFailure`, the writer-facing summary of those two claims:

```ts
/** The unresolved rival actions some responder named as holding the blocks a write needs — the
 *  summary of `StaleFailure.pending` and `StaleFailure.heldBy` that a writer branches on. Never
 *  constructed empty: its absence is what "nobody named a rival" looks like. */
export type RivalHolders = {
	/** Distinct action ids of the named rivals. Never empty. */
	readonly actionIds: readonly ActionId[];
	/** True when the coordinator read at least one holder out of its OWN storage (`pending`); false
	 *  when the only evidence is the refusing members' signed `held` votes (`heldBy`), which is the
	 *  normal shape under delivery latency. Diagnostic: both are a named live rival. */
	readonly corroborated: boolean;
};
```

## Carry it through the three hops that drop it

**`CoordinatorRepo.answerBlocksHeld`** (`packages/db-p2p/src/repo/coordinator-repo.ts`): set `heldBy: error.heldBy` on **both** arms — the corroborated answer and the un-corroborated one. Rewrite the `NOTE:` that documents the drop: it was accurate and is now the thing that changed. What survives from it, and must stay stated, is that `heldBy` is still not folded into `pending` — they are different claims from different machines — and that nobody may recover the ids by parsing `reason`.

**`refusalFrom`** (`network-transactor.ts`): carry both claims through the rebuild.

- `heldBy`: merge the maps across the refused responses. Each key is a distinct peer id, so a plain merge is well-defined; say in the doc comment that a later response wins a repeated peer id and that it cannot matter (one peer answers one batch).
- `pending`: carry the entries, **narrowed to `{ blockId, actionId }` with any `transform` stripped**, deduplicated on that pair. The narrowing is deliberate and must be documented: the rebuild is the action-level answer, nothing rebases from it, `corroborateHeldBlocks` already produces entries with no transform, and shipping transforms up to the writer would inflate a refusal with payload no consumer reads.
- Both omitted entirely when nothing carried them, so a plain stale refusal keeps exactly the shape it has today.
- The unretryable short-circuit (a rejection, expiry or shortfall returned verbatim ahead of the rebuild) is untouched — those three types declare `heldBy?: never`.

**`AttemptCycle`** (`write-attempts.ts`): a module-private `rivalsFrom(refusal: WriteFailure): RivalHolders | undefined` — `pending` entries first (`corroborated: true`), else `heldBy` values (`corroborated: false`), else `undefined`, with the action ids deduped. Keep the result on the cycle as the last **non-empty** one seen, updated in `recordRefusal` beside `lastReason`, and **cleared in `recordCommit`** alongside `lastReason`: forward progress discards the evidence, exactly as the stall watch discards `staleAt`.

Keep `rivalsFrom` private. The house pattern for reading a `WriteFailure` is the exported predicates in `network/stale-failure.ts`, and a second consumer (the offline drain reading rivals off a *returned* refusal) would belong there — but there is no second consumer today, so exporting it now would be API nobody calls. Note that as the condition.

## The error

`SyncRetryExhaustedError` in `packages/db-core/src/collection/struct.ts` gains a final optional constructor parameter:

```ts
/** The unresolved rival actions a responder named as holding this write's blocks, as of the last
 *  refusal that named any — what separates "I lost races to writers I can name" from "I spent my
 *  budget against silence". Absent when no refusal named one, which is what silence looks like. */
readonly rivals?: RivalHolders,
```

Pass it at **both** construction sites in `write-attempts.ts` — the deadline exit in `beforeAttempt` and the budget exit in `recordRefusal` — and from `SyncRevisionStalledError`'s `super(...)` call, which must be updated for the new parameter position regardless.

**Neither error's message changes.** Not the base class's `sync for collection … exhausted N retries…`, not the subclass's rewritten one. The whole point of the ticket is that a consumer should not read the message; appending to it would be a text change with the same downstream exposure the sibling ticket exists to avoid, for no gain. The rivals are already logged where they are classified (`coordinator-repo:pend-conflict-classified`).

## Docs

- `docs/offline-sync.md` §Classifying an attempt's outcome: the `contention` row's error is unchanged, but say that `SyncRetryExhaustedError.rivals` now distinguishes a budget spent against named live rivals from one spent against silence, and that `classifyCommitFailure` still sorts both as `contention`.
- `docs/internals.md` §Consensus Execution, where the `held`-vote path and the pend refusals are described: name `StaleFailure.heldBy` as where a `held` vote's action ids now land, and keep the existing statement that they are not the same claim as the coordinator's own `pending`.

# Edge cases & interactions

- **`isConflictFailure` must not grow a `heldBy` arm.** It reads `failure.conflict ?? Boolean(missing?.length || pending?.length)`. `answerBlocksHeld` always sets `conflict: true` and `refusalFrom` always sets `conflict` explicitly, so the inference is never reached for a refusal carrying `heldBy`. Widening the predicate would change retryability for no case that exists. Verified by inspection and by the existing coordinator-repo classification spec.
- **`refusalFrom` now carrying `pending` reaches `Collection`.** Nothing reads `pending` off a *failure* today except that same inference (`PendSuccess.pending` is a different field with its own consumers), so the carry is inert apart from the new use. By inspection, via `grep -rn "\.pending\b" packages/db-core/src packages/db-p2p/src`.
- **A transform-carrying `pending`.** `PendRequest.policy === 'r'` has a producer return pending transforms, so the rebuild must strip them rather than assume `corroborateHeldBlocks`'s transform-free entries are the only input. This is the narrowing above; pin it in the `network-transactor.spec.ts` assertion.
- **Absent, never empty.** `rivalsFrom` must return `undefined` rather than `{ actionIds: [], corroborated: false }` when nothing named a rival; an empty object would read as "a rival was named" to anyone testing presence, which is the discriminator this ticket exists to provide. Pinned by a test.
- **Forward progress clears it.** A write that commits, loses, commits, then exhausts must not report a rival from before the commit. `recordCommit` clearing it is the fix; covered by the `recordRefusal`/`recordCommit` symmetry and by inspection against `lastReason`'s treatment.
- **The un-corroborated arm is the common case.** Its NOTE says the refusing member is routinely ahead of the coordinator, so a build that only carried `pending` would leave the usual failure silent. Both arms must set `heldBy`; pinned by the coordinator-repo spec.
- **Wire shape.** `heldBy` is a `Record<string, string>` and the narrowed `pending` is plain objects, so both cross `RepoService`/`RepoClient` as JSON unchanged, as `PromiseShortfall` does. By inspection.
- **Mixed versions.** A coordinator on an older build sends no `heldBy`, so a writer's `rivals` is absent exactly where it is absent today — a clean degrade to current behaviour. No gate (AGENTS.md: no backwards compatibility yet). State it in the handoff.
- **`classifyCommitFailure` is unchanged.** The rivals refine the `contention` arm's error; they do not change which arm it is. By inspection.
- **The multi-collection path keeps the gap.** `CoordinatorStaleLossError` (`packages/db-core/src/transaction/errors.ts`) is the `contention` arm's other member and carries `staleAtByCollection` but no rivals; the symmetric field would be `rivalsByCollection`, driven from `TransactionCoordinator`'s own per-participant retry state. Deliberately out of scope: no consumer uses `TransactionCoordinator` directly, the change is a second retry machine's worth of work, and doing both in one run is more than one ticket. Record it as a NOTE-tagged tripwire on `CoordinatorStaleLossError` — the single-collection counterpart now names its rivals and this one does not; *if* a multi-collection writer needs the same distinction, carry it per collection the way `staleAtByCollection` is carried.

# Tests

Two new, two extended.

New, in `packages/db-core/test/collection.spec.ts` beside the existing "should give up with SyncRetryExhaustedError after maxAttempts consecutive stale failures", reusing that describe's local always-refusing transactor:

- A budget exhausted against refusals that name a rival throws with `rivals.actionIds` naming it, and `corroborated` set from which field carried it. Drive it both ways (a refusal carrying `pending`, and one carrying only `heldBy`) within the one test — it is one behaviour, the summary's precedence, and splitting it would duplicate the setup.
- A budget exhausted against refusals that name none throws with `rivals` **absent** — the negative arm of the discriminator, and what an implementation returning an empty object would fail.

This is the end-to-end contract across all four drop points, and the only genuinely new coverage. Extended, both free:

- `packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts` (already covers `answerBlocksHeld`): assert `heldBy` is present on the corroborated **and** the un-corroborated answer.
- `packages/db-core/test/network-transactor.spec.ts`, the existing pend-refusal rebuild case: assert the rebuilt refusal carries the merged `heldBy` and the narrowed `pending`, with no `transform` on the entries.

No test for `rivalsFrom` on its own — it is private, and all three of its branches are reached by the two new tests above.

# Handoff must say

That `SyncRetryExhaustedError.rivals` now exists and is how a caller tells a contended failure from a silent one, that neither error message changed, and the mixed-version degrade. Also that the multi-collection counterpart (`CoordinatorStaleLossError`) deliberately still lacks it, and where that tripwire is recorded.

# Sibling

`debt-a-transactor-failure-says-which-phase-it-failed-in` is the other half of the parent ticket. It also edits `network-transactor.ts` (the four aggregate sites, not `refusalFrom`) and the same two documents. No ordering dependency; whichever runs second should re-read those files rather than assume the regions it saw.

# TODO

- Add `StaleFailure.heldBy`, the three `heldBy?: never` siblings, and the `RivalHolders` type to `packages/db-core/src/network/struct.ts`.
- Set `heldBy` on both arms of `CoordinatorRepo.answerBlocksHeld` and rewrite its drop `NOTE:` to say what is still true.
- Carry the merged `heldBy` and the transform-stripped, deduped `pending` through `refusalFrom`, documenting the narrowing and the merge rule.
- Add the private `rivalsFrom` to `write-attempts.ts`; keep the last non-empty result in `recordRefusal` and clear it in `recordCommit`.
- Add `rivals` to `SyncRetryExhaustedError`; pass it from both construction sites and update `SyncRevisionStalledError`'s `super(...)`. Change neither message.
- Add the `rivalsByCollection` tripwire `NOTE:` to `CoordinatorStaleLossError`.
- Update `docs/offline-sync.md` §Classifying an attempt's outcome and `docs/internals.md` §Consensus Execution.
- Add the two `collection.spec.ts` tests; extend the coordinator-repo classification and network-transactor pend-refusal assertions.
- `yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck`; db-core and db-p2p suites.
