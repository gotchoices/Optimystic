description: A machine that loses contact with the others sharing a record used to forget it had been told a newer version exists, then serve its old copy as confirmed-current; it now keeps that doubt unless peers actually answer and refute it.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CurrencyVerdict` type ~line 318; `fetchBlockFromCluster` return type and its six exits ~lines 962-1123; `nothingAheadVerdict` beside `silenceVerdict` ~line 1038; `recordAheadClaim` ~line 826; the `get` call site ~line 718)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (`the mark outlives the consult (read-repair window)` describe, ~lines 577-760: `buildUnacquirableCohort` + `shrinkCohort` helpers and four new specs)
  - tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md (eleventh-measurement arm appended)
difficulty: medium
----

# A freshness check that reached nobody no longer erases recorded doubt

## What changed and why

`CoordinatorRepo` remembers, per block, that a cohort peer once claimed a revision ahead of
what this node holds and that the repair could not settle it (`unsettledAheadClaims`). Reads
served below that claim get stamped `unconfirmedAheadRev`, which surfaces to callers as
`BlockPossiblyStaleError`. The memo exists so the doubt outlives the consult that formed it.

The memo was being erased by consults that asked nobody. `fetchBlockFromCluster` reported its
currency finding as `claimedAheadRev?: number`, and `undefined` meant two different things:
"peers answered and nothing is ahead" (a real refutation, which may clear the memo) and
"nobody was asked, or nobody answered" (no evidence at all, which may not). Four situations
produced the second meaning while looking like the first — the solo-self short-circuit, the
empty-cohort exit, the no-callback exit, and every asked peer failing to answer. `get` passed
that `undefined` to `recordAheadClaim`, which deleted the memo, and the stale copy went back
unflagged as confirmed-current.

The fix makes the difference expressible **in the value**, not conditional at the call site:

```ts
type CurrencyVerdict =
	| { kind: 'refuted' }                          // a cohort member answered; nothing ahead
	| { kind: 'no-evidence' }                      // nobody asked, or nobody answered
	| { kind: 'unsettled-claim'; rev: number };    // a peer claims `rev` ahead; we did not converge
```

`fetchBlockFromCluster` now returns `{ absence: AbsenceVerdict; currency: CurrencyVerdict }`
with `currency` **required**, so an exit added later cannot mean "refuted" by leaving a field
off. `recordAheadClaim(blockId, currency)` reads it: `no-evidence` returns without touching
the map, `refuted` runs the previous clearing branch (still preserving `deadlocksReported`),
`unsettled-claim` records `rev`.

A shared `nothingAheadVerdict` is computed once beside the existing `silenceVerdict`:

```ts
const nothingAheadVerdict: CurrencyVerdict =
	answered === 0 ? { kind: 'no-evidence' } : { kind: 'refuted' };
```

Every "nothing ahead" exit uses that shared value rather than re-deriving the rule, mirroring
the discipline `silenceVerdict` already applies to the existence half. It keys on `answered`
(cohort members other than this node that answered at all) rather than on `silenceVerdict`,
which covers the reachable `answered === 0` case with an empty `silent` set: a self-only
cohort where `localPeerId` was left unset skips the solo short-circuit and queries only self.

The `absence` verdict at every exit is unchanged. Read-repair window arming
(`markBlocksSeen`) is unchanged — the solo exit still arms the window *and* now also keeps the
memo, and a comment there states the consequence out loud: retained doubt can persist for up
to `readRepairWindowMs` before a consult can refute it, which is correct because the window
damps repair effort, not honesty.

## How to test, validate, and use it

### The behaviour to exercise

Drive `CoordinatorRepo` with `readRepairMode: 'paranoid'` (so a consult runs on every read),
a cohort of three, a local copy at rev 1, and both remote peers claiming rev 3 that cannot be
acquired. First read stamps `unconfirmedAheadRev === 3`. Then change one thing and read again:

| change between reads | before this fix | after |
|---|---|---|
| cohort view shrinks to this node alone | mark erased | mark survives at 3 |
| cohort view comes back empty | mark erased | mark survives at 3 |
| both remote callbacks throw | mark erased | mark survives at 3 |
| remote peers answer with a rev *below* what this node holds | mark cleared | mark cleared (unchanged) |

### Specs added

Four, all in the `the mark outlives the consult (read-repair window)` describe in
`packages/db-p2p/test/coordinator-repo-unavailable.spec.ts`:

- `keeps the mark when the cohort shrinks to this node alone (solo-self exit)`
- `keeps the mark when the cohort lookup comes back empty (empty-cohort exit)`
- `keeps the mark when every cohort peer goes silent (total silence)`
- `drops the mark when peers answer with a claim strictly BELOW what this node holds`

The fourth pins the refutation that must keep working — the row most easily broken by an
over-cautious reading of the fix. It is deliberately arranged so the served revision (2) stays
*below* the memo (3), which means the catch-up branch in `flagUnconfirmedCurrency` cannot fire
and the refutation itself is the only thing that can clear the mark. That distinguishes it
from the pre-existing `drops the mark once a consult finds nothing ahead any more`, which uses
equality.

Two small test-helper changes support these: `buildUnacquirableCohort` now also returns
`holderA`, `holderB` and a `silenceRemotes()` switch, and a `shrinkCohort(cluster, keep?)`
helper deletes peers from the cohort object in place (`makeKeyNetwork` spreads at call time,
so the shrink takes effect on the next `findCluster`). Additive — the three pre-existing specs
in that describe use the helper unchanged and still pass.

### Verification actually run

- `yarn workspace @optimystic/db-p2p typecheck` — **passes**.
- `yarn workspace @optimystic/db-p2p test` — **2571 passing, 49 pending, 0 failing**.
  `coordinator-repo-solo-read-repair-window.spec.ts` and the rest of
  `coordinator-repo-unavailable.spec.ts` pass untouched.
- **Compiler enforcement confirmed, which was the point of the ticket.** After changing the
  return type, every one of the six `return` statements in `fetchBlockFromCluster` produced
  `TS2741: Property 'currency' is missing`, and they were fixed one at a time. A future exit
  that omits `currency` will not compile.
- **The new specs were confirmed non-vacuous.** With `recordAheadClaim` temporarily reverted
  to treat `no-evidence` like `refuted`, the three "keeps the mark" specs fail with exactly the
  reported bug (`expected undefined to equal 3`) while the refutation spec and the three
  pre-existing specs still pass. Reverted immediately after.

## Known gaps and things worth an adversarial look

- **The no-callback exit is not covered by a spec.** `fetchBlockFromCluster` returns early
  when `clusterLatestCallback` is unset, but `get` only enters that block when the callback
  *is* set, so the exit is unreachable from the read path today. The ticket said as much. It
  now returns `no-evidence` for correctness, untested. Worth deciding whether the exit should
  exist at all rather than adding a spec that can only be reached by calling a private method.
- **Two table rows are argued, not asserted per site.** "Claim present but not ahead" and the
  `local-current` exit use `nothingAheadVerdict`, which resolves to `refuted` there in practice
  because both are only reachable when a peer answered (`uncorroboratedRev` and `corroborated`
  both come from peer claims). If that reasoning is wrong for some path, those two exits would
  clear a memo they should not. The new fourth spec covers `local-current`; "claim present but
  not ahead" (a claim that fails the corroboration quorum *and* is at or below the baseline)
  has no dedicated spec.
- **`answered === 0` with an empty `silent` set is handled but untested.** The self-only-cohort
  with-unset-`localPeerId` shape that reaches it is described in a comment in
  `queryClusterForLatest`, and is why the rule keys on `answered`; no spec constructs it.
- **The behaviour change on the solo path is a real product decision, not just a bug fix.**
  A solo node that once heard a rev-3 claim will now keep flagging its reads
  `unconfirmedAheadRev` — hence `BlockPossiblyStaleError` — indefinitely, until a cohort
  reappears and refutes the claim or the block reaches that revision. That is the honest
  answer and it is what the ticket asked for, but a reviewer should confirm no caller treats
  a persistent stale flag on a solo node as fatal rather than advisory.
- **`packages/db-p2p/dist/` holds a stale build** whose `.d.ts` still mentions
  `claimedAheadRev`. Build output, not edited; noted only so a reviewer grepping the tree is
  not confused by the hit.

## Tripwires recorded

None new. The consequences that could have been tripwires are stated as comments at the exact
sites they belong to instead — the window/memo coupling at the solo-self exit, and the
"resolves to refuted in practice" reasoning at the two argued rows above.
