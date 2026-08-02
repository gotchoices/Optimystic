description: A node that rejects a write because someone else got there first now reports the version number it actually holds as a proper field, instead of burying it in an English sentence callers are forbidden to read. Purely additive — nothing retries differently.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/docs/transactor.md, packages/db-core/docs/collections.md, docs/internals.md, packages/db-core/test/stale-failure.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts

# Complete: `StaleFailure.staleAt` — the responder's revision as data

## What shipped

One new optional field on `StaleFailure`
([db-core/src/network/struct.ts:82](../../packages/db-core/src/network/struct.ts#L82)):

```ts
staleAt?: { blockId: BlockId; rev: number };
```

Its contract has two halves, documented on the field itself:

- **Confirmed-only.** A producer sets it only when it read the revision out of its *own* storage.
  Suspicion, or a number lifted from another peer's free-form reject text, must leave it absent.
  Absent means "no confirmed number", never "not stale".
- **Diagnostic, not a retryability signal.** `conflict` (read via `isConflictFailure`) stays the
  single source of truth for "can a re-read and re-pend win?". No code branches retry decisions on
  the field, and a test enforces that `isConflictFailure` ignores it entirely.

Nothing retries differently. This work carries the number and reports it; acting on it is
`backlog/feat-sync-fail-fast-on-hopeless-revision`.

### Produced at three sites, all confirmed-local

| Site | Condition |
|---|---|
| `StorageRepo.pend` stale branch | blocks with `latest.rev >= request.rev`, **gated on `request.rev !== undefined`** |
| `StorageRepo.commit` `missedCommits` branch | blocks lost to a newer revision; the idempotent-retry `continue` never seeds it |
| `CoordinatorRepo.classifyStaleRejection` | the blocks the local re-read confirmed — the headline site, since that failure carries no `missing` |

Deliberately **not** produced by `ClusterMember.validatePendOperations`: that reason string is fed to
`computeSigningPayload`, signed, and carried as `Signature.rejectReason`, so structuring it would
change the signed byte layout and break verification across versions. A comment at that `return`
explains the omission.

### Carried and reported

- `NetworkTransactor.pend` and `.commitBlock` aggregates — highest-rev selection across batches.
- `SyncRetryExhaustedError` — new last optional readonly constructor parameter; appends
  `, last seen block <id> at rev <n>` to the message when present, byte-identical when absent.
- `Collection.syncInternal` — tracks `lastStaleAt` beside `lastReason` (same overwrite-when-defined
  rule, both cleared on forward progress), passed to both throw sites.
- `PendRejectedError` — new last optional constructor argument folded into the message, so the number
  survives `pendPhase` collapsing the error into a plain `error: string`.

The repo protocol is plain JSON (`db-p2p/src/repo/service.ts` does `JSON.stringify`/`JSON.parse`), so
the field needs no codec and no version negotiation; a peer on an older build simply omits it. Both
halves are pinned by tests.

### Validation as run in this pass

```bash
cd packages/db-core && yarn build && yarn test    # 1337 passing
cd packages/db-p2p && yarn build && yarn test     # 1497 passing / 44 pending
cd ../.. && yarn lint && yarn build && yarn test  # clean; 0 failing across every workspace
```

## Review findings

### Fixed in this pass

**Highest-rev selection was applied only at the aggregate, not at the producers** (correctness /
consistency). `NetworkTransactor` selected the *largest* `rev` across batches, with a comment
justifying it — "the client's next request has to clear every holder, not just the first one that
answered". But all three producers selected the *first block scanned*: `StorageRepo.pend` guarded on
`staleAt === undefined`, `StorageRepo.commit` used `staleAt ??=`, and
`CoordinatorRepo.classifyStaleRejection` returned on its first confirmation. Blocks of one collection
routinely sit at different revisions (an action that touched only one advances only that one), so a
responder holding block A at rev 5 and block B at rev 9 reported 5 — and the aggregate's max across
responders then propagated that understated number. The stated invariant was not actually delivered,
and block iteration order (not the data) decided the answer.

Fixed by making every site use one rule:

- `highestStaleAt` moved from `transactor/network-transactor.ts` to
  [`network/stale-failure.ts`](../../packages/db-core/src/network/stale-failure.ts) beside
  `isConflictFailure` — it is a `StaleFailure` utility, not a transactor one, and the move is what
  lets db-p2p reuse it through the package index instead of re-deriving the comparison three times.
  Its doc comment now carries the selection rule, the reason it is a max, and the
  one-pend-one-collection assumption (moved there from the transactor call site, where it had been
  parked as a tripwire).
- The three producers call it; `classifyStaleRejection` now scans every block and names the highest
  in **both** `staleAt` and the `reason` prose, so the two can never disagree.

Purely diagnostic today, so no behaviour outside the reported number changes. Three regression tests
added, each constructed so the lower-revision block is scanned first and a first-wins implementation
fails: `storage-repo.spec.ts` on the pend side and the commit side, and
`coordinator-repo-stale-classification.spec.ts` (which also asserts the reason prose agrees).

**Docs were out of date** (three files, all read in full rather than skimmed):

- `packages/db-core/docs/transactor.md` enumerated the whole `StaleFailure` type and omitted the new
  field. Added it, plus a "The lost-to revision (`staleAt`)" section covering both contract halves,
  the highest-rev selection rule, and the consumers.
- `docs/internals.md` § the pend-rejection bullets described the confirmed-loss response in detail
  and said nothing about the number now riding on it. Added a bullet covering the confirmed-only
  contract, the diagnostic-only status, the shared selection rule, and the deliberate `ClusterMember`
  omission.
- `packages/db-core/docs/collections.md` § Sync Process described `SyncRetryExhaustedError` without
  its new payload. Added a sentence to the prose bullet. Its adjacent pseudo-code block was left
  alone deliberately: it is an illustrative sketch that already predates several renames
  (`trxContext`/`actionContext`, `update()`/`updateInternal()`, no `lastReason`), so patching one
  constructor argument inside it would imply a currency it does not have.

### Checked and found sound — no action

- **Wire path.** Traced end to end: `CoordinatorRepo` → `RepoClient`/`repo/service.ts` (plain JSON,
  no field whitelist) → `NetworkTransactor` → `TransactorSource.transact` (forwards the whole
  `StaleFailure` object, both pend-side and commit-side) → `Collection.syncInternal` →
  `SyncRetryExhaustedError`. No layer drops or reshapes the field.
- **`isConflictFailure` is genuinely unaffected** — it reads `conflict ?? missing/pending`, never
  `staleAt`, and three table-driven cases pin that (`staleAt` alone, `conflict:false` + `staleAt`,
  `conflict:true` + `staleAt`).
- **Constructor-signature compatibility.** Both `SyncRetryExhaustedError` and `PendRejectedError`
  take the new argument **last and optional**, so no existing call site shifts positionally. Only two
  `SyncRetryExhaustedError` construction sites exist (both in `collection.ts`, both updated); the
  coordinator's multi-collection retry path throws a different error and needs no change.
- **`exactOptionalPropertyTypes` readiness.** Every write uses a conditional spread rather than
  assigning `undefined`, so `backlog/debt-tsconfig-exact-optional-property-types` will not break the
  code. Two tests assert the key is genuinely absent, not present-and-undefined.
- **Resource cleanup / error handling.** Nothing new is allocated, opened, or awaited on any path;
  `highestStaleAt` is pure. The classification re-read's existing failure handling (read error →
  conservative rethrow, no fabricated result) is unchanged and still tested.
- **Source size.** No file crossed a size threshold this ticket did not already sit at. Measured with
  `wc -l`: `storage-repo.ts` 886, `coordinator-repo.ts` 974, `network-transactor.ts` 900,
  `collection.ts` 569, `stale-failure.ts` 43. The net change is roughly ±10 lines per file, and the
  `highestStaleAt` move made `network-transactor.ts` smaller. No size-debt ticket filed.

### Tripwires parked, not filed

- **The `pendings` rejection branch** in `StorageRepo.pend` (policy `'f'`/`'r'`) returns
  `conflict: true` with no `staleAt`. Correct under the confirmed-only contract — a rival *pending*
  action is not a revision race and there is no revision to report — but a reader may expect the
  field there. Parked as the existing comment on the field's contract; no code change.
- **`PendRejectedError` folds the number into a message string** rather than exposing a field,
  because `pendPhase` collapses the error to `.message` and the transaction result shape carries only
  `error: string`. This is the one consumer where "prose is not an API" is half honoured. Only
  becomes work *if* a programmatic consumer of the multi-collection path needs the number — parked in
  the constructor's existing comment, which states exactly this.
- **Cross-collection pends** would break the comparison (revisions from unrelated counters). The
  implementer parked this as a `NOTE:` at the transactor call site; this pass moved it into
  `highestStaleAt`'s doc comment, which is now the single place the comparison happens.

### Known gap, deliberately left open

**Remote-only staleness still reports no number.** When only *remote* cluster members saw the newer
revision, `CoordinatorRepo.classifyStaleRejection` cannot confirm locally, so it still throws and
carries no `staleAt` — inventing one from the peers' reject prose is exactly what the field's
contract forbids. Closing it needs a quorum read, which is out of scope. This is not speculative and
not a tripwire: it is a real coverage limit with a documented reason and a test pinning the current
behaviour, so any future change to it is a visible decision rather than a silent one.

### Categories with nothing to report

- **Test failures:** none. All workspaces green (0 failing), lint clean, root build clean. Nothing
  written to `tickets/.pre-existing-error.md` because no test failed, pre-existing or otherwise.
- **New tickets filed:** none. The one correctness finding resolved at a single code site (the
  selection rule) and was small enough to fix in this pass; the remaining concerns are either
  conditional (parked as tripwires above) or a scoped, documented gap that already has a follow-up
  path.
