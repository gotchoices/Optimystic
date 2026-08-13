description: When a node cannot find a piece of data locally, it now reports which of three distinct situations it is in — partial silence, total isolation, or a peer saying the data does exist — instead of one vague catch-all, so callers can react correctly to each.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-p2p/test/repo-service-remote-get-consult.spec.ts, docs/internals.md, docs/transactions.md
----

# Review: absence verdict names the evidence

Implemented per the implement-stage ticket (same slug). A read that finds a block missing
locally consults the block's cohort; that consult used to collapse every unconfirmable outcome
into one boolean and one flag value (`unavailable: 'peers-unreachable'`). It now returns a named
verdict, and the flag names the evidence.

## What changed

**`packages/db-core/src/network/struct.ts`** — `BlockUnavailableReason` gains two values,
purely additive (every consumer tests `unavailable !== undefined`, none switches on the value):

- `'cohort-unreachable'` — nothing held locally and NO cohort member outside this node could be
  asked at all. Tells the caller there is no better-connected coordinator to re-ask.
- `'claimed-elsewhere'` — nothing held locally but a cohort peer positively claimed a revision
  that could be neither corroborated to a quorum nor acquired. The block is known to exist
  somewhere; reporting it absent would be a lie.

**`packages/db-p2p/src/repo/coordinator-repo.ts`** — the heart of the change:

- New internal `AbsenceVerdict` union (`'confirmed' | 'unconfirmed' | 'isolated' | 'claimed'`);
  `fetchBlockFromCluster` returns `{ absence, claimedAheadRev? }` instead of
  `{ inconclusive, claimedAheadRev? }`. Precedence when several apply: claimed > isolated >
  unconfirmed > confirmed.
- `queryClusterForLatest` additionally returns `answered` — how many non-self cohort peers
  responded at all — derived from the same non-self filter that already fed the corroborator
  capacity. `answered === 0` with silence is isolation.
- `get`'s missing path maps verdict → reason: `unconfirmed` → `'peers-unreachable'` (unchanged
  behavior), `isolated` → `'cohort-unreachable'`, `claimed` → `'claimed-elsewhere'`,
  `confirmed` → no flag (the new-collection probe stays one round trip).
- `get`'s catch arm (the consult THREW, e.g. cohort lookup failed) stays `'peers-unreachable'`
  with a `NOTE:` explaining why: a routing failure says nothing about how many members were
  reachable. Revisit condition recorded there — if `findCluster` on an isolated node throws
  routinely rather than returning a stale cohort view, the isolated case falls back under the
  vaguer reason.
- `flagUnconfirmedAbsence` takes the reason as a parameter; its no-op guards (real content,
  committed revision, sharper existing flag) are unchanged.

**`packages/db-core/src/transactor/network-transactor.ts`** — tripwire `NOTE:` only, no code
change: a `'cohort-unreachable'` entry earns the second-chance retry like any flagged entry, and
on a genuinely isolated node that retry re-picks the same node and repeats one futile consult.
Fine today (bounded, on an already-failing read); the note says to skip the retry for that
reason — not widen `isAuthoritative` — if isolated-node read latency ever matters.

**Docs** — `docs/internals.md` three-answers bullet now carries the verdict→flag table plus the
rationale for why an isolated node's absence is still not authoritative; `docs/transactions.md`
"Unavailable reads" section lists all four reasons and the not-restored log paragraph now says
`'claimed-elsewhere'`.

## What each fix means in practice

- **Arm two of the source ticket (fixed outright):** block missing locally, one cohort peer
  claims rev 2, quorum declines the lone claim — previously the entry went back as a plain,
  authoritative "does not exist" even though a peer had just said otherwise. Now it carries
  `'claimed-elsewhere'`, so `NetworkTransactor` retries another coordinator and, failing that,
  the read throws `BlockUnavailableError(blockId, 'claimed-elsewhere')` instead of returning a
  confident empty answer. Accepted tradeoff (already documented at the no-quorum site in
  `coordinator-repo.ts`): one bare claim raises doubt, so a single lying peer can deny reads of
  a missing block — the same lever it already had on the present-block path and via staying
  silent. A read racing a brand-new block's commit broadcast now throws rather than reporting
  absent; truthful, and clears once a second peer holds the block.
- **Arm one (fixed as far as this layer honestly can):** an isolated node's read still fails,
  but with `'cohort-unreachable'`, which says the one thing the caller's isolation policy needs:
  no better-connected coordinator exists; this node's view is all there is.

## Deliberately NOT resolved — do not mistake for an oversight

**The isolated boot does not start working because this ticket landed.** The repo layer refuses
to decide that an isolated node may believe its own emptiness — a node that reached nobody has
zero information about the cohort, and serving its emptiness as authoritative is exactly the
failure the fail-closed rule (ticket `2-cluster-read-consult-cannot-report-unreachable`) was
added to prevent; in the consuming product the block at stake is a revocation-tombstone table,
where "empty" wrongly admits a revoked member. "Is my own view good enough for this read, right
now?" is per-read policy belonging to the caller. `BlockUnavailableError.reason` carries the
value verbatim through `TransactorSource.tryGet`, `Collection.bootstrapContext`, and
`NetworkTransactor.get`, so a consumer's boot path can catch `reason === 'cohort-unreachable'`
and proceed with an empty view under its own risk model, today, with no further plumbing.

## Tests — what ran, what to probe

`yarn typecheck`, `yarn lint`, `yarn workspace @optimystic/db-core test` (1365 passing),
`yarn workspace @optimystic/db-p2p test` (1601 passing, 44 pending) all green. The separate
`test:integration` (real-TCP) suite was NOT run; grep found no reason-value assertions in those
specs, but a reviewer with time should run it.

New specs (`coordinator-repo-unavailable.spec.ts`, describe "absence verdicts name the
evidence"): lone declined claim → `'claimed-elsewhere'` with `unconfirmedAheadRev` absent
(markers stay disjoint); claim + silent peer → still `'claimed-elsewhere'` (claim outranks
silence); sole peer rejects → `'cohort-unreachable'`; both remotes reject →
`'cohort-unreachable'` (isolation is reach, not cohort size); one rejects + one answers →
`'peers-unreachable'` (partial reach is not isolation).

Expectation changes beyond what the implement ticket listed — the ticket named two specs in
`coordinator-repo-unavailable.spec.ts` (sole-peer deadline → `'cohort-unreachable'`;
corroborated-unacquirable → `'claimed-elsewhere'`), but grep turned up **three more** asserting
the old value, updated the same way. Reviewer should sanity-check each is the intended semantic:

- `coordinator-repo-integration.spec.ts` "sole holder is silent" and "only other cohort peer is
  silent": two-node mesh, the only non-self peer silent → these are isolation, now
  `'cohort-unreachable'`.
- `repo-service-remote-get-consult.spec.ts` "does not answer a bare authoritative absent":
  two-node cohort where the sole peer's claim meets the capacity-relaxed quorum
  (`clusterSize: 2`) and cannot be acquired → the cohort positively attested the block, now
  `'claimed-elsewhere'`.

Guards that must stay green stayed green (all pinned by existing specs): consult-throws →
`'peers-unreachable'`; whole-cohort-answers-nothing → unflagged authoritative absent; partial
silence in a 3-cohort → `'peers-unreachable'`; storage's `'unmaterializable'` never overwritten;
`skipClusterFetch` never flagged; swallowing callback → authoritative absent; the entire
stale-present (`unconfirmedAheadRev`) describe untouched.

Known gaps a reviewer could close:

- No spec drives `'cohort-unreachable'` / `'claimed-elsewhere'` end-to-end through
  `NetworkTransactor` → `BlockUnavailableError.reason` (the plumbing is value-agnostic and
  `transactor-source.spec.ts` loops over reasons, but no test asserts the new values survive the
  full read path).
- The `local-current` early-return path now computes a verdict that is never consumed (only
  reachable when this node holds a revision); it is computed consistently per the ticket, with a
  comment saying so — nothing pins it.
- `answered` counts self among responders when `localPeerId` is unset (the pre-existing
  single-node/test tolerance, already documented at the self-exclusion NOTE in
  `queryClusterForLatest`); harmless for the same reason self-as-claim is, and not newly pinned.

## Review findings (running list for the reviewer to complete)

- Tripwire parked: `NOTE:` at `NetworkTransactor.get`'s retry filter — isolated node pays one
  futile extra consult; fix by skipping the retry for `'cohort-unreachable'` if it ever shows up
  in latency, not by widening `isAuthoritative`.
- Tripwire parked: `NOTE:` at `CoordinatorRepo.get`'s catch arm — a thrown consult reports
  `'peers-unreachable'` even on an isolated node; revisit if `findCluster` on isolated nodes
  turns out to throw routinely.
