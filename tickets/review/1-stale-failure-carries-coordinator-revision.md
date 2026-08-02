description: A node that rejects a write because someone else got there first now reports the version number it actually holds as a proper field, instead of burying it in an English sentence callers are forbidden to read. Purely additive — nothing retries differently.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/test/stale-failure.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts
difficulty: medium

# Review: `StaleFailure.staleAt` — the responder's revision as data

## What shipped

One new optional field on `StaleFailure`
([db-core/src/network/struct.ts:82](../../packages/db-core/src/network/struct.ts#L82)):

```ts
staleAt?: { blockId: BlockId; rev: number };
```

Its contract, documented on the field itself, has two halves:

- **Confirmed-only.** A producer sets it only when it read the revision out of its *own* storage.
  Suspicion, or a number lifted from another peer's free-form reject text, must leave it absent.
  Absent means "no confirmed number", never "not stale".
- **Diagnostic, not a retryability signal.** `conflict` (read via `isConflictFailure`) stays the
  single source of truth for "can a re-read and re-pend win?". No code branches retry decisions on
  this field, and a test enforces that `isConflictFailure` ignores it entirely.

Nothing retries differently as a result. This pass carries the number and reports it; acting on it
is `backlog/feat-sync-fail-fast-on-hopeless-revision`.

## Where it is produced (three sites, all confirmed-local)

| Site | Condition | Notes |
|---|---|---|
| `StorageRepo.pend` stale branch | first block with `latest.rev >= request.rev` | **gated on `request.rev !== undefined`** |
| `StorageRepo.commit` `missedCommits` branch | first block with `latest.rev >= request.rev` | idempotent-retry `continue` never seeds it |
| `CoordinatorRepo.classifyStaleRejection` | the block the local re-read confirmed | the headline site — this failure carries no `missing`, so `staleAt` is the only number available |

Deliberately **not** produced by `ClusterMember.validatePendOperations`
([db-p2p/src/cluster/cluster-repo.ts:1070](../../packages/db-p2p/src/cluster/cluster-repo.ts#L1070)).
That path returns `{ valid: false, reason }`, and the reason string is fed to
`computeSigningPayload`, signed, and carried as `Signature.rejectReason` — adding structure there
changes the signed byte layout and breaks verification across versions. A comment now sits at that
`return` explaining why the omission is intentional, so nobody "fixes" it.

## Where it is carried and reported

- `NetworkTransactor.pend` aggregate — **max-rev** selection across batches (undefined entries
  contribute nothing; ties keep the earlier batch). Deliberately unlike the adjacent `reason`, which
  is first-wins; both the asymmetry and its assumption are commented at the site. Extracted as the
  exported helper `highestStaleAt`.
- `NetworkTransactor.commitBlock` stale branch — same selection. That branch still drops the prose
  `reason`; its NOTE was corrected to say the machine-readable fact now survives and only the
  wording is lost.
- `SyncRetryExhaustedError` — new **last, optional** readonly constructor parameter after
  `lastReason`; appends `, last seen block <id> at rev <n>` to the message when present. The
  existing prefix is byte-identical when absent.
- `Collection.syncInternal` — tracks `lastStaleAt` beside `lastReason` (same overwrite-when-defined
  rule, both cleared on forward progress), passed to both throw sites.
- `PendRejectedError` — new last optional constructor argument, folded into the message so the
  number survives `pendPhase` collapsing the error into a plain `error: string`. No structured field
  was added to the transaction coordinator's result shape.

## How to validate

```bash
cd packages/db-core && yarn build && yarn test
cd packages/db-p2p && yarn build && yarn test
cd ../.. && yarn lint && yarn build && yarn test
```

**Results as run:** db-core 1337 passing; db-p2p 1494 passing / 44 pending; full monorepo `yarn test`
green across every workspace (0 failing anywhere); `yarn lint` and root `yarn build` clean. No edits
were needed to `TestTransactor`, `FlakyCommitTransactor`, or the mesh harness — the collection test
that needs a `staleAt`-reporting transactor defines a local one rather than teaching the shared
harness to set the field.

### Cases the tests pin

**`stale-failure.spec.ts`** — `isConflictFailure` is unmoved by the new field: `staleAt` alone is
not a conflict; `conflict: false` + `staleAt` stays hard; `conflict: true` + `staleAt` stays
retryable. Plus a JSON round trip (the field survives `JSON.parse(JSON.stringify(...))`) and the
older-peer case (field stripped → identical classification).

**`network-transactor.spec.ts`** — aggregate selection run **both ways round** (higher rev in the
second batch, then in the first) so a first-wins implementation cannot pass by luck; a batch with no
`staleAt` contributes nothing but does not blank out the real one; an all-absent aggregate **omits
the key** rather than emitting `staleAt: undefined`; the empty-`missing` confirmed-loss shape carries
both `conflict: true` and `staleAt`; the commit-side rebuild carries `staleAt` while still dropping
`reason`. Direct unit tests on `highestStaleAt` cover tie-breaking and interleaved undefineds.

**`storage-repo.spec.ts`** — pend against a taken revision reports the *held* rev, not the requested
one; an insert collision on a request with no `rev` reports **no** `staleAt` (and the key is absent);
a commit that lost to a newer revision reports one; an idempotent retry succeeds with none; and a
mixed batch where block-1 is the idempotent no-op and block-2 genuinely lost reports **block-2** —
proving the `continue` does not seed the field for a sibling.

**`coordinator-repo-stale-classification.spec.ts`** — the confirmed path returns
`staleAt: { blockId, rev }` matching the block that advanced (including the multi-block case where
the stale block is not the first scanned and is ahead by more than one revision); the unconfirmed
path still throws `ValidatorRejectionError` with no `staleAt`; and a new case covers the
remote-only-staleness gap (local storage behind both the request and the peers) — still a throw,
still no number.

**`collection.spec.ts`** — exhaustion against a transactor reporting `staleAt` sets the error
property and names the revision in the message while keeping the existing prefix; a transactor
reporting none produces today's message *verbatim* (asserted with `to.equal`, not `to.contain`); and
`lastStaleAt` survives a later failure that reports no number.

### Manual/usage check for a reviewer

The shape a stuck embedder now sees, end to end: lose an optimistic-concurrency race under
`Collection.sync` against a `CoordinatorRepo` that can confirm the loss locally, let the retry budget
exhaust, and read the thrown `SyncRetryExhaustedError` — `err.staleAt` is populated and
`err.message` ends with `, last seen block <id> at rev <n>`. Previously that number existed only
inside a wire-visible reason string that callers are forbidden to parse.

## Known gaps and things worth a reviewer's eye

- **Remote-only staleness is still uncovered.** When only *remote* cluster members saw the newer
  revision, `CoordinatorRepo.classifyStaleRejection` cannot confirm locally, so it still throws and
  reports no number. The existing NOTE at that site was extended to say `staleAt` is absent there
  deliberately. Closing it needs a quorum read — explicitly out of scope, and there is now a test
  pinning the current behaviour so a future change is a visible decision.
- **`StorageRepo.pend` only emits `staleAt` when it actually returns a stale failure**, which is
  gated on `missing.length` — pre-existing behaviour, untouched. If the revision branch fires but
  `listRevisions` yields nothing, pend proceeds as before and no failure (hence no `staleAt`) is
  produced. Worth a second opinion on whether that gate is right, but it is not a change this ticket
  made.
- **The `pendings` rejection branch** in `StorageRepo.pend` (policy `'f'`/`'r'`) returns
  `conflict: true` with no `staleAt`. Correct under the confirmed-only contract — a rival *pending*
  action is not a revision race and there is no revision to report — but it is a place a reader might
  expect the field and not find it.
- **`PendRejectedError` folds the number into a message string** rather than exposing a field. That
  matches how `pendPhase` consumes it (it reads `.message`), but it means a programmatic consumer of
  the multi-collection path still has to read prose. Deliberate per the ticket; flagging it because
  it is the one consumer where the "prose is not an API" principle is only half honoured.
- **Tripwire parked in code, not filed as a ticket:** the max-rev aggregation compares revisions from
  different blocks, which is only meaningful because a single pend covers a single collection. A
  `NOTE:` at
  [network-transactor.ts:562](../../packages/db-core/src/transactor/network-transactor.ts#L562)
  records that if pends are ever allowed to span collections, the comparison is across unrelated
  revision counters and the selection must become per-collection.
- **`exactOptionalPropertyTypes` readiness:** every write of the field uses a conditional spread
  (`...(staleAt === undefined ? {} : { staleAt })`) rather than assigning `undefined`, so the code
  stays correct if `backlog/debt-tsconfig-exact-optional-property-types` lands. Two tests assert the
  key is genuinely absent rather than present-and-undefined.
