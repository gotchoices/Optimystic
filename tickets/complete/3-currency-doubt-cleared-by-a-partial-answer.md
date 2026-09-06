description: A warning that "a newer version of this record may exist" could previously be erased by any machine replying "I don't have it", even the ones that never knew about the newer version; now only the machines that raised the warning can retire it — or revise it down.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts
  - docs/internals.md
  - tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
----

# Complete: claim provenance in `CoordinatorRepo`'s freshness memo

## What landed

`CoordinatorRepo` stamps `unconfirmedAheadRev` on reads it serves below a cohort peer's claim of a
revision it could not acquire, and remembers that claim per block. The memo now records **who
claimed it**, and one rule governs every way the memo can get weaker:

> A recorded claim may be weakened — retired, or revised down to a lower revision — when at least
> one non-self cohort member answered this consult AND no peer that MADE the claim was silent in it.

Raising a claim needs no licence: a higher claimed revision stamps everything the one it replaces
did and more. Doubt settles by **cohort membership, not a timer** — a claimant that is neither in
`answered` nor in `silent` has left `findCluster`'s view and stops blocking.

Implement stage delivered the retirement half (`CurrencyVerdict.refuted` → `nothing-ahead` carrying
`answered`/`silent`, `AheadClaimState.claimants`, the retirement gate in `recordAheadClaim`, a new
`cluster-fetch:claim-unrefutable` log line, six specs, and the `docs/internals.md` rewrite). The
review pass extended the same gate to the replacement direction and added three specs — see below.

## Review findings

**Checked:** the full implement diff read before the handoff summary; every exit of
`fetchBlockFromCluster` and `queryClusterForLatest` traced against the new verdict shapes; the
claimant lifetime against `reportRepairDeadlock` (spreads the prior entry, claimants survive) and
`flagUnconfirmedCurrency` (deletes wholesale on convergence); `unsettledAheadClaims` bounding
(`LruMap(1000)`); every consumer of `unconfirmedAheadRev` in `db-core`
(`TransactorSource.tryGet`, `NetworkTransactor.get`, `Collection.bootstrapContext`) to establish
whether the memo's *value* matters and not only its presence — it does, at both the pin gate and
the caught-up check; docs the change touches and the ones it should have (`docs/internals.md`,
`docs/debugging.md` — the latter documents logger namespaces, not event tags, so nothing was owed);
the backlog board for tickets already claiming this file.

**Major — one found, fixed in this pass rather than filed.** The ticket's defect class survived in a
second, less obvious direction. `recordAheadClaim` gated *retirement* on claim provenance but let an
`unsettled-claim` at a **lower** revision replace a recorded higher one outright, dropping the higher
claimant's word on the strength of a peer that never made that claim — the same erasure, one branch
over. It is not merely a downgrade of the number: once this node reaches the lowered revision,
`flagUnconfirmedCurrency` deletes the entry and serves the read as confirmed-current while the
original claimant is still unreachable and still claiming higher. Reachable without any dormant
code path: peer A claims rev 5 uncorroborated; a later pass has A silent and peer B claiming rev 3;
a later repair converges this node to 3; the mark is gone.

Fixed by climbing to the invariant rather than patching the instance: `unsettled-claim` now carries
the same `silent` evidence `nothing-ahead` does, and `recordAheadClaim` applies **one** gate to both
weakenings. The implement handoff had parked this as a tripwire, arguing it "widens what the marker
asserts rather than fixing what it got wrong"; that reading does not hold — retiring a claim and
revising it down hide the same fact from the same reader, so they answer to the same rule, and
leaving one of them ungated leaves the ticket's own defect half-open.

**Minor — fixed in this pass:**

- **The `cluster-fetch:claim-unrefutable` log line had no test.** The handoff judged wiring a logger
  capture "out of proportion"; the harness already exists — `test/support/capture-log.ts`, used by
  five sibling coordinator specs — so the cost was one spec. Added: it asserts the tag, the revision,
  and that the payload names the unreachable claimant. It is the operator's only signal that a
  block's doubt cannot settle, so it is worth pinning.
- **`AheadClaimState.claimants` was documented "Bounded by cohort width", which is false.** Passes at
  an unchanged revision union rather than replace, so under churn the set is bounded by the distinct
  peers that ever claimed that exact revision. Doc corrected; no behaviour change (see tripwire
  below).
- **The `answered.length === 0` test inside the retirement branch is unreachable** —
  `fetchBlockFromCluster` reports that state as `no-evidence`, never as `nothing-ahead`. Kept (the
  type permits it) but separated from the silent-claimant test it was `||`-ed with and labelled as
  the type's guarantee restated, so a reader does not hunt for the path that reaches it.
- **`docs/internals.md`** rewritten for the weakening rule, and a paragraph break restored where the
  implement edit left "Consumers mirror the existence flag" orphaned mid-sentence at the end of an
  unrelated paragraph.

**Judgment calls the handoff asked to be pushed on — reviewed and agreed with:**

- **`claimantsAtOrAbove` uses `>=`.** Correct. A peer claiming *above* the recorded revision is a
  peer whose answer bears on whether something ahead exists; excluding it would let a memo retire
  while a peer claiming even higher is unreachable. Traced through both producer sites.
- **The transient-cohort-shrink tradeoff** (a peer still mid-identify looks departed and its claim
  can retire early). Accepted as argued: self-correcting on the next consult, and the alternative
  rule is permanent read denial behind one unreachable peer. Untested as a race, which is honest —
  it needs a timing seam the specs do not have.
- **`answered` derived by filtering `peerIds` against `silent`** rather than accumulated in the
  result loop. Agreed it is the clearer form: it makes "answered ∪ silent = the non-self cohort"
  true by construction, which is the arithmetic the whole rule rests on.
- **`ClusterLatestQuery.claims` widening the consult's return.** Checked: the only consumer is
  `claimantsAtOrAbove`, which reads `peerId` and `rev`. Nothing re-votes off it. The array is the
  same one `certifyClaim` mutates during verification, but that mutation completes before the
  return, and `readonly` is shallow only in a way no caller exercises.
- **The single-lying-peer availability lever** (one uncorroborated claim is enough to deny unpinned
  reads of a block) carries an accepted-tradeoff argument at its site in `queryClusterForLatest`
  with a stated revisit condition. Untouched, per the accepted-tradeoff rule.

**Tripwires parked in the code** (index only — reasoning is at each site):

- `recordAheadClaim`: `cluster-fetch:claim-unrefutable` is emitted per pass, so `paranoid` mode logs
  it on every read; move behind a say-once flag if it ever shows as noise. *(from implement)*
- `recordAheadClaim`: the same-revision claimant union never prunes, so a claimant that departed
  while the revision stayed stuck lingers. Inert — a departed peer is never `silent`, so it never
  blocks weakening — and the memo map is LRU-bounded; prune against the pass's `answered` ∪ `silent`
  if a long-lived stuck block ever shows the list growing. *(replaces the implement pass's
  lower-claim-replacement tripwire, which this review turned into a fix)*
- `fetchBlockFromCluster`: if a dead peer never leaves the cohort view, the memo stands forever — a
  membership-layer defect, not a licence to erase doubt here. *(from implement)*
- `fetchBlockFromCluster`: the transient-cohort-shrink early retirement. *(from implement)*

**New tickets filed: none.** The one major finding was fixable inside its own site with a small,
mutation-verified change; filing it would have left a known stale-serve hole in the area just
repaired. The architectural theme it belongs to — no single home for "a recorded fact may only be
weakened by the peers that produced it" — already has an open ticket
(`debt-freshness-state-scattered-across-coordinator-repo`), so this instance was appended there as
its twelfth measurement rather than filed fresh.

**Source hygiene, noted and deliberately not filed:** `coordinator-repo.ts` is now 2503 lines
(`wc -l`), up from 2479 at the start of this pass, and the changed regions carry more comment than
code. Both are the file's established style and both are already the subject of the backlog ticket
above, which now carries the current measurement. A point ticket on one method would be noise.

## Validation run

- `yarn workspace @optimystic/db-p2p test` — **2581 passing, 49 pending, 0 failing** (2578 before
  this ticket's implement stage, 2580 after it, 2581 after the review's three new specs).
- `npx tsc --noEmit -p packages/db-p2p/tsconfig.json` (covers `src` and `test`) — clean.
- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn lint` (eslint, whole repo) — clean. `yarn lint:docs` — 45 documents, all citations resolve.
- **Mutation-checked the review's new specs.** Narrowing the weakening gate back to
  `currency.kind === 'nothing-ahead'` (the implement-stage behaviour) failed exactly the new
  higher-claim spec, at the exact expected value (3 where 5 is required), and nothing else; restored
  and the full suite re-run green. The implement stage's own mutation checks are recorded in its
  handoff and were not repeated.
- `coordinator-repo-integration.spec.ts` is named `-integration`, not `.integration`, so it runs in
  the ordinary `yarn test` glob rather than the env-gated one — its `unconfirmedAheadRev` assertions
  were covered by the runs above. The genuinely gated `test:integration` mesh suites were not run:
  nothing in this diff reaches them, and they exceed the agent-runnable wall-clock budget.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
