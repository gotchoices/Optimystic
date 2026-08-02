description: When a machine looks for data it does not have locally, it asks the other machines that should have a copy. Silence from them used to be treated as "that data does not exist"; now the asking machine says "I could not find out", so callers retry elsewhere instead of creating a fresh empty collection over data that really exists.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, docs/internals.md, docs/transactions.md

# Cluster read consult reports silence as silence — complete

## What shipped

`CoordinatorRepo.get` consults the cohort for any block missing locally and then reports either an
**authoritative absent** (`{ state: {} }` — `NetworkTransactor` never retries it, and
`Collection.createOrOpen` takes it as licence to create a fresh empty collection) or
**`unavailable: 'peers-unreachable'`** (a guess — the transactor retries against another peer, and a
read that exhausts retries throws `BlockUnavailableError`).

Two collapses used to make a slow or unreachable peer indistinguishable from a peer answering "I
hold nothing", so a two-node cohort with one dead peer confidently reported a block absent that the
dead peer alone held:

- the libp2p `ClusterLatestCallback` caught every transport error and returned `undefined` — the
  same value it returns when the peer genuinely holds nothing;
- the per-peer 1s timeout in `queryClusterForLatest` *resolved* `undefined` instead of rejecting, so
  a slow peer looked like an absent claim.

The implement stage made `ClusterLatestCallback` a three-way contract (resolve `ActionRev` = claim,
resolve `undefined` = "I hold nothing", **reject** = silence), switched the per-peer race from
resolve-on-expiry to reject-on-expiry, correlated `Promise.allSettled` rejections back to peer ids,
and flagged a still-missing block when any non-self cohort peer was silent (fail-closed: the silent
peer could be the sole holder). It added a `silentPeers` knob to the mesh harness, five unit specs
and three mesh specs, and verified the fix by running the new specs against the pre-fix
`coordinator-repo.ts` (all four silence scenarios reported an unflagged authoritative absent
before, flagged after; the must-stay-authoritative scenarios passed in both).

The review pass extended the same guarantee to the one hole the implementer left open, and cleaned
up the flag site. See findings.

## Review findings

### Checked

- The implement diff read first, without the handoff summary: `coordinator-repo.ts`,
  `libp2p-node-base.ts`, `mesh-harness.ts`, and both spec files.
- Every `ClusterLatestCallback` implementation in the repo (grep, non-`dist`): exactly two —
  `libp2p-node-base.ts` and the mesh harness — and both now reject on transport failure. No third
  implementation was left swallowing errors, and no consumer other than `CoordinatorRepo` calls the
  callback, so widening it to reject cannot surprise another caller.
- Quorum interaction: a silent peer is still counted in the corroboration *capacity* denominator
  (`peerIds.filter(id => id !== selfId).length`), so silence never lowers the bar a claim must
  clear. Unchanged from before, and fail-closed in the same direction.
- Self handling: self rejections are ignored rather than counted as silence, and self is still split
  out of the claim set. Consistent with the libp2p callback, whose self short-circuit reads local
  storage and returns `undefined` on a local read error.
- Timer/resource discipline: `withDeadline` clears its timer on either outcome, and both branches of
  its `Promise.race` are handled, so a callback that rejects after the deadline cannot surface as an
  unhandled rejection. The deleted `withTimeout` had no remaining callers.
- Wire/consumer compatibility: `'peers-unreachable'` is an existing `BlockUnavailableReason` with
  existing consumers (`NetworkTransactor.get` ranking, `TransactorSource.tryGet`); only its
  frequency changes.
- Test coverage across happy path, edge, error, and regression: healthy all-answered probe stays a
  one-round-trip authoritative absent; rejecting peer; hanging peer (real 1s deadline); quorum met
  past one silent peer; stale block + silent peer; a pre-fix swallowing callback pinned as the
  contract boundary; plus three mesh-harness specs including the exact field topology.
- Validation run at review: root `yarn build` clean, root `yarn lint` clean (exit 0), db-p2p
  `yarn test` **1488 passing / 44 pending / 0 failing**, db-p2p `yarn test:integration` 30 passing /
  2 pending, quereus-plugin `test:integration` 339 passing / 8 pending. No pre-existing failures
  surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

### Found and fixed in this pass

- **A corroborated revision that could not be acquired still reported an unflagged authoritative
  absent.** The implementer found this, left it as a `NOTE:` at the flag site, and asked review to
  judge it. It is the same defect class this ticket exists to fix — the cohort has just *told* the
  reader the block exists, and the reader answers "never existed", licencing `createOrOpen` to build
  a rival empty collection over live data — and it is reachable today (the two-node deployment that
  never declared `assumedClusterSize`, documented in `docs/transactions.md`, can never meet the
  content quorum, so every acquisition fails). Not conditional, so not a tripwire; small and at the
  same code site, so fixed here rather than filed. `fetchBlockFromCluster` now returns
  `{ inconclusive }` instead of `{ cohortSilent }`, where inconclusive means *either* a silent peer
  *or* a corroborated revision this node failed to converge onto. New unit spec: "flags a
  locally-missing block peers-unreachable when the cohort corroborates a revision this node cannot
  acquire". A merely-stale block is untouched by this — `get` still only downgrades a locally-missing
  block.
- **Duplicated flag-setting logic.** The success and catch paths in `get` each open-coded the same
  three-branch "set `peers-unreachable` unless there is a real answer or a sharper flag" block, with
  the success copy carrying an extra nested guard. Extracted to `flagUnconfirmedAbsence`, which
  folds the guard in so both call sites only have to establish *that* the answer is a guess. The
  15-line comment above the success call site shrank to 6 as a result.
- **Magic number.** The per-peer consult budget was an inline `1000`; the sibling acquisition bound
  is a named `RECONCILE_TIMEOUT_MS`. Now `LATEST_QUERY_TIMEOUT_MS`.
- **Stale docs.** `docs/internals.md` still stated that "the `ClusterLatestCallback` contract cannot
  tell 'peer holds nothing' from a per-peer timeout without counting responders" — the precise claim
  this change falsifies. Rewritten to describe the three-way contract, the reject-on-expiry
  deadline, the fail-closed threshold, and the new inconclusive-acquisition case.
  `docs/transactions.md` had two stale spots (the `BlockUnavailableError` section describing the
  trigger as "the consult threw", and the read-repair outcome-logs paragraph describing
  `cluster-fetch:not-restored` without mentioning that it now flags a missing block); both updated.

### Recorded as tripwires, not tickets

- The 1s per-peer consult budget is LAN-shaped. A cohort whose honest round trip exceeds it reads as
  permanently silent — safe (the read is flagged, not mis-reported) but it makes every miss cost a
  transactor-level retry. Conditional on a WAN deployment appearing, so parked as a `NOTE:` at
  `queryClusterForLatest` in `coordinator-repo.ts` telling the reader to raise the constant, not to
  soften the deadline back into an absent claim.

### New tickets filed

None, deliberately. The one finding that could have justified a ticket (corroborated-but-not-
acquired) resolved at the same code site as this ticket's own change and was cheap enough to fix
inline with a covering spec; filing it would have queued a second visit to a site that is now
correct. Nothing else in the diff needed a decision a human has to make, so nothing went to
`blocked/` either.

### Noted, out of scope, not filed

- `packages/db-p2p/src/libp2p-node-base.ts` is 1591 lines (`wc -l`) and `coordinator-repo.ts` is 958.
  Both pre-date this ticket, and this change is net-negative on the latter's comment bulk. No split
  is filed because nothing in this diff drives one — a size-debt ticket here would be an unrelated
  refactor attached to a bug fix.
- Re-measuring the embedding application where the original failure was observed still needs a run
  outside this repo. Its other prerequisite (`collection-forgets-revision-on-absent-header`) has
  landed, so nothing blocks that measurement here.
- `plan/stale-failure-carries-coordinator-revision` remains an independent improvement to the same
  diagnosis chain; nothing here depends on it or changes it.
