description: When a node cannot find a piece of data locally, it now reports which of three distinct situations it is in — partial silence, total isolation, or a peer saying the data does exist — instead of one vague catch-all, so callers can react correctly to each.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-p2p/test/repo-service-remote-get-consult.spec.ts, docs/internals.md, docs/transactions.md
----

# Complete: absence verdict names the evidence

A read that finds a block missing locally consults the block's cohort. That consult used to
collapse every unconfirmable outcome into one flag value (`unavailable: 'peers-unreachable'`).
It now returns a named verdict, and the flag names the evidence.

## What shipped

**`BlockUnavailableReason`** (`packages/db-core/src/network/struct.ts`) gains two values, purely
additive — every consumer tests `unavailable !== undefined`, none switches on the value:

- `'cohort-unreachable'` — nothing held locally and no cohort member outside this node could be
  asked at all.
- `'claimed-elsewhere'` — nothing held locally but a cohort peer positively claimed a revision
  that could be neither corroborated to a quorum nor acquired. The block is known to exist
  somewhere; reporting it absent would be a lie.

**`CoordinatorRepo`** (`packages/db-p2p/src/repo/coordinator-repo.ts`) carries an internal
`AbsenceVerdict` union (`'confirmed' | 'unconfirmed' | 'isolated' | 'claimed'`).
`queryClusterForLatest` additionally returns `answered` — how many non-self cohort peers
responded at all — so silence with `answered === 0` reads as isolation rather than as partial
silence. `get`'s missing path maps verdict → reason; `confirmed` stays unflagged, which keeps the
routine new-collection probe at one round trip. `get`'s catch arm (the consult threw) stays
`'peers-unreachable'`.

**`NetworkTransactor`** (`packages/db-core/src/transactor/network-transactor.ts`) ranks
`unavailable` answers among themselves when merging responses from different coordinators (added
during this review — see findings), and carries a tripwire `NOTE:` about the futile retry an
isolated node pays.

**Docs** — `docs/internals.md` carries the verdict→flag table; `docs/transactions.md` lists all
four reasons and the merge preference.

### Deliberately NOT resolved

**The isolated boot does not start working because this landed.** The repo layer refuses to
decide that a node which reached nobody may believe its own emptiness — that is the failure the
fail-closed rule (ticket `2-cluster-read-consult-cannot-report-unreachable`) exists to prevent.
"Is my own view good enough for this read, right now?" is per-read policy belonging to the
caller. `BlockUnavailableError.reason` carries the value verbatim through
`TransactorSource.tryGet`, `Collection.bootstrapContext`, and `NetworkTransactor.get`, so a
consumer's boot path can catch `reason === 'cohort-unreachable'` and proceed under its own risk
model with no further plumbing.

## Review findings

### Checked

Read the implement diff (`fa059c4`) before the handoff summary. Traced the verdict from
`queryClusterForLatest` through `fetchBlockFromCluster`, `get`, `flagUnconfirmedAbsence`,
`NetworkTransactor.get`'s retry filter and merge ranking, `TransactorSource.tryGet`, and
`Collection`. Swept every consumer of `unavailable` for a switch or exhaustive match that a
widened union would break (`spread-on-churn.ts`, `storage-repo.ts`, `collection.ts`,
`transactor-source.ts` — all test `!== undefined`, so the addition is safe). Swept `docs/` for
every mention of the old vocabulary. Re-derived the `answered` arithmetic against the
self-exclusion filter and the `findCluster` contract.

### Fixed in this pass

- **Cross-coordinator merge could mask the sharper reason.** `NetworkTransactor.get`'s `rankOf`
  gave every `unavailable` entry rank 0, and only a strictly-greater rank replaces — so when two
  coordinators answered the same read with different reasons, first arrival won. A partitioned
  coordinator's `'cohort-unreachable'` could therefore beat a well-connected coordinator's
  `'claimed-elsewhere'` on the retry round. That is precisely the case this ticket tells callers
  to act on: the caller sees "I reached nobody", applies its isolation policy, and proceeds with
  an empty view over a block another peer just said exists. Added a sub-rank so a reason that
  establishes the block EXISTS (`'claimed-elsewhere'`, `'unmaterializable'`) beats
  `'peers-unreachable'`, which beats `'cohort-unreachable'`; the relative order of block/absent/
  unavailable answers is unchanged. Pinned by a new spec in `network-transactor.spec.ts` and
  documented in `docs/transactions.md`.
- **Test-coverage gap the handoff named as open.** `transactor-source.spec.ts`'s reason loop
  covered only `'unmaterializable'` and `'peers-unreachable'`, so nothing pinned that the two new
  values survive to `BlockUnavailableError.reason`. Extended the loop to all four.
- **Doc claim contradicted by the solo-self short-circuit.** `docs/internals.md` said a
  freshly-rebooted node would be flagged rather than served an authoritative absent. It is not:
  `findCluster` always includes self, so a node whose routing table yields no other cohort member
  produces `peerIds === [self]`, hits the solo-self skip, and answers a plain unflagged absent.
  `'cohort-unreachable'` is silence from a cohort this node *knows about* — not isolation in
  general. Added the missing "nobody to ask" table row and a paragraph saying an
  isolation-tolerant consumer must handle the unflagged absent too. Behaviour unchanged; only the
  documentation was wrong.
- **Comment accuracy.** `AbsenceVerdict.'unconfirmed'` claimed to cover a consult that throws — it
  does not; `get`'s catch arm bypasses the verdict entirely. Reworded. Also recorded that
  `'claimed'` and `'isolated'` are mutually exclusive (a claim requires a non-self peer to have
  answered, which is what `isolated` rules out), so the next reader does not hunt for a test of a
  pair that cannot occur.
- **Extended the self-exclusion `NOTE:`.** The pre-existing unset-`localPeerId` tolerance now has
  a second consequence: a solo repo whose own storage read *rejects* lands self in `silent`, giving
  `answered === 0`, and the pass reports isolation instead of a local fault. Same fix as the
  existing note prescribes (require `localPeerId`); recorded at the site rather than filed.

### Major findings

None. The verdict derivation is sound: `answered` is computed from the same non-self filter that
already feeds the corroborator capacity, `claimed` correctly outranks silence, and the widened
union is additive at every consumer. The one defect worth a ticket-sized argument — the merge
masking above — turned out to be a six-line change with a clear correct answer, so it was fixed
here rather than deferred.

### Tripwires

Two, both parked by the implementer and verified still accurate at their sites — no new ones
added:

- `NOTE:` at `NetworkTransactor.get`'s retry filter — an isolated node pays one futile extra
  consult; if it ever shows in latency, skip the retry for `'cohort-unreachable'` rather than
  widening `isAuthoritative`.
- `NOTE:` at `CoordinatorRepo.get`'s catch arm — a thrown consult reports `'peers-unreachable'`
  even on an isolated node; revisit if `findCluster` on isolated nodes turns out to throw
  routinely rather than return a stale cohort view.

### Accepted tradeoffs honoured, not re-filed

The one-claim-raises-doubt `NOTE:` at the no-quorum site in `queryClusterForLatest` already
records that a single lying cohort peer can deny reads by claiming a revision nobody else holds.
`'claimed-elsewhere'` extends that same lever to the missing path. Its stated revisit condition —
claims becoming attestable via commit certificates (backlog
`debt-read-repair-commit-cert-verification`) — has not tripped, so this was left alone.

### Left as-is, with reason

The `local-current` early return computes a verdict `get` never consults (that path is only
reachable when this node holds a revision). Computing it consistently rather than hard-coding a
value is the safer shape if the reachability ever changes, it is commented as such, and a test
pinning an unobservable value would only ossify it. Not worth a change.

### Evidence appended to an existing ticket, no new ticket filed

`coordinator-repo.ts` measured **1194 lines** (`wc -l`), up from the 1122 recorded when
`tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` was filed, and this
ticket added a fourth loose piece of freshness state to the same span. Appended as an arm to that
ticket rather than filed fresh.

### Validation

All green, all in the foreground:

- `yarn lint` — clean (exit 0).
- `yarn workspace @optimystic/db-core run build` / `@optimystic/db-p2p run build` — the tsc pass,
  clean. Note for future stages: **neither package defines a `typecheck` script**, so the root
  `yarn typecheck` silently skips both; `build` is the type check for them.
- `yarn workspace @optimystic/db-core test` — 1368 passing.
- `yarn workspace @optimystic/db-p2p test` — 1601 passing, 44 pending.
- `yarn test` (all workspaces) — green, no failures.
- `yarn workspace @optimystic/db-p2p run test:integration` — the real-TCP suite the handoff
  flagged as not run: **30 passing, 2 pending**. Gap closed.

No pre-existing failures surfaced.
