description: A fairness tweak accidentally let two conflicting transactions both commit; reorder the tie-break so the transaction that is further along always wins, and only use fairness-priority to settle genuine ties.
prereq:
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (resolveRace ~1495; recordPriority ~1536; hasConflict ~1406; handleCommitNeeded ~1011; getTransactionPhase ~736)
  - packages/db-core/src/transaction/transaction.ts (Transaction.priority; MaxPriority; clampPriority)
  - packages/db-p2p/test/cluster-repo.spec.ts (priority-aged race resolution suite ~826)
  - docs/correctness.md (Theorem 9 ~265, Case 2 ~80)
difficulty: hard
----

## Summary

Ticket 4.6 (`implement-occ-priority-aging`, now in `complete/`) added an aged advisory
**priority** to transactions and made `resolveRace` consult it **first**, ahead of the promise
count. That reordering removed a safety property: it lets a high-priority transaction displace a
conflicting rival that has *already reached a promise supermajority*, so both can commit (split
brain). Full analysis and the reachable scenario are in the source fix ticket — this ticket
implements the agreed correction.

**Decision (made in the fix stage): demote priority to a tie-break that runs *after* the promise
count.** New order:

```
(1) more promises wins
(2) higher aged priority wins
(3) higher message hash wins
```

This is the fix ticket's **option 2**. It was chosen over the alternatives (option 3: a
conflict guard on the commit path, or rejecting a second conflicting pend at promise time) because:

- It **restores the exact pre-4.6 monotonicity guarantee** — a more-progressed transaction is
  never displaced — rather than adding a second, heavier mechanism that interacts with recovery.
- The starvation that priority-aging was built to solve occurs at **equal promise counts** (two
  fresh rivals, 0 promises each, coin-flipping on the hash). Priority as a tie-break *after* the
  promise count still breaks exactly those ties, so aging still solves the stated problem in its
  common case.
- Options 3 remain available as future defense-in-depth but are not needed once the ordering is
  fixed. Record the residual (below) as a tripwire, not follow-up work.

### Why option 2 is sufficient (the safety argument to re-assert)

A member commits purely on promise supermajority (`handleCommitNeeded` signs whenever
`approvedPromises >= superMajority`; the commit path has **no** conflict re-check). So `resolveRace`
is the only arbiter among concurrently-pending conflicts. With promises-first:

- Once transaction X holds a promise supermajority, any conflicting rival Y has **fewer** promises
  (or Y has to first reach the same count, which requires the intersecting quorum member to have
  promised it — it won't, because that member already holds X at supermajority and `resolveRace(X,Y)`
  returns `keep-existing` on X's higher promise count).
- By quorum intersection every Y-supermajority overlaps X's in ≥1 honest member, and that member
  rejects Y. So Y never commits. **One winner. Safe** — identical to the pre-4.6 argument.

Priority now only reorders the outcome when promise counts are **equal**, which is precisely the
concurrent-starvation case (both fresh at 0) and never displaces progress.

### Tripwire (do NOT file as a ticket)

Residual fairness gap under the new order: an aged transaction can still lose to a fresh rival that
has *legitimately* gathered even one more promise than it. That is not starvation on the pure
coin-flip case (equal counts, priority wins), only when a rival is genuinely further along — which
is the safety behaviour we *want*. If deeper fairness is ever needed it belongs to the existing
`feat-occ-priority-reservation` follow-up (reserve/defer at pend time), not the race tie-break.
Record this as a `NOTE:` comment at the `resolveRace` site and one line in the review findings.

## Test changes required

The 4.6 unit tests assert the *old* priority-first semantics and will now be **wrong**. Several
have premises that invert under the new order — do not just flip an `expect`; fix the premise so
the test proves the *new* rule:

- `~832 'higher aged priority wins even against a rival with MORE promises'` — under the new order
  the rival with more promises **wins**. Repurpose this into the monotonicity guard: rename to the
  effect of *"a rival with more promises wins even against higher priority"* and assert
  `resolveRace(aged, fresh) === 'accept-incoming'` (fresh, 2 promises, priority 0) and the mirror.
- `~851 'livelock guarantee'` — the fresh rivals carry **two** promises, so under the new order the
  aged transaction never wins on priority. Rewrite so the fresh rivals have an **equal** promise
  count (0) — then priority-as-tie-break gives the deterministic aged win at priority 1, preserving
  the livelock guarantee for the case aging actually targets.
- `~844`, `~872`, `~888`, `~897` — these already race records with **equal** (0/0) promise counts,
  so priority (or the hash fallback) still decides and their expectations stand. Re-run to confirm;
  adjust only if a premise sneaks in a promise-count difference.

## Docs

`docs/correctness.md` Theorem 9 (~271) currently states the order as *"(1) higher aged priority,
(2) more promises, (3) higher message hash"* and claims "safety intact". Update the order to
promises-first and **re-derive the safety argument honestly** using the quorum-intersection
reasoning above (the "safety intact" claim is only true under this ordering). Check Case 2 (~80)
for the same ordering restatement.

## TODO

- [ ] In `cluster-repo.ts::resolveRace` (~1495): swap the comparison order to promise count first,
      then priority, then message hash. Remove the `WARNING:` block and the "Priority is FIRST"
      rationale in the surrounding doc comment; rewrite it to describe promises-first with priority
      as the equal-count tie-break, and the restored monotonicity guarantee.
- [ ] Add a `NOTE:` comment at the `resolveRace` site recording the residual-fairness tripwire
      (aged loses to a genuinely-more-progressed rival; deeper fairness → `feat-occ-priority-reservation`).
- [ ] Fix the existing `priority-aged race resolution` tests per "Test changes required" above.
- [ ] Add an **adversarial monotonicity test** (`cluster-repo.spec.ts`): construct X with a promise
      **supermajority** and a conflicting, higher-priority Y with fewer promises; assert
      `resolveRace(X, Y) === 'keep-existing'` and the mirror `resolveRace(Y, X) === 'accept-incoming'`
      — i.e. priority cannot displace a supermajority-reached transaction. This is the regression
      guard; confirm it FAILS against the current priority-first code before the fix and passes after.
- [ ] (Stronger, if the harness supports multi-member wiring cheaply) add a promise→commit
      composition test: drive X to a promise supermajority across members, introduce higher-priority
      conflicting Y, and assert **at most one** of X/Y reaches a commit supermajority. If a full
      multi-member harness is disproportionate, the `resolveRace`-level guard above is the required
      minimum; note the deferral in the review handoff.
- [ ] Update `docs/correctness.md` Theorem 9 (and Case 2 if it restates the order) to the new
      ordering with a re-derived safety argument.
- [ ] Build + run the db-p2p test suite (stream output): `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log` (or the repo's equivalent — check AGENTS.md). Type-check the package.
- [ ] Review handoff: note the tripwire, whether the multi-member composition test was added or
      deferred, and that Theorem 9's safety claim now rests on the promises-first ordering.
