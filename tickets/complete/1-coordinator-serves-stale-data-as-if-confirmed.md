----
description: A node that could not check whether its copy of a shared record was current used to hand that copy out as if it were confirmed, so readers could work from out-of-date data forever with no error. The answer now carries a doubt marker that triggers a retry against another node, and a read that still cannot be confirmed fails loudly instead of quietly serving stale data.
files: packages/db-core/src/network/struct.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-core/test/collection.spec.ts, docs/internals.md, docs/transactions.md, packages/db-core/src/collections/tree/readme.md
----

# Complete: a coordinator no longer serves stale content as if it were confirmed

Implemented in `d61fd40` (with the type and error class from the interrupted prior run in
`507e286`); reviewed and amended in this pass.

## What shipped

Confidence about *currency* now survives from the coordinator that formed it, through the
transactor merge, to the reader that acts on it — mirroring the existing three-valued answer
about *existence*:

- **`GetBlockResult.unconfirmedAheadRev`** — optional, set when a repo served real committed
  content it could not confirm is current, because a cohort peer claimed a strictly higher
  revision the repair pass could neither corroborate nor acquire. Absent means confirmed, so
  every producer that never sets it keeps its meaning. Crosses the wire with the rest of the
  result object.
- **`BlockPossiblyStaleError`** — sibling of `BlockUnavailableError` (existence) for currency.
  Not a `StaleFailure`, so `Collection.sync` surfaces it rather than absorbing it into its
  rebase-and-retry loop.
- **`CoordinatorRepo`** — carries an unsettled cohort claim up out of both non-converging
  consult shapes, remembers it per block, and stamps it onto an answer only when the entry has
  a committed revision, that revision is still below the claim, and the requested view should
  contain the claim (unpinned, or pinned at/above it).
- **`NetworkTransactor`** — a marked entry does not count as answered, so it earns the
  second-chance retry against a different coordinator; the per-block merge ranks confirmed
  block > unconfirmed block > authoritative absent > unconfirmed absent > unavailable, so the
  fresh answer the retry fetched wins over the stale one that provoked it. `getStatus` throws
  rather than judging an action from a state it could not confirm.
- **`TransactorSource.tryGet` / `Collection.bootstrapContext`** — a surviving marker throws for
  any read whose view should contain the claim. The collection log-tail read is the seam that
  froze a view in the field.

## Review findings

### Fixed in this pass (minor, both in the shipped change)

- **A read pinned at or above the claim silently served the stale content.**
  `TransactorSource.tryGet` threw only on unpinned reads, but the coordinator deliberately
  stamps pins at/above the claim (its own spec asserts this) — precisely the pins whose
  snapshot *should* contain the claimed revision. Those reads served older content and
  recorded a read dependency at the stale revision, silently. `tryGet` now applies the same
  at/above test the coordinator applies when stamping; pins strictly below the claim still
  serve, unchanged. `packages/db-core/src/transactor/transactor-source.ts`, new spec in
  `packages/db-core/test/transactor-source.spec.ts`.
- **The doubt evaporated for the read-repair window.** A corroborated-but-unacquired consult
  marks the block seen, so in the default `lazy` mode the next reads within
  `readRepairWindowMs` (10 s default) skip the consult entirely — and the mark lived only in
  that consult's return value, so every one of those reads served the same content as
  confirmed. That is the original defect, reopened 10 s at a time; every existing spec used
  `paranoid` mode, where consults always run, so nothing saw it. `CoordinatorRepo` now
  remembers the unsettled claim per block (LRU-bounded, alongside the existing seen-map) and
  stamps from it when the consult is skipped or fails; only a consult that actually ran may
  clear it, or the node reaching the claimed revision.
  `packages/db-p2p/src/repo/coordinator-repo.ts`, three new specs in
  `packages/db-p2p/test/coordinator-repo-unavailable.spec.ts` (mark survives a skipped
  consult; mark dropped when a later consult finds nothing ahead; mark dropped when this node
  catches up).

### Docs (were out of date; corrected here)

- `docs/transactions.md` had a reader-facing section for `BlockUnavailableError` and no
  mention of its new sibling — the implement pass documented the change only in
  `docs/internals.md`. Added an "Unconfirmable reads: `BlockPossiblyStaleError`" section
  stating which reads throw and which are served, in plain language.
- `docs/internals.md` — corrected the pinned-read rule (it stated pinned reads always keep
  working, which the fix above makes wrong) and documented that the doubt outlives the
  consult that formed it.
- `packages/db-core/src/collections/tree/readme.md` — the committed-read-view contract listed
  only `BlockUnavailableError`; pinned views can now also raise `BlockPossiblyStaleError`, so
  the bullet's neighbour was added.

### Tripwire (recorded in code, not filed as a ticket)

- **One uncorroborated claim is enough to raise doubt**, and a claim is a bare assertion with
  no certificate behind it — so a single lying cohort peer can deny unpinned reads of a block
  it falsely claims to be ahead on, an availability lever it did not have while uncorroborated
  claims were discarded. Fine now (the alternative is the silent stale serve this work exists
  to end, and the same peer can already force an unconfirmable absence just by staying quiet);
  the revisit condition is commit-certificate verification landing, at which point the stamp
  should be gated on a verified certificate. Parked as a `NOTE:` at the no-quorum return in
  `queryClusterForLatest` and summarised in the `docs/internals.md` currency bullet.

### Filed elsewhere

- **The implementer's flagged gap — a missing block behind an uncorroborated claim still reads
  as an authoritative absent — was appended as a second arm to the open
  `fix/isolated-read-cannot-confirm-a-never-written-block`**, not filed fresh: that ticket
  already claims the same decision site (`CoordinatorRepo.get`'s flagging of missing blocks),
  already contemplates exactly this "one peer claimed a revision" vs "nobody claimed anything"
  distinction in its candidate shapes, and pulls the opposite direction at the same lines —
  resolving them apart would land one blind to the other.
- **`backlog/debt-freshness-state-scattered-across-coordinator-repo`** — the freshness concern
  is a contiguous ~450-line span of an 1122-line class (measured with `wc -l`) whose state a
  read must consult from several places with nothing forcing it to. That shape is what let the
  second finding above happen; the ticket asks for one collaborator owning the question, not a
  cosmetic split.

### Checked and left alone

- **The merge ranking, including the confirmed-vs-unconfirmed split.** Re-derived it: without
  the split, the stale marked entry and the fresh confirmed one its own retry fetched tie, and
  only strictly-greater rank replaces, so first arrival (the stale one) wins. Ranking of
  blockless entries is unchanged for every pre-existing shape.
- **Stamping a committed tombstone behind a claim.** The implementer flagged it for an opinion.
  It is right as written: the node's newest revision really is behind the claim, so a delete
  may itself have been superseded; it ranks as an unconfirmed absent and throws on the reads
  that should contain the claim, like any other marked entry.
- **Wire crossing and public surface.** The repo protocol serialises the whole result object as
  JSON, so the new field needs no plumbing; `BlockPossiblyStaleError` is exported through the
  existing `network/index.ts` barrel.
- **Error handling on the throw path.** `collection.ts` has no `catch` at all, so the new error
  propagates out of `sync`/`update`/`open`/`createOrOpen` as documented — verified rather than
  assumed.
- **The accepted-tradeoff `NOTE:` at the `tryGet` throw site** (partitioned node now fails loudly
  instead of reading stale) stands as the implementer wrote it; only its wording was widened to
  match the corrected pinned-read rule. Not re-litigated — its revisit condition has not tripped.
- **The mesh harness cannot model asymmetric reachability** (a peer silenced for one observer
  only), so the end-to-end spec uses the observable equivalent. Noted by the implementer, still
  true, and a harness extension is already tracked in `backlog/debt-mesh-harness-arms-real-gates`.

### Not covered

- **`yarn test:integration` (real-socket libp2p specs) was not run.** Its wall-clock exceeds the
  runner's idle limit, so it is not agent-runnable; a human or CI pass is the honest final check.
  Nothing in the changed seams is exercised there beyond what the mesh end-to-end spec covers.
- No performance measurement was taken of the extra read-repair consults a marked block draws;
  the retry is bounded to one round per read, and no magnitude is claimed here.

## Validation

Run from the repo root, all green after this pass:

- `yarn lint` — clean.
- `yarn build` — clean (this repo has no separate per-package typecheck script; `tsc` runs as
  the build).
- `yarn test` — db-core 1365 passing (+1 this pass), db-p2p 1579 passing (+3 this pass), all
  other workspaces unchanged and passing. No pre-existing failures surfaced.
