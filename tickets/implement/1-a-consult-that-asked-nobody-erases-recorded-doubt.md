description: When a machine loses contact with the others that share a record, it forgets that it had already been told a newer version exists — and then serves its old copy as if it were confirmed current.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster` return type and its `return` sites; `recordAheadClaim`; the `get` call site around line 698; `AbsenceVerdict` sits directly above where the new type belongs)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (the `the mark outlives the consult (read-repair window)` describe, around line 575 — the new specs belong beside the three that already live there)
difficulty: medium
repro: verified
----

# A freshness check that reached nobody must not erase recorded doubt

## What goes wrong

A node that reads a record it holds may ask the other machines responsible for that record
whether they hold something newer. When one of them says yes but the node cannot obtain the
newer version, the node **remembers the doubt** in a per-block memo
(`unsettledAheadClaims`), and later reads of that record are stamped
`unconfirmedAheadRev` — the flag that eventually surfaces as `BlockPossiblyStaleError`. The
memo exists precisely so the doubt survives reads where no fresh check runs.

The memo is erased by a check that **asked nobody at all**. `fetchBlockFromCluster` has three
exits that consult no cohort member — the solo-self short-circuit, the empty-cohort exit, and
(unreachable from `get` today) the no-callback exit — plus a fourth situation, every asked
peer failing to answer, that also learns nothing. All of them return `claimedAheadRev:
undefined`, `get` passes that to `recordAheadClaim`, and the memo is deleted. The stale copy
then goes back to the caller unflagged, as confirmed-current — the exact silent-stale answer
the memo was introduced to prevent.

`recordAheadClaim`'s own doc comment states the invariant being broken:

> Only a consult that actually RAN may call this: it is the authority, so `undefined` clears
> a claim an earlier pass recorded.

The read path cannot honour that, because the value it decides from cannot express the
difference: `claimedAheadRev: undefined` means both "peers answered and none of them claims
anything ahead" (a real refutation, the only case that may clear the memo) and "nobody was
asked, or nobody answered" (no evidence at all). The companion `absence` field does not
separate them either — the solo-self and empty-cohort exits both report `'confirmed'`, the
same verdict a healthy cohort produces when it genuinely holds nothing newer.

This is the currency half of the flattening `AbsenceVerdict` already fixed for the existence
half. Adding a condition at the one call site would leave the ambiguous return value in place
for the next caller; the fix is to make "no evidence" and "refuted" distinguishable **in the
value itself**, so a future exit cannot mean the wrong one by omission.

## Reproduction (re-verified 2026-09-06 at `main` = e66597f4)

Drive `CoordinatorRepo` with the stubs already in `coordinator-repo-unavailable.spec.ts`:
`readRepairMode: 'paranoid'` so a consult runs on every read, cohort of three, local copy at
rev 1, both remote peers claiming rev 3 which cannot be acquired (no acquisition callback
wired, nothing local to promote).

1. First read → `result[blockId].unconfirmedAheadRev === 3`. Correct.
2. Change one thing, then read again. Three variants, **all three reproduce**:
   - shrink the `findCluster` result to this node alone (solo-self exit);
   - make the `findCluster` result empty (empty-cohort exit);
   - keep the cohort and make both remote callbacks throw (total silence).
3. Second read → `unconfirmedAheadRev` is `undefined` and no `unavailable` flag either. The
   stale rev-1 copy is served as confirmed-current.

The probe was a scratch spec, run and deleted; the specs listed under TODO below re-create it
in the tree.

## Shape of the fix

Give the consult a **named currency verdict** as a required field, so every `return` in
`fetchBlockFromCluster` has to state which of the three it means and the compiler enforces it:

```ts
/**
 * What one consult established about whether this node's copy is CURRENT — the currency
 * counterpart to {@link AbsenceVerdict}. Three cases, and the difference between the first
 * two is the whole point: a consult that reached nobody refutes nothing.
 */
type CurrencyVerdict =
	/** At least one cohort member outside this node answered, and nothing they said is a
	 *  revision ahead of this node that the pass left unsettled. A refutation — the ONLY
	 *  verdict that may clear a memo an earlier pass recorded. */
	| { kind: 'refuted' }
	/** No cohort member outside this node was asked (no cohort, solo-self, no callback) or
	 *  none answered. No evidence either way: a recorded memo stands exactly as it was. */
	| { kind: 'no-evidence' }
	/** A cohort peer claims `rev`, strictly ahead of what this node holds, and this pass did
	 *  not converge onto it — quorum declined the claim, or corroborated it and acquisition
	 *  failed. */
	| { kind: 'unsettled-claim'; rev: number };
```

`fetchBlockFromCluster` returns `{ absence: AbsenceVerdict; currency: CurrencyVerdict }` —
`currency` **required**, never optional, so a new exit added later cannot default into
"refuted" by leaving a field off. `recordAheadClaim(blockId, currency)` then reads:
`no-evidence` returns immediately without touching the map; `refuted` clears `rev` while
preserving `deadlocksReported` exactly as the `undefined` branch does today;
`unsettled-claim` records `rev`.

### Verdict per exit

`answered` (already on `ClusterLatestQuery`) is the discriminator for everything after the
query: it counts cohort members other than this node that answered at all.

| exit in `fetchBlockFromCluster` | `absence` (unchanged) | `currency` |
|---|---|---|
| no `clusterLatestCallback` | `confirmed` | `no-evidence` |
| `peerIds.length === 0` (empty cohort) | `confirmed` | `no-evidence` |
| solo-self short-circuit | `confirmed` | `no-evidence` |
| no corroboration, claim strictly ahead | `claimed` | `unsettled-claim` |
| no corroboration, claim present but not ahead | `claimed` | shared value¹ |
| no corroboration, no claim | `silenceVerdict` | shared value¹ |
| corroborated at/below baseline (`local-current`) | `silenceVerdict` | shared value¹ |
| converged onto the corroborated revision | `silenceVerdict` | shared value¹ |
| corroborated but not converged | `claimed` | `unsettled-claim` (`corroborated.rev`) |

¹ Compute this **once**, right beside the existing `silenceVerdict` line, and use the same
value at every one of those exits — the `answered === 0` rule then lives in one place instead
of being re-derived at four `return`s, which is the same discipline `silenceVerdict` already
applies to the existence half:

```ts
// Mirror of `silenceVerdict` for the CURRENCY half: a consult that reached NOBODY outside
// this node refutes nothing, so a memo an earlier pass recorded must survive it. Only an
// answer from a cohort member is evidence that nothing is ahead.
const nothingAheadVerdict: CurrencyVerdict =
	answered === 0 ? { kind: 'no-evidence' } : { kind: 'refuted' };
```

Two notes on why the table is safe where it looks loose:

- The "claim present but not ahead" and `local-current` rows can only be reached when a peer
  answered (`uncorroboratedRev` and `corroborated` both come from peer claims), so
  `nothingAheadVerdict` resolves to `refuted` there in practice. Using the shared value
  anyway keeps the rule stated once rather than asserted per site.
- `answered === 0` with an empty `silent` set is reachable: a self-only cohort where
  `localPeerId` was left unset skips the solo short-circuit and queries only self. That is
  another consult that learned nothing, and keying on `answered` rather than on
  `silenceVerdict` covers it.

### What must not change

- A consult that **did** reach a cohort member and found nothing ahead still clears the memo
  (the existing `drops the mark once a consult finds nothing ahead any more` spec must keep
  passing).
- A block that reaches the claimed revision still clears the memo — that rule lives in
  `flagUnconfirmedCurrency`, not here, and is untouched.
- The `absence` column is unchanged in every row. This ticket does not re-open which absence
  verdict any exit reports.
- The read-repair window arming (`markBlocksSeen`) is unchanged. Doubt-memory and
  window-arming are deliberately different questions: the solo exit arms the window (ticket
  `solo-node-read-repair-never-settles`) *and* must leave the memo alone. Note the
  consequence out loud in a comment at the solo exit — with the window armed, retained doubt
  now persists for up to `readRepairWindowMs` before the next consult can refute it, which is
  correct (the window damps repair effort, not honesty) and is the same coupling the existing
  comment at the final exit already describes.
- The `catch` arm in `get` already leaves the memo alone; leave it alone.

## TODO

- Add the `CurrencyVerdict` union next to `AbsenceVerdict` in `coordinator-repo.ts`, with the
  doc comment saying plainly that `no-evidence` and `refuted` are different because a consult
  that reached nobody refutes nothing.
- Change `fetchBlockFromCluster`'s return type to `{ absence: AbsenceVerdict; currency: CurrencyVerdict }`
  and update its doc comment's `claimedAheadRev` bullet to describe `currency` instead.
- Compute `nothingAheadVerdict` beside `silenceVerdict` and fill in every `return` per the
  table above. Confirm with `yarn workspace @optimystic/db-p2p typecheck` that a `return`
  missing `currency` is a compile error — that enforcement is the point of the ticket.
- Rewrite `recordAheadClaim` to take a `CurrencyVerdict`: `no-evidence` → no-op;
  `refuted` → today's clearing branch (preserving `deadlocksReported`); `unsettled-claim` →
  today's set branch. Update its doc comment — the "only a consult that actually RAN may call
  this" caveat becomes a statement the type enforces rather than a rule the caller must obey.
- Update the single call site in `get` (`this.recordAheadClaim(blockId, claimedAheadRev)`).
- Add three specs beside the `the mark outlives the consult (read-repair window)` describe in
  `coordinator-repo-unavailable.spec.ts`, one per reproduction variant: solo-self, empty
  cohort, total silence. Each: first read marks at rev 3, change the world, second read still
  marks at rev 3. The existing `buildUnacquirableCohort` helper builds the first read; the
  cohort object it returns needs to become mutable between reads (the pattern is already in
  `coordinator-repo-solo-read-repair-window.spec.ts`'s `makeMutableKeyNetwork`).
- Add one spec pinning the subtle refutation: peers answer and their highest claim is **not**
  ahead of what this node holds → the memo IS cleared. That is the row most likely to be
  broken by an over-cautious reading of this ticket.
- Run `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/db-p2p typecheck`.
  `coordinator-repo-solo-read-repair-window.spec.ts` and the rest of
  `coordinator-repo-unavailable.spec.ts` must pass untouched.
- Append a short arm to `tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md`
  recording that the currency half is now a named verdict too, so the eventual extraction
  inherits both halves named rather than one verdict plus a loose optional number.

## Scope notes

- **Pre-existing, not introduced by `solo-node-read-repair-never-settles`.** That fix arms the
  read-repair window on the solo exit; it did not create this erasure. It does lengthen the
  consequence on the solo path (the next consult is deferred by up to `readRepairWindowMs`).
  The total-silence variant — the common one in the field — behaves identically before and
  after that fix.
- The three existing specs under `the mark outlives the consult` all cover consults that
  **did** run, which is why this survived.
- Distinct from `a-reader-cannot-tell-its-view-stopped-advancing` (already through review):
  that one is about a node's own writes wrongly counting as proof of freshness — the
  *window*. This one is about remembered doubt erased by a non-check — the *memo*. Different
  statements, no ordering dependency.
