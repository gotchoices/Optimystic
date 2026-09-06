description: A warning that "a newer version of this record may exist" could previously be erased by any machine replying "I don't have it", even the ones that never knew about the newer version; now only the machines that raised the warning can retire it.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts
  - docs/internals.md
difficulty: medium
----

# Review: claim provenance in `CoordinatorRepo`'s freshness memo

## What the change does

`CoordinatorRepo` stamps `unconfirmedAheadRev` on reads it serves below a cohort peer's claim of a
revision it could not acquire, and remembers that claim per block (`unsettledAheadClaims`). The memo
used to be cleared by ANY cohort peer answering "nothing ahead" — so the sole holder of the claimed
revision going offline plus one other peer saying "I hold nothing" erased the warning and served the
stale copy as confirmed-current.

The memo now records **who claimed it**, and the retirement rule is one sentence:

> Retire when at least one non-self cohort member answered this consult AND no peer that made the
> claim was silent in it.

Doubt settles by **cohort membership, not a timer**: a claimant that is neither in `answered` nor in
`silent` has left `findCluster`'s view and stops blocking retirement.

## Diff shape (3 files, +420/−76)

`packages/db-p2p/src/repo/coordinator-repo.ts`
- `ClusterLatestQuery.answered: number` → `answered: string[]` (identities), plus a new
  `claims: readonly RevClaim[]`. Both `queryClusterForLatest` return sites updated; internal uses
  became `answered.length` (`cluster-fetch:no-quorum`'s `absent`, and `reportRepairDeadlock`'s
  `answered` argument, whose own `answered: number` parameter was left alone).
- `CurrencyVerdict`: `{ kind: 'refuted' }` → `{ kind: 'nothing-ahead'; answered; silent }` —
  evidence-carrying, deliberately renamed so no existing `return` silently kept its old meaning.
  `unsettled-claim` gained `claimants`.
- `AheadClaimState` gained `claimants?: readonly string[]`, written/cleared with `rev`.
  `deadlocksReported` keeps its independent lifetime (verified: `reportRepairDeadlock` spreads the
  prior entry, so claimants survive a deadlock report).
- `fetchBlockFromCluster`: `nothingAheadVerdict` is `no-evidence` on an empty `answered`, else
  `nothing-ahead` with the evidence. A local `claimantsAtOrAbove(rev)` helper populates `claimants`
  at both `unsettled-claim` producers.
- `recordAheadClaim` now owns the retirement decision, and unions claimants when a repeated claim
  names the same `rev` (replaces outright otherwise).
- New log line `cluster-fetch:claim-unrefutable` (blockId, rev, silentClaimants) when retirement is
  declined because a claimant was silent.
- The two NOTEs that deferred to this ticket were replaced with the resolved reasoning, not deleted.

`packages/db-p2p/test/coordinator-repo-unavailable.spec.ts` — six specs added to the
`the mark outlives the consult (read-repair window)` describe.

`docs/internals.md` — the `unconfirmedAheadRev` bullet: the verdict union names and the "only a
consult that reached a cohort member may clear it" rule were both wrong after this change.

## Validation actually run

- `yarn workspace @optimystic/db-p2p test` — **2578 passing, 49 pending, 0 failing.**
- `npx tsc --noEmit -p packages/db-p2p/tsconfig.json` (covers `src` and `test`) — clean.
- `yarn workspace @optimystic/db-p2p build` — clean.
- **Mutation-checked the new specs.** Temporarily reverting the retirement rule to the old
  any-answer-refutes behaviour failed exactly the three defect specs (partial silence, sole-claimant
  silent, `localPeerId` unset) and no others. Temporarily reverting claimant-union to replace-only
  failed exactly the accumulation spec. Both flips were restored and the full suite re-run green.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Use cases to exercise while reviewing

The interesting behaviour is all in `CoordinatorRepo.get` on a **present-but-possibly-stale** block,
in `paranoid` read-repair mode (so a consult definitely runs on every read).

**Must keep the mark:**
- Partial silence — a claimant rejects, a non-claimant answers `undefined`.
- The only claimant goes silent while the other peer answered "I hold nothing" on both reads (it
  demonstrably never knew the claimed revision).
- Claimants accumulated across passes: A claims rev 3, then B claims rev 3 while A is silent, then a
  third pass where A is still silent — A's word is still outstanding.
- `localPeerId` left unset (a construction the class has always tolerated): this node's own answer
  must not retire a remote peer's claim.
- The three pre-existing "asked nobody" shapes (solo-self exit, empty cohort, total silence).

**Must drop the mark** — the over-correction side, which is where a careless reading of the rule
breaks things:
- The claimant itself answers with a lower revision while a *non*-claimant is silent. If this
  regresses to "any silence blocks retirement", one permanently unreachable cohort peer flags a
  block forever and `TransactorSource.tryGet` / `NetworkTransactor.get` then raise
  `BlockPossiblyStaleError` on every unpinned read of it, permanently.
- A departed claimant (dropped from the `findCluster` view) stops blocking.
- Peers answer with a claim strictly below, or level with, what this node holds.
- This node reaches the claimed revision (the `flagUnconfirmedCurrency` catch-up path, untouched).

## Known gaps and judgment calls — please push on these

- **The `cluster-fetch:claim-unrefutable` log line is not covered by a test.** It goes through
  `this.log` and the spec file has no logger capture; I judged wiring one in to be out of proportion
  for a diagnostic line. It is the operator's ONLY signal that a block's doubt cannot settle, so if
  you disagree, that is a fair finding.
- **The transient-shrink tradeoff is real, accepted, and untested as a race.** `findCluster` never
  admits a peer that is still mid-identify, so a live claimant can briefly look departed and its
  claim can be retired early. Self-correcting (the next consult re-records it from the peer's own
  answer), argued at the site, and the alternative rule is permanent read denial — but it IS a
  window where a stale read is served unmarked, and nothing pins the behaviour.
- **`claimantsAtOrAbove` uses `>=`.** A peer claiming a revision *above* the recorded one counts as a
  claimant of it. I believe that is right (its answer bears on whether something ahead exists), but
  it is a judgment call worth a second opinion.
- **The out-of-scope item is now genuinely open.** A consult whose corroborated revision is *lower*
  than a recorded claim still clears that claim, and a lower `unsettled-claim` still replaces a
  higher recorded one — dropping the higher claim's claimants with it. The ticket put this out of
  scope; provenance now makes the stricter rule ("keep the higher claim while its claimants are
  unaccounted for") expressible for the first time. Recorded as a tripwire `NOTE:` at the
  replacement site in `recordAheadClaim`, deliberately not filed as a ticket, since it is a
  widening of what the marker asserts rather than a defect in what it now gets right.
- **`answered` is derived by filtering `peerIds` against `silent`** rather than being accumulated in
  the result loop. Equivalent for any `peerIds` from `Object.keys` (no duplicates), and it makes
  "answered ∪ silent = the non-self cohort" true by construction, which the retirement rule leans
  on. Worth confirming you agree that is the clearer form.
- **`ClusterLatestQuery.claims` widens what the consult hands back.** It is `readonly` and the doc
  says nothing downstream may re-vote off it, but a reviewer should check nothing later treats it as
  a fresh selection input.
- Backlog `debt-freshness-state-scattered-across-coordinator-repo` was read, not done: this adds one
  field to an existing `AheadClaimState` entry rather than a fourth per-block map.

## Tripwires parked in the code (index only — the reasoning is at each site)

- `recordAheadClaim`: `cluster-fetch:claim-unrefutable` is emitted per pass, so `paranoid` mode logs
  it on every read; move behind a say-once flag if it ever shows as noise.
- `recordAheadClaim`: the lower-claim replacement dropping the higher claim's claimants (above).
- `fetchBlockFromCluster`: if a dead peer never leaves the cohort view, the memo stands forever —
  a membership-layer defect, not a licence to erase doubt here.
- `fetchBlockFromCluster`: the transient-cohort-shrink early retirement (above).
