description: When a machine is warned that a newer version of a record exists and the machine holding it then goes offline, one reply from any other machine saying "I don't have it" currently erases the warning and the stale copy is served as if confirmed current; make the warning retirable only by the machines that raised it.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestQuery` ~line 61, `AheadClaimState` ~line 110, `CurrencyVerdict` ~line 318, `recordAheadClaim` ~line 824, `fetchBlockFromCluster`'s `nothingAheadVerdict` ~line 1043, `queryClusterForLatest` ~line 1281 and its two return sites ~line 1435 / ~line 1452)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (`the mark outlives the consult (read-repair window)` describe, ~line 577)
  - docs/internals.md (the `unconfirmedAheadRev` bullet, ~lines 1063-1091)
repro: verified
difficulty: medium
----

# Record who made the claim, and let only those peers retire it

## The defect, in one paragraph

`CoordinatorRepo` remembers, per block, a cohort peer's claim of a revision it could not acquire
(`unsettledAheadClaims`), and stamps every read served below that claim with
`unconfirmedAheadRev`. The memo is *cleared* whenever a freshness consult finds nothing ahead and
**any** cohort peer answered. The memo does not record *which* peer made the claim, so a peer that
never knew about the claimed revision can retire it. Concretely: the sole holder of revision 3 goes
offline, any other cohort peer answers "I hold nothing", and the warning is deleted — the exact
silent-staleness failure the whole marker exists to end.

## Reproduction (run, observed, then removed from the tree)

A ~90-line probe spec against `packages/db-p2p`, cohort of three in `readRepairMode: 'paranoid'`,
local copy at revision 1. Both arms fail today:

- **Arm 1 — partial silence.** Read 1: both remote peers answer revision 3, acquisition fails →
  `unconfirmedAheadRev === 3`. Read 2: peer A's callback rejects, peer B answers `undefined`.
  Observed `unconfirmedAheadRev === undefined`.
- **Arm 2 — self-refutation.** Same shape with `localPeerId` left unset (a construction the class
  has always tolerated) and a cohort of two. Read 2: peer A rejects, this node answers about
  itself. Observed `unconfirmedAheadRev === undefined`.

`test/coordinator-repo-unavailable.spec.ts` is green at HEAD (31 passing) before any change.

## Why the current rule cannot be patched in place

`fetchBlockFromCluster` computes two verdicts ten lines apart from the same consult:

- `silenceVerdict` (existence) is **three-level**: no silence → `confirmed`, partial silence →
  `unconfirmed`, silence with no answers → `isolated`.
- `nothingAheadVerdict` (currency) is **two-level**: `answered === 0` → `no-evidence`, otherwise
  `refuted`.

Partial silence therefore reads as an incomplete picture on one side and a complete refutation on
the other. Making them symmetric by hand leaves only two rules, both wrong at an edge:

- *any answer refutes* (today) — a peer that never knew the claim retires it;
- *only a fully-answered cohort refutes* — one permanently unreachable cohort member flags the
  block forever, and `TransactorSource.tryGet` / `NetworkTransactor.get` then raise
  `BlockPossiblyStaleError` on every unpinned read of it, permanently. That is a real availability
  loss, not a theoretical one.

The missing fact is **provenance**: which peers made the claim.

## The design

### One rule, stated once

> A recorded claim is retired when **at least one non-self cohort member answered** this consult
> and **no peer that made the claim was silent** in it.

That is total, and it needs only three things the consult already has: the silent set, the answered
set, and the claimants. The reasoning behind each of the three outcomes:

- A claimant that **answered**, on a consult whose verdict is "nothing ahead", has retired its own
  word. Its answer is evidence about its own claim — the only kind that counts.
- A claimant that was **silent** blocks retirement. Nobody else can speak for it.
- A claimant that is **neither answered nor silent** has left the cohort view: `findCluster` no
  longer holds it responsible for this block, so its old word does not bind the current cohort.
  This is what bounds the doubt (see below).

Note the arithmetic that makes it a one-liner: the non-self cohort *is* `answered` union `silent`,
so "answered, or gone from the cohort" is exactly "not silent". No membership set has to be carried
around or diffed.

### How doubt eventually settles when a claimant never returns

This is the part the fix ticket asked to have researched, and the answer is deliberately **not** a
timer. Erasing a correctness signal because time passed would re-open the same lie through a slower
door.

Doubt settles by **cohort membership**. `Libp2pKeyPeerNetwork.findCluster`
(`packages/db-p2p/src/libp2p-key-network.ts:969`) builds the cohort from the live routing table
(`fret.assembleCohort`), further filtered to peers positively classified as serving this network. A
peer that is permanently gone leaves the routing table, leaves the cohort view, and — by the rule
above — stops blocking retirement. No new mechanism, no new configuration.

Two consequences to accept and state in the code:

- **If a dead peer never leaves the cohort view, the memo stands forever.** That is a membership
  defect to fix in the membership layer, not a reason to lie in the read path. The block genuinely
  *is* possibly stale: a responsible cohort member holds a revision nobody can obtain. Give the
  operator a name for it (log line, below) rather than a silent erasure.
- **A transiently-shrunken cohort can retire a live claim early.** `findCluster` never admits a
  not-yet-identified ("unknown") member, so a peer mid-identify is briefly absent from the view and
  briefly looks departed. Self-correcting: when it rejoins and still holds the higher revision, the
  next consult re-records the claim from its answer. One window of clean reads, versus permanent
  denial from the alternative. State the tradeoff at the site.

### Type changes

`ClusterLatestQuery`:

```ts
	/** Non-self cohort members that answered the consult at all — with a claim or with
	 *  "I hold nothing". Was a bare count; the IDENTITIES are what lets a recorded claim be
	 *  matched against the peers that made it. `answered.length` is the old number, and the
	 *  non-self cohort is exactly `answered` union `silent`. */
	answered: string[];
	/** Every claim this consult collected, whatever the quorum then did with it — the caller
	 *  derives a claim's claimants as the peers claiming at or above the revision in doubt. */
	claims: readonly RevClaim[];
```

`CurrencyVerdict` — the `refuted` arm becomes evidence-carrying and is renamed so no existing
`return` keeps its old meaning by accident:

```ts
type CurrencyVerdict =
	/** The consult reached the cohort and nothing it heard is ahead of this node. Carries the
	 *  evidence rather than a pre-baked answer: `recordAheadClaim` decides whether that evidence
	 *  bears on the claim it actually holds. */
	| { kind: 'nothing-ahead'; answered: readonly string[]; silent: readonly string[] }
	/** No cohort member outside this node was asked, or none answered. No evidence either way:
	 *  a recorded memo stands exactly as it was. (Unchanged.) */
	| { kind: 'no-evidence' }
	/** Cohort peers `claimants` claim `rev`, strictly ahead of what this node holds, and this
	 *  pass did not converge onto it. */
	| { kind: 'unsettled-claim'; rev: number; claimants: readonly string[] };
```

`AheadClaimState` gains, next to `rev`:

```ts
	/** Which cohort peers reported `rev` when the claim was recorded — the peers whose answer is
	 *  evidence about it. Bounded by cohort width. Meaningless without `rev`; the two are written
	 *  and cleared together. */
	claimants?: readonly string[];
```

### Behaviour to keep working

These already-green specs pin the refutation path and must not regress. Each was checked against
the rule above by hand; in each, every claimant answers, so each still retires the memo:

- `drops the mark when peers answer with a claim strictly BELOW what this node holds`
- `drops the mark once a consult finds nothing ahead any more`
- `drops the mark when the surviving claim fails quorum AND is not ahead of us`
- `drops the mark once this node reaches the claimed revision` (untouched — the catch-up path in
  `flagUnconfirmedCurrency` is not part of this change)
- the three "asked nobody" specs (`solo-self exit`, `empty-cohort exit`, `total silence`) still take
  the `no-evidence` arm unchanged.

### Arm 2 falls out of the same change

No constructor-signature surgery. With provenance, a consult where `localPeerId` is unset records
the *remote* peer as the claimant (this node's own answer reads its own storage and so can only
ever corroborate the revision already held — the pre-existing NOTE at `queryClusterForLatest` makes
that argument and it still holds). When that remote peer then goes silent, it is a silent claimant
and the memo stands. This node agreeing with itself no longer retires anything.

Update the two NOTEs that currently defer to this ticket (`queryClusterForLatest`'s self-exclusion
NOTE and the `nothingAheadVerdict` NOTE) to say what the resolution actually was, rather than
deleting them.

### Multiple passes claiming the same block

`recordAheadClaim` currently overwrites on every `unsettled-claim`. With claimants that is not
enough: pass 1 records claimant A at rev 3, pass 2 sees B claim rev 3 while A is silent — retiring
later on B's answer alone would ignore A. Rule: **union the claimants when the new claim's `rev`
equals the recorded `rev`; replace outright otherwise.** A higher claim subsumes the old one; a
lower one is the newest-consult-is-authority behaviour the site comment already declares
intentional and the fix ticket put out of scope.

## Explicitly out of scope

- A consult whose corroborated revision is *lower* than the recorded claim still clears the claim.
  Called out as intentional at the site. Now that provenance exists it could be revisited — but not
  here; leave the comment and note in the review handoff that the option is now open.
- `tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` is the standing
  refactor for this file's per-block state. This ticket adds one field to an existing entry, not a
  fourth map. Read it, do not do it.

## TODO

- Widen `ClusterLatestQuery`: `answered: number` becomes `answered: string[]` (non-self peers that
  fulfilled), and add `claims: readonly RevClaim[]`. Update both return sites of
  `queryClusterForLatest` and its internal uses — `absent: answered - claims.length` in the
  `cluster-fetch:no-quorum` log becomes `answered.length - claims.length`, and the
  `reportRepairDeadlock` call passes `answered.length` (leave that method's `answered: number`
  parameter alone).
- Rewrite `CurrencyVerdict`: replace `{ kind: 'refuted' }` with
  `{ kind: 'nothing-ahead'; answered; silent }`, and add `claimants` to `unsettled-claim`. Keep the
  union doc comment's central point — a consult that reached nobody refutes nothing — and extend it
  to say that an answer only refutes the claim it actually bears on.
- Add `claimants?: readonly string[]` to `AheadClaimState`, written and cleared alongside `rev`.
  `deadlocksReported` keeps its independent lifetime; do not entangle them.
- In `fetchBlockFromCluster`, build `nothingAheadVerdict` as `no-evidence` when
  `answered.length === 0` and otherwise `{ kind: 'nothing-ahead', answered, silent }`. Replace the
  two NOTEs that defer to this ticket with the resolved reasoning, including the membership bound
  and the transient-shrink tradeoff stated above. State the relationship to `silenceVerdict` once,
  at that site — the two verdicts now differ because they answer different questions, not because
  one is unfinished.
- At the two `unsettled-claim` producers, populate `claimants` from `claims`: the uncorroborated
  branch uses the peers claiming at or above `uncorroboratedRev`; the corroborated-but-not-converged
  branch uses the peers claiming at or above `corroborated.rev`.
- Move the retirement decision into `recordAheadClaim` and put the one-sentence rule in its doc
  comment: retire on `nothing-ahead` only when `answered.length > 0` and no recorded claimant
  appears in `silent`; otherwise leave the memo untouched. Implement the union-vs-replace rule for
  a repeated `unsettled-claim`.
- Add a `cluster-fetch:claim-unrefutable` log line (blockId, rev, silent claimants) where
  retirement is declined because a claimant was silent — this is the operator's only signal that a
  block's doubt cannot settle. Emit it per pass, not say-once: `readRepairWindowMs` (10s default)
  rate-limits consults in `lazy` mode. Add a `NOTE:` at the line saying `paranoid` mode consults on
  every read and so logs on every read; if that ever shows as noise, move it behind a say-once flag
  rather than dropping it.
- Add specs to the `the mark outlives the consult (read-repair window)` describe in
  `packages/db-p2p/test/coordinator-repo-unavailable.spec.ts`, using its existing
  `buildUnacquirableCohort` / `shrinkCohort` / `makePresentStorageRepo` helpers, all in `paranoid`
  mode so a consult definitely runs on the second read:
  - **partial silence keeps the mark** — read 1 marks 3; read 2 has holder A reject and holder B
    answer `undefined`; expect `unconfirmedAheadRev === 3`.
  - **the field shape** — only holder A ever claims 3 (B answers `undefined` throughout); read 2
    has A reject; expect `unconfirmedAheadRev === 3`. This is the case a peer that never knew the
    claim must not be able to retire.
  - **a claimant that answers retires its own claim** — read 1 marks 3 from A alone; read 2 has A
    answer revision 1 while B stays silent. Expect the mark **gone**: the silent peer was never a
    claimant, and the rule must not degrade into "any silence blocks retirement".
  - **a departed claimant stops blocking** — read 1 marks 3 from A; `shrinkCohort` drops A from the
    cohort view; read 2 has B answer `undefined`. Expect the mark gone, and a comment naming this
    as the bound on how doubt settles.
  - **arm 2: this node's own answer refutes nothing** — construct `CoordinatorRepo` with
    `localPeerId` left `undefined` (cohort of two: this node plus holder A); read 1 marks 3 from A;
    read 2 has A reject. Expect `unconfirmedAheadRev === 3`.
- Update the `unconfirmedAheadRev` bullet in `docs/internals.md`: it currently names the verdict
  union as `refuted` / `no-evidence` / `unsettled-claim` and says "only a consult that actually
  reached a cohort member may clear it". Both are now wrong. State the retirement rule, and say
  that cohort membership — not a timer — is what lets doubt settle when a claimant never comes back.
- Run `yarn workspace @optimystic/db-p2p test` in the foreground and confirm green, plus a
  typecheck/build of the package.
