description: A machine that loses contact with the others sharing a record used to forget it had been told a newer version exists, then serve its old copy as confirmed-current; it now keeps that doubt unless peers actually answer and refute it.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CurrencyVerdict` ~line 318; `fetchBlockFromCluster` and its six exits ~lines 962-1145; `nothingAheadVerdict` ~line 1049; `recordAheadClaim` ~line 826; the `get` call site ~line 718)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (`the mark outlives the consult (read-repair window)` describe, ~lines 577-790)
  - docs/internals.md (the `unconfirmedAheadRev` bullet)
  - docs/transactions.md (`Unconfirmable reads: BlockPossiblyStaleError`)
----

# A freshness check that reached nobody no longer erases recorded doubt

## What landed

`CoordinatorRepo` remembers, per block, that a cohort peer once claimed a revision ahead of what
this node holds and that the repair could not settle it (`unsettledAheadClaims`). Reads served
below that claim get stamped `unconfirmedAheadRev`, which reaches callers as
`BlockPossiblyStaleError`. The memo exists so the doubt outlives the consult that formed it.

The memo was being erased by consults that asked nobody. `fetchBlockFromCluster` reported its
currency finding as `claimedAheadRev?: number`, where `undefined` meant both "peers answered and
nothing is ahead" (a refutation, which may clear the memo) and "nobody was asked, or nobody
answered" (no evidence, which may not). Four exits produced the second meaning while looking like
the first — the solo-self short-circuit, the empty-cohort exit, the no-callback exit, and every
asked peer failing to answer.

The difference is now expressible in the value rather than reconstructed at the call site:

```ts
type CurrencyVerdict =
	| { kind: 'refuted' }                          // a cohort member answered; nothing ahead
	| { kind: 'no-evidence' }                      // nobody asked, or nobody answered
	| { kind: 'unsettled-claim'; rev: number };    // a peer claims `rev` ahead; we did not converge
```

`fetchBlockFromCluster` returns `{ absence: AbsenceVerdict; currency: CurrencyVerdict }` with
`currency` **required**, so an exit added later cannot mean "refuted" by omission — the compiler
flagged all six exits when the type changed. `recordAheadClaim` reads it: `no-evidence` returns
without touching the map, `refuted` clears (still preserving `deadlocksReported`),
`unsettled-claim` records the revision. A shared `nothingAheadVerdict` is computed once beside the
existing `silenceVerdict` so the rule is stated in one place. Absence verdicts and read-repair
window arming are unchanged.

## Verification

Run at review, on the full tree:

- `yarn workspace @optimystic/db-p2p typecheck` — passes.
- `yarn lint` (`eslint .`) — clean. `yarn lint:docs` — 45 documents, 73 anchored citations, 583
  file mentions, 311 links, all resolve.
- `yarn workspace @optimystic/db-p2p test` — **2572 passing, 49 pending, 0 failing** (2571 as
  handed off, plus the one spec this review added).
- `yarn test` (whole monorepo) — every package green, 0 failing.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

## Review findings

### Verified defect — filed, not fixed here

- **A *partial* answer still erases the memo.** The currency verdict is two-level
  (`answered === 0` → no evidence, otherwise refuted) while the existence verdict ten lines above
  is three-level (no silence / partial silence / total silence). So when the sole holder of the
  claimed revision goes silent and any other peer answers "I hold nothing", the doubt is cleared by
  peers that never knew about the claim, and the stale copy is served as confirmed-current — the
  same failure this ticket set out to end, one peer short of the case it fixed.

  **Reproduced**, not inferred: a temporary probe spec (cohort of three, local revision 1, first
  read stamps `unconfirmedAheadRev === 3`, second read has peer A reject and peer B answer
  `undefined`) printed `unconfirmedAheadRev = undefined`. The probe was removed after the run; it
  is not in the tree.

  Not a regression — the behaviour predates this ticket, which closed the "asked nobody" door and
  made this one visible. Filed as **`fix/3-currency-doubt-cleared-by-a-partial-answer`**
  (`repro: verified`), filed at the type/representation rung rather than as a point fix: the memo
  does not record *which* peer made the claim, so "has this claim been answered?" cannot be asked
  at all, and both one-line rules available today are wrong at an edge (any-answer-refutes erases
  on ignorance; full-cohort-refutes leaves a block flagged forever behind one dead peer). A
  `NOTE:` at `nothingAheadVerdict` names the gap and points at the ticket, so the next editor does
  not "harmonize" the two verdicts without reading it.

- **Second arm on the same ticket: this node's own answer can count as a refutation.** With
  `localPeerId` left unset, self-exclusion is off *and* the solo short-circuit is skipped, so a
  self-only cohort queries itself, counts its own reply toward `answered`, and clears the memo on
  the strength of agreeing with itself. Dormant — both production wirings
  (`libp2p-node-base.ts:987`, `testing/mesh-harness.ts:460`) pass `localPeerId` — so it is an arm
  of the ticket above (same site, same cause: the count the rule reads does not mean "a cohort
  member other than me answered"), not a separate one.

### Fixed in this pass

- **A comment justified the rule with a case that does not exist.** The block above
  `nothingAheadVerdict` claimed `answered === 0` with an empty silent set is reachable via a
  self-only cohort with `localPeerId` unset. It is not: in that configuration `answered` is 1, not
  0 (self is counted), and with `localPeerId` set the solo short-circuit takes the cohort first, so
  the state is unreachable altogether. Rewritten to state the actual reason for keying on
  `answered`, and to record the unset-`localPeerId` hole found above.
- **`docs/internals.md` stated the invariant this ticket replaced** — "only a consult that actually
  ran may clear it". Running is no longer sufficient; reaching a cohort member is. Corrected, with
  the three no-evidence shapes and `CurrencyVerdict` named.
- **`docs/internals.md`'s accepted-tradeoff paragraph was narrower than the new behaviour.** It
  covered a node partitioned from every coordinator raising "until the partition heals"; it now
  also records that a node which recorded a claim and *then* lost its cohort keeps raising
  indefinitely, since only a cohort member's answer or reaching the claimed revision can settle it
  and it can do neither alone.
- **`docs/transactions.md`'s "until a later consult refutes it" was the same stale wording.**
  Sharpened to say refuting takes an answer.
- **One spec added**, closing the row the handoff left argued rather than asserted:
  `drops the mark when the surviving claim fails quorum AND is not ahead of us` — two peers naming
  different actions at the revision this node already holds, so the quorum declines and the claim
  survives only as `uncorroboratedRev`. That is the exit whose correctness rests on "a claim can
  only exist when a peer answered"; it is now pinned rather than reasoned about.

### Checked and deliberately not actioned

- **The handoff's open question — does any caller treat a persistent stale flag as advisory?** It
  does not. `TransactorSource.tryGet`, `NetworkTransactor.get`/`getStatus` and
  `Collection.bootstrapContext` all *throw* `BlockPossiblyStaleError`. So a solo node that once
  heard a claim now fails those reads indefinitely rather than serving silently-stale content. That
  is the intended direction and is already recorded as an accepted tradeoff in `docs/internals.md`;
  this pass widened that paragraph rather than filing against it. Note the case is narrower than it
  first reads: a memo can only exist if a cohort was once reachable, so a genuinely solo node
  (GitHub issue #8's shape) is unaffected.
- **The no-callback exit is dead code.** `fetchBlockFromCluster` has exactly one caller, guarded by
  the same `this.clusterLatestCallback` test, so the early return is unreachable. Left in place:
  the `get` doc comment already states, deliberately, that a coordinator wired without a cohort
  callback keeps its local answer authoritative, and removing a defensive guard on a private method
  buys nothing.
- **`recordAheadClaim` lets a newer consult overwrite a higher recorded claim with a lower one.**
  Stated as intentional at the site ("the consult is the authority on the CLAIM"). Recorded as an
  adjacent scope note on the new fix ticket in case claim provenance subsumes it; not re-filed.
- **File size (2341 → 2356 lines) and comment density.** Both already tracked by
  `backlog/debt-freshness-state-scattered-across-coordinator-repo.md`, whose eleventh measurement
  the implementer appended. This review appended one addendum there: the two shared verdicts have
  *different level counts*, and the likely fix (claim provenance) adds a fifth per-block fact that
  the eventual extraction would own — so sequence the extraction after the fix ticket. The heavy
  prose commenting matches the file's established idiom and was not touched.

### Empty categories

- **Tripwires: none new.** Both conditional concerns this pass surfaced turned out to be
  unconditional — partial-silence erasure is wrong the moment the path runs, and the
  unset-`localPeerId` case is wrong the moment that construction is used — so both became arms of a
  ticket rather than notes. The consequences that *are* conditional were already written as
  comments at their exact sites by the implementer.
- **Blocked: nothing.** No decision here needs a human: the partial-silence fix has a settled
  problem statement and an unsettled implementation, which is what the `fix/` stage is for.
- **Backlog: nothing new.** The one size/structure concern is an arm on an existing ticket, not a
  new one.
