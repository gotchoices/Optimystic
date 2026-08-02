----
description: When a write loses a race to another writer, the node that rejected it knows which version of the data it actually holds, but only says so inside an English sentence that callers are forbidden to read. Add that number as a real field on the rejection so a stuck client can be told what it is up against instead of guessing.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/test/stale-failure.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# A stale rejection carries the responder's revision as data, not prose

## The problem

`StaleFailure` ([struct.ts:66](../../packages/db-core/src/network/struct.ts#L66)) carries `reason`,
`missing`, `pending`, and `conflict`. When a pend loses an optimistic-concurrency race, the
responder knows the revision it actually holds and puts it only into a free-form English string:

```ts
`stale revision: block ${blockId} at rev ${latest.rev}, requested rev ${request.rev}`
```

That string is wire-visible prose that is part of a signed vote payload, and both
`cluster-coordinator.ts`'s `ValidatorRejectionError` doc comment and
`CoordinatorRepo.classifyStaleRejection` state plainly that its wording must never become control
flow. That rule is right; the consequence is not. `Collection.syncInternal`
([collection.ts:437](../../packages/db-core/src/collection/collection.ts#L437)) can only retry
blindly, and when the client's revision context is wrong rather than merely behind, all ten attempts
request the same revision, learn nothing, and burn ~21 s of exponential backoff before throwing a
`SyncRetryExhaustedError` whose message is indistinguishable from ordinary contention.

The embedding application (sereus) hit this and asked for the field by name; see
`complete/1-collection-forgets-revision-on-absent-header` and
`fix/cross-node-convergence-sereus-signature-not-reproducible`, where the missing number is why a
cross-repo defect had to be diagnosed by inference from log text.

## The change

Add one optional field to `StaleFailure`, populate it at every site that **confirms** staleness
against its own local storage, carry it through the two places where `NetworkTransactor` rebuilds a
failure response from per-batch ones, and surface it in the two error messages a stuck caller
actually reads. **No retry policy changes in this pass** — see *Deliberately out of scope*.

```ts
/**
 * The block that already occupies (or is past) the requested revision, and the revision that
 * responder holds for it.
 *
 * CONFIRMED-ONLY: set this only when the producer read the revision out of its own storage.
 * A producer that merely suspects staleness — or that learned of it from another peer's
 * free-form reject text — must leave it absent. Absent means "no confirmed number", never
 * "not stale".
 *
 * DIAGNOSTIC, NOT A RETRYABILITY SIGNAL: `conflict` (read via `isConflictFailure`) remains the
 * single source of truth for "can a re-read and re-pend win?". Never branch retry decisions on
 * the presence of this field.
 */
staleAt?: { blockId: BlockId; rev: number };
```

### Why the design came out this way

**Single loser, not a list.** A pend can touch many blocks; report only the first block found at or
past the requested revision. Every confirming site already loops and returns on the first hit, so
this is a capture of a value that is in hand — no extra reads. The per-block detail a caller might
want is already carried by `missing` (an `ActionTransforms[]` with per-action `rev`) wherever the
producer could compute it; `staleAt` exists to give the one number that is otherwise unavailable,
not to duplicate `missing`.

**Highest rev wins on aggregation.** `NetworkTransactor.pend` rebuilds one response from many
per-batch responses, so it must pick. Pick the **largest** `rev` among the defined `staleAt` values
(first one wins a tie). All blocks in a single-collection pend are committed under the same
collection revision, so the numbers are comparable, and the largest is the binding constraint: the
client's next request must clear every reported holder. This differs deliberately from the adjacent
`reason` selection, which takes the first defined value — note it in a comment so the asymmetry
reads as intentional.

**Wire compatibility needs no work.** The repo protocol is plain JSON
(`JSON.parse` / `JSON.stringify` at [service.ts:250](../../packages/db-p2p/src/repo/service.ts#L250)
and :274), so an unset field simply arrives absent — the exact rollout precedent already documented
for `conflict` in [stale-failure.ts:7-9](../../packages/db-core/src/network/stale-failure.ts#L7).
No codec, no version negotiation. The mixed-version story generally is tracked in
`backlog/debt-mixed-version-identify-incompatibility`; nothing here needs it.

### Producers to populate (confirmed-local only)

- **`StorageRepo.pend`**, stale branch at
  [storage-repo.ts:413](../../packages/db-p2p/src/storage/storage-repo.ts#L413). Capture
  `{ blockId, rev: latest.rev }` from the first block in the loop at :396 whose
  `latest.rev >= request.rev` — **but only when `request.rev !== undefined`.** The same condition
  fires for an insert collision (`transforms.insert` with `request.rev ?? 0`, so `latest.rev >= 0`
  matches any existing block); that is not a revision race and must not report a `staleAt`.
- **`StorageRepo.commit`**, `missedCommits` branch at
  [storage-repo.ts:531](../../packages/db-p2p/src/storage/storage-repo.ts#L531). `CommitResult` is a
  `StaleFailure` too and `TransactorSource.transact` returns it straight to `Collection`, so the
  commit-side loss deserves the same number. Capture from the first block at :508 with
  `latest.rev >= request.rev`, skipping the idempotent-retry case at :509 (same actionId and rev is
  a no-op, not a loss).
- **`CoordinatorRepo.classifyStaleRejection`** at
  [coordinator-repo.ts:844](../../packages/db-p2p/src/repo/coordinator-repo.ts#L844). This is the
  headline site — it returns a `StaleFailure` with **no** `missing` by design, so today it carries
  no number at all. The conservative branch at :847 (rejection could not be confirmed against local
  storage) keeps throwing, unchanged and with no `staleAt`.

### Producer NOT to touch, and why

`ClusterMember.validatePendOperations`
([cluster-repo.ts:1077](../../packages/db-p2p/src/cluster/cluster-repo.ts#L1077)) does **not**
produce a `StaleFailure`. It returns `{ valid: false, reason }`, and that reason string is fed into
`computeSigningPayload` ([cluster-repo.ts:704](../../packages/db-p2p/src/cluster/cluster-repo.ts#L704)),
signed, and carried on the vote as `Signature.rejectReason`
([db-core/src/cluster/structs.ts:6](../../packages/db-core/src/cluster/structs.ts#L6)). Attaching a
structured revision there would change the signed byte layout and the `Signature` type — every peer
would have to agree on the new payload format or signature verification breaks across versions.
That is a consensus-wire change, not an additive field, and it is out of proportion to the benefit:
the coordinator's own local re-read already covers the case where the local member saw the newer
revision, which is the common one. The residual gap (only *remote* members saw it, so the
coordinator cannot confirm locally) stays exactly as the existing NOTE at
[coordinator-repo.ts:847](../../packages/db-p2p/src/repo/coordinator-repo.ts#L847) describes it —
still a throw, still no guessing from reject text. **This ticket does not close that gap**; extend
the ticket's own NOTE to say the `staleAt` field is likewise absent on that path, so the next reader
does not assume it was overlooked.

### Carriers

- **`NetworkTransactor.pend`** aggregate at
  [network-transactor.ts:558](../../packages/db-core/src/transactor/network-transactor.ts#L558) —
  add `staleAt` selected by max-rev as described above. Omit the key entirely when nothing was
  reported (match the existing `...(reason === undefined ? {} : { reason })` spread style rather
  than emitting `staleAt: undefined`).
- **`NetworkTransactor.commitBlock`** stale branch at
  [network-transactor.ts:679](../../packages/db-core/src/transactor/network-transactor.ts#L679) —
  same selection. This branch currently drops `reason` (see the NOTE at :675); do **not** silently
  change that, but do carry `staleAt`, and update the NOTE so it reads accurately afterwards.

### Consumers (report only)

- **`SyncRetryExhaustedError`**
  ([collection/struct.ts:38](../../packages/db-core/src/collection/struct.ts#L38)) — add an optional
  readonly `staleAt` constructor parameter after `lastReason`, and append a clause to the message
  when present, e.g. `…, last seen block <blockId> at rev <rev>`. Keep the existing message prefix
  byte-identical so the assertions in `collection.spec.ts` around :879 and :952 keep passing.
- **`Collection.syncInternal`**
  ([collection.ts:437-449](../../packages/db-core/src/collection/collection.ts#L437)) — track
  `lastStaleAt` alongside the existing `lastReason` (same update rule: overwrite when the new
  failure defines it, keep the previous value otherwise; clear both on forward progress at :466),
  and pass it to both `SyncRetryExhaustedError` throw sites (:415 and :448).
- **`PendRejectedError`**
  ([transaction/coordinator.ts:31](../../packages/db-core/src/transaction/coordinator.ts#L31)) —
  the multi-collection path collapses a `StaleFailure` into a message string at :938 and then into
  `pendPhase`'s `failure` string at :881. Take `staleAt` as an optional constructor argument and
  fold it into the message so the number survives the collapse. Do **not** add a structured field to
  the transaction coordinator's own `{ success: false, error: string }` result shape — that is a
  wider surface change for no consumer, and the message text is what an embedder reads today.

## Edge cases & interactions

- **Absent field behaves exactly as today.** Every consumer must treat missing `staleAt` as normal —
  an unconfirmed rejection, an older peer, `TestTransactor`, the mesh harness. No consumer may
  require it; no code path may branch retryability on it.
- **`isConflictFailure` is untouched.** Do not add `staleAt` to its expression at
  [stale-failure.ts:12](../../packages/db-core/src/network/stale-failure.ts#L12). A rejection may
  legitimately carry `staleAt` and be non-retryable, or be retryable with no `staleAt`. Guard this
  with a test rather than only a comment.
- **`request.rev === undefined` insert collision** in `StorageRepo.pend` — must produce no
  `staleAt`, as described above. This is the one place the field could be populated with a number
  that means nothing.
- **Idempotent commit retry** in `StorageRepo.commit` (`latest.rev === request.rev` and same
  `actionId`) is a `continue`, not a loss — it must not seed `staleAt` for a later block's rejection.
- **Empty-`missing` stale failure.** `classifyStaleRejection` returns
  `{ success: false, conflict: true, reason, staleAt }` with no `missing`/`pending`. Confirm the
  aggregate at network-transactor.ts:558 still reports `conflict: true` via the `some(...)` rule and
  now also carries `staleAt` — this is the exact combination the whole ticket exists to serve.
- **Mixed batches.** A pend whose batches mix a confirmed stale loss with a hard rejection: the
  aggregate keeps its current `some`-based `conflict: true` (deliberate, see the NOTE at :550) and
  carries the one `staleAt` that was reported. Assert that the hard-rejection batch contributes
  nothing.
- **Multiple `staleAt` values across batches** — assert the max-rev selection, not first-wins, with
  the higher rev deliberately arriving in the *second* batch so a first-wins implementation fails
  the test.
- **`TestTransactor` and the mesh harness never set it.** Their tests must stay green with no edits.
  If any of them needs a change, that is a signal the field became load-bearing somewhere — stop and
  re-read the "diagnostic, not a signal" contract.
- **Public surface.** `StaleFailure` is exported from `@optimystic/db-core`; adding an optional
  field is source-compatible for readers. `SyncRetryExhaustedError` and its extra constructor
  parameter are also public — keep the new parameter last and optional so existing `new` sites and
  subclasses compile unchanged.
- **`exactOptionalPropertyTypes`** is a live concern in this repo (see
  `backlog/debt-tsconfig-exact-optional-property-types`). Prefer conditional spreads over assigning
  `undefined` to the optional field, so the code stays correct if that flag lands.

## Deliberately out of scope

**Retry-policy change.** Acting on `staleAt` — having `syncInternal` detect "my next attempt will
request the exact revision the responder already holds" and fail fast instead of burning the budget
— changes behaviour for every caller and deserves review on its own. Filed as
`backlog/feat-sync-fail-fast-on-hopeless-revision`. This pass is strictly additive: carry the number
and report it.

**Quorum-read confirmation** for the remote-only staleness case at coordinator-repo.ts:847. Still a
throw; see *Producer NOT to touch* above.

## TODO

### Phase 1 — field and producers

- [ ] Add `staleAt?: { blockId: BlockId; rev: number }` to `StaleFailure` in
      `packages/db-core/src/network/struct.ts`, with the confirmed-only and diagnostic-not-a-signal
      contract documented on it.
- [ ] Populate in `StorageRepo.pend`'s stale branch, gated on `request.rev !== undefined`.
- [ ] Populate in `StorageRepo.commit`'s `missedCommits` branch, skipping the idempotent-retry case.
- [ ] Populate in `CoordinatorRepo.classifyStaleRejection`; leave the unconfirmed branch absent and
      extend its NOTE to say so explicitly.
- [ ] Leave `ClusterMember.validatePendOperations` alone; add a brief comment there pointing at the
      signed-payload reason so a future reader does not "fix" the omission.

### Phase 2 — carriers and consumers

- [ ] Carry `staleAt` through `NetworkTransactor.pend`'s rebuilt aggregate with max-rev selection,
      commented as deliberately different from `reason`'s first-wins.
- [ ] Carry it through `NetworkTransactor.commitBlock`'s stale branch and correct the stale NOTE
      above it.
- [ ] Add the optional `staleAt` parameter to `SyncRetryExhaustedError` and append it to the message.
- [ ] Track `lastStaleAt` in `Collection.syncInternal` and pass it to both throw sites.
- [ ] Add the optional `staleAt` argument to `PendRejectedError` and fold it into its message.

### Phase 3 — tests

- [ ] `packages/db-core/test/stale-failure.spec.ts` — add cases proving `isConflictFailure` is
      unchanged by `staleAt`: `{ success: false, staleAt }` with no other field is **not** a
      conflict, and `{ success: false, conflict: false, staleAt }` stays non-retryable.
- [ ] `packages/db-core/test/network-transactor.spec.ts` — aggregate selection: two stale batches
      whose `staleAt` revs differ (higher one second) yields the higher; a batch with no `staleAt`
      contributes nothing; an all-absent aggregate omits the key rather than emitting `undefined`.
- [ ] `packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts` — the confirmed path now
      returns `staleAt: { blockId, rev }` matching the block that advanced; the unconfirmed path
      still throws `ValidatorRejectionError` and produces no `staleAt`.
- [ ] `packages/db-p2p/test/storage-repo.spec.ts` — pend stale returns `staleAt`; a pend with
      `rev === undefined` that collides on an insert returns **no** `staleAt`; a commit that lost to
      a newer revision returns `staleAt`; an idempotent commit retry does not.
- [ ] `packages/db-core/test/collection.spec.ts` — a sync exhausted against a transactor that
      reports `staleAt` throws a `SyncRetryExhaustedError` whose `staleAt` property is set and whose
      message names the revision; a transactor that reports none produces today's message verbatim.
- [ ] JSON round-trip: assert `JSON.parse(JSON.stringify(failure))` preserves `staleAt`, and that a
      response with the field stripped (an older peer) still classifies and retries identically.
      Small enough to live in `stale-failure.spec.ts`; no repo-service integration test needed.

### Phase 4 — validation

- [ ] `yarn test` in `packages/db-core` and `packages/db-p2p`, streamed (`2>&1 | tee`), both green
      with no edits to `TestTransactor` or the mesh harness.
- [ ] `yarn build` from root (or per-package `tsc`) — the new optional field must not break any
      consumer that constructs a `StaleFailure` literal.
