description: A machine that had just joined a group and was still catching up could veto other machines' writes, because its vote rebuilt the whole block just to check a version number. The vote now reads the version number and the pending reservations straight from storage's bookkeeping, so a catching-up machine is judged the same whether or not it can rebuild the block yet.
files: packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations, judgeStaleRevisions, onceGet, heldLatestOf, rivalClaimsOn, reservingRivals, noteStaleLossUnvoted, validateCommitRevisions NOTE), packages/db-p2p/src/storage/storage-repo.ts (IHeldRevisionReader and IPendingClaimReader doc comments, the NOTE in get's per-block catch), packages/db-p2p/test/cluster-repo.spec.ts ("update - the pend vote reads metadata, not blocks"), docs/internals.md (the "three answers" bullet)
difficulty: medium
----
Reported from sereus on `@optimystic/*` 1.12.0: a strand replica that had just joined a 3-member cohort and was still pulling blocks voted `reject` with `block <id> unavailable (unmaterializable): cannot verify revision`, which failed the write non-retryably about 1 run in 4 under load.

## What was wrong

The promise-round vote (`ClusterMember.validatePendOperations`) needs two facts per block, both kept in storage metadata: the committed `latest` revision (stale-revision check) and the pending records with their claimed slots (reservation / `held` check). It fetched them through a full `StorageRepo.get`, so:

- **Arm 1.** A member whose held `latest` would not materialize got `{ state: {}, unavailable: 'unmaterializable' }` back and voted reject, although it knew the revision. A member holding *no* metadata for the block approved — two shapes of "no usable base here" with opposite answers.
- **Arm 2.** `get` lists `state.pendings` only beside a block it materialized, so a rival's pending record on a block with no committed revision (or an unmaterializable one) was invisible to the vote, though `StorageRepo.pend` refuses it at apply.

## What changed (commit `ticket(implement): catching-up-member-vetoes-pends-it-cannot-verify`)

- `validatePendOperations` reads `latest` via `IHeldRevisionReader.heldRevisions` (`heldLatestOf`) and rivals via `IPendingClaimReader.listPendingClaims` (`rivalClaimsOn`) — the same reads `StorageRepo.pend` makes at apply. A block whose metadata cannot be read is "no answer, no veto", logged as `cluster-member:validation-block-unavailable` (with `actionId`, `requestedRev`). The `cannot verify revision` reject is gone. Stale check extracted as `judgeStaleRevisions`; `reservingRivals` is now synchronous over claims.
- Fallbacks for a repo without those capabilities (test doubles) do one memoized `get` per vote (`onceGet`); an `unavailable` entry is "no answer", and `state.pendings` become claims with no slot, which `isReservationAgainst` counts as reserving.
- `noteStaleLossUnvoted` uses `heldLatestOf`, so it and the vote share one stale rule.
- Docs: `docs/internals.md` "three answers" bullet rewritten; doc comments on `IHeldRevisionReader` / `IPendingClaimReader` and the `NOTE:` in `StorageRepo.get`'s catch updated.

Behaviour changes (all move a refusal storage already made at apply one round earlier, or remove a veto): tombstoned blocks are now judged stale at the vote; two writers creating the same collection get a retryable `held` at the vote; a member that cannot read a block's metadata no longer blocks consensus alone (caught-up members, the fork guard in `StorageRepo.internalCommit`, and the majority durability gate in `CoordinatorRepo.commit` still stop a stale write).

## Review findings

Read the implement diff first, then every touched file and the docs that describe the vote.

- **Correctness — checked, no defect.** `heldRevisions` reads `getLatest()` per block with a per-block catch, exactly what `StorageRepo.pend` reads, so vote and apply agree on staleness (including tombstones). `rivalClaimsOn` filters the voter's own action, so a redelivered pend stays approvable. Fallback claims carry no `rev`, and `isReservationAgainst` returns `true` for that, so the degraded path never silently admits a rival. `staleRevisionAgainst` still applies the `isOwnRevision` carve-out. Ordering (stale → slot holds → rivals → validation) is unchanged. Multiple pend operations in one record each get their own `onceGet`, which is correct.
- **Error handling — checked.** A `listPendingClaims` throw is logged and falls back to `get`. A throwing `heldRevisions` can only come from a decorator (the real one catches per block) and escapes like a throwing `get` always did; the handoff states this, no change.
- **Performance — checked.** The vote now does two metadata reads per block instead of one `get` that could materialize and even restore from a peer (`readBlockHealing`) — strictly cheaper, and no network I/O on the vote path any more.
- **Interaction — found, parked as a tripwire.** `validateCommitRevisions` (commit-round revision check) still reads through `get`, so a catching-up member abstains there where it could judge. Abstaining is the safe direction and other checks cover the window, so not a defect; `NOTE:` added at the `get` call in `validateCommitRevisions`.
- **Docs — checked.** `docs/internals.md` updated by the implementer; `docs/repository.md` (rival scans), `docs/correctness.md` (pend refusal reporting, commit revision staleness) and `docs/debugging.md` contain no reference to the removed reject or to the vote reading `get`. `yarn lint:docs` passes.
- **Tests — checked, none added or cut.** The two `StorageRepo`-backed tests reproduce arm 1 and arm 2 at the lowest layer, with preconditions pinning the storage shape. The fallback test pins the reversed "no answer → approve + log" contract and replaces the old test that pinned the reject; kept, since it is the only check of that rule.
- **Source hygiene — checked.** New methods are small and single-purpose; comments say why (signed-payload layout, why metadata), not what. `cluster-repo.ts` is a large file but this change did not grow it materially (net ~+40 lines).
- **Type safety — checked.** No `any`; capability probes use `Partial<…>` casts in the established pattern.

Validation (this pass): `npx tsc --noEmit -p tsconfig.json` and `npx eslint` on the changed files clean; `yarn lint:docs` clean; `OPTIMYSTIC_SKIP_BUILD_CHECK=1 yarn test` in `packages/db-p2p`: 3275 passing, 70 pending, 0 failing; `OPTIMYSTIC_SKIP_BUILD_CHECK=1 yarn test:integration`: 50 passing, 2 pending. The build-freshness skip was needed because `C:\projects\Fret` has another person's uncommitted edits (the guard reports `p2p-fret` stale); this change touches nothing in Fret. The quereus-plugin suites and full `yarn check` were not run.

## Known gaps (carried from implement)

- The root cause of the sereus member's unmaterializable `latest` is still not identified; this fix removes the vote's dependence on it. If anything similar recurs, capture with `optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage` in the debug namespaces — the `get:unmaterializable … error=…` line names the path.
- If `listPendingClaims` throws on a real `StorageRepo`, the `get` fallback lists no rivals on a block with no committed revision; the apply-time scan in `StorageRepo.pend` is the backstop.
- Out of scope: the report's second fingerprint, `commit-not-durable: 0 of 3 cohort member(s) report holding rev 8 … (local-executed)` (seen once on 1.11.0); no code site found.
