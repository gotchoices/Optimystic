description: Fix four small cohort-topic defects — a renewal carries an unrelated id instead of the registration's, three attacker-influenced lookup maps can grow without limit, a per-registration scan does far more work than needed at scale, and a retry counter permanently skips the best fallback member in each fresh list.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts              # renew correlationId; walk outcome consumer
  - packages/db-core/src/cohort-topic/walk.ts                 # AcceptedWalkOutcome (a); unwilling_member retry (d)
  - packages/db-core/src/cohort-topic/registration/renewal.ts # correlationId stored per registration (renewal.ts:231)
  - packages/db-core/src/cohort-topic/membership/verifier.ts  # byCoord/lastFetchAt/staleGapStrikes unbounded (142-150)
  - packages/db-core/src/cohort-topic/traffic.ts              # snapshot() O(members × summaries) (129-157)
  - packages/db-core/src/cohort-topic/gossip/view.ts          # MemberContribution.topicSummaries — index source for (c)
  - packages/db-core/src/utility/lru-map.ts                   # reusable LruMap<K,V> for (b)
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts # reference LRU-cap pattern (b)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts # reference LRU-cap pattern (b)
  - docs/cohort-topic.md                                      # RenewV1 wire shape (~line 1402) for (a)
difficulty: medium
----

# Four assorted cohort-topic fixes

Four independent low-severity defects in the participant/cohort substrate. All small; do them in one
change but keep the commits reviewable per-defect. Build + typecheck + tests must pass before handoff.

Note on scope drift from the source fix ticket: the source ticket described defect (a) as "renew stamps
the **cohort epoch**". The code has since moved — `service.ts:304` now stamps a **fresh random nonce**
(`freshCorrelationId()`), not the epoch, and carries a comment defending that choice. The defect is still
real (renew's id does not correlate to the registration, contradicting the docs) but the corrective wording
below reflects the *current* code, not the stale ticket text.

---

## (a) Renew carries an unrelated correlation id, not the registration's

**Current state.** `service.ts:startRenewal` (~line 296-306) creates the renewal participant with
`correlationId: this.freshCorrelationId()` — a fresh 16-byte CSPRNG nonce, generated once per
registration and reused for every `ttl/3` renew ping (stored in `renewal.ts` as `this.deps.correlationId`,
stamped at `renewal.ts:231`). A comment at `service.ts:300-303` argues this is fine because "a renew's
correlationId … is never read on the cohort side".

**Why it's wrong.** `docs/cohort-topic.md` §Wire (RenewV1, ~line 1402) documents
`correlationId: string   // matches original RegisterV1`. The stamped nonce is unrelated to *any* of the
register probes' correlation ids (the walk mints a fresh one per probe at `service.ts:367`), so the wire
contract is violated and a future renew-path freshness/replay guard cannot correlate a renew back to the
registration it renews. Not a live behavioral bug today (nothing reads renew `correlationId` on the cohort
side — verified: only written at `renewal.ts:231`, wire-validated at `wire/validate.ts:193`, never read),
but a latent contract break the moment that guard lands.

**Correction (prescribed direction — code to match docs).** Carry the *accepted register's*
`correlationId` into the renewal so renew echoes it:

- `walk.ts`: add `readonly correlationId: string` to `AcceptedWalkOutcome`, and on the `"accepted"`
  branch (`walk.ts:205-207`) populate it from the accepted probe's frame — `reg.correlationId` (the last
  `reg` built by `factory.build`, `walk.ts:194`, is the accepted one).
- `service.ts`: `handleFromOutcome` (~line 273-280) and `startRenewal` (~line 282-306) thread that
  `correlationId` into `createRenewalParticipant({ …, correlationId })` instead of calling
  `freshCorrelationId()` there.
- Replace the now-wrong comment at `service.ts:300-303` with one stating renew echoes the accepted
  register's correlation id per the wire contract.

**Property to preserve / NOTE for the implementer.** Every periodic renew for one registration continues
to share a *single* correlation id (as it already does today — this change only makes that shared id equal
the register's, not an independent nonce). A future renew replay guard therefore must key renews by
`(correlationId, timestamp-window)`, **not** by "drop any repeated correlationId" — else it would reject
the 2nd+ legitimate renew. Leave a `// NOTE:` at the renew-id site to that effect so the future guard
author meets it.

**Documented alternative (implementer's call, justify in the review handoff).** The lighter fix is the
reverse reconciliation: keep the fresh-nonce code and change the docs (RenewV1 `correlationId` comment) to
say "16-byte nonce, per-registration". Choose this only if you judge the future renew-guard will not need
register↔renew correlation; the source ticket author explicitly asked for the docs-compliant direction, so
default to the prescribed fix and record the tradeoff if you deviate.

---

## (b) LRU-cap three unbounded verifier maps

`membership/verifier.ts:142-150` — `byCoord`, `lastFetchAt`, and `staleGapStrikes` are plain `Map`s keyed
by `coordKey` (base64url of a `RingCoord`, attacker-derivable). Under a flood of verify-misses against
attacker-chosen coords each grows without bound.

Cap them, mirroring the caps that already landed on the sibling anti-DoS structures:
- `antidos/replay-guard.ts` — hard `maxKeys` LRU cap, oldest-inserted evicted (see class doc 15-24 and the
  eviction loop 114-118).
- `antidos/rate-limiter.ts` — `maxKeys` LRU via delete-then-set recency (see 136-161).
- Reusable helper: `packages/db-core/src/utility/lru-map.ts` (`LruMap<K,V>`: `get`/`set`/`has`/`delete`/
  `clear`/`size`/iterator, delete-then-set recency, evicts oldest on overflow). Prefer reusing it over a
  fourth hand-rolled cap.

Points to decide while implementing:
- Expose the cap via a `MembershipVerifierDeps` field (e.g. `maxCoords?`, default in the same 100k
  ballpark as `DEFAULT_REPLAY_GUARD_MAX_KEYS`) with the same positive-integer `RangeError` guard the
  siblings use.
- The three maps share the `coordKey` keyspace. Simplest correct approach: cap each independently and
  accept that the auxiliary maps (`lastFetchAt`, `staleGapStrikes`) may briefly retain a coord `byCoord`
  has evicted — harmless (a stale `lastFetchAt` at worst permits one extra refetch; a stale strike count is
  itself bounded). If you instead make `byCoord` authoritative and drop aux entries on its eviction, keep
  it simple — don't over-engineer cross-map coherence.
- **NOTE / tripwire for the implementer:** `byCoord` also holds this node's own `cache()`-published
  *trusted* cert (the trust lock, `verifier.ts:163-167`). Under an attacker-coord flood the LRU could evict
  a trusted self-published entry, re-opening the coord to TOFU on next sight. This mirrors the documented
  penalty tradeoff on the replay-guard cap and is acceptable, but record it as a `// NOTE:` at the cap site
  (per the source ticket's tripwire guidance) so a future reader knows the trust lock is best-effort under
  memory pressure — do **not** file it as a separate ticket.

---

## (c) Index the traffic snapshot by topic instead of scanning

`traffic.ts:snapshot` (129-157) loops over every sibling `MemberContribution` in the cohort view and does
`contribution.topicSummaries.find((s) => s.topicId === topicB64)` — an O(members × summaries) linear scan
per register reply (~32k comparisons at cohort scale). `topicSummaries` is a flat readonly array on
`MemberContribution` (`gossip/view.ts:13-26`).

Make the per-topic lookup O(1):
- Build a `Map<topicIdB64, summary>` per member so `snapshot` does a lookup, not a `.find`. The source
  ticket suggests indexing "at merge time" — i.e. in `gossip/view.ts` `MapCohortView.merge` (view.ts:53-60),
  derive and store the index alongside (or in place of) the flat array so writers pay the O(summaries) cost
  once per gossip round instead of readers paying it per reply.
- Whichever layer owns the index, keep `MemberContribution.topicSummaries` (or an equivalent iterable)
  available — `toCohortTopicSummary`/gossip-frame producers and any other consumer still need the list
  form. Net target: `snapshot()` is O(members + summaries), not O(members × summaries).

---

## (d) Walk retry must start each fresh candidate list from its best member

`walk.ts:283-294` (`unwilling_member`) picks `candidates[memberAttempts % candidates.length]` and
`memberAttempts` only resets to 0 on `no_state` (line 211) and `promoted` (line 253) — **not** between
successive `unwilling_member` replies. So after dialing `candidates[0]` of the first list and getting a
*fresh* candidate list back, the next pick is `candidates[1 % len]`, permanently skipping the first (best)
candidate of every subsequent list.

Fix: track *which member ids have been tried* rather than a positional counter, so each fresh list is
consumed from its best (index-0) candidate:
- Keep a `Set<string>` of tried candidate keys (base64url member ids) for the walk. On each
  `unwilling_member`, pick the first candidate **not** in the set; add it; dial it.
- Retain the retry cap: `memberAttempts` (or `triedSet.size`) still gates against `maxMemberRetries`, and
  "no untried candidate in this list" falls through to the temporal back-off exactly as the
  `candidates.length === 0` / cap-exhausted branch does today (line 285-289).
- Reset the tried-set on the same transitions that reset `memberAttempts` today (`no_state` at 209-211,
  `promoted` at 251-253) so a spatial move to a new coord starts fresh.
- Preserve the existing behavior for the degenerate cases: empty candidate list → back off; every
  candidate already tried → back off.

---

## Expected behavior (acceptance)

- Renew carries the accepted register's `correlationId` (matches `docs/cohort-topic.md` RenewV1); the
  stale defending comment is gone; a `// NOTE:` records the shared-id / renew-guard-keying constraint.
- The three verifier maps are size-bounded under attacker-chosen coords, capped via `LruMap` (or the same
  pattern), with the trust-lock-eviction tradeoff noted at the site.
- `snapshot()` is O(members + summaries) via a topic-id index; list-form consumers still work.
- The walk tries the best (index-0) candidate of every fresh `unwilling_member` list; no candidate is
  permanently skipped; the retry cap and back-off fall-through are unchanged.

## Validation

- `yarn workspace @optimystic/db-core build` (or the repo's typecheck) — must pass.
- Run the cohort-topic tests, streaming output: e.g. `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core-test.log` (confirm the actual test invocation from `packages/db-core/package.json`; do not silently redirect).
- Add/extend tests per defect:
  - (a) accepted walk surfaces the register's correlationId and the renewal stamps it.
  - (b) each capped map stays ≤ cap under a burst of distinct coords; a positive-integer `maxCoords`
    guard rejects bad config.
  - (c) `snapshot` returns identical numbers before/after the index change (equivalence test over a
    multi-member view), and does not call `.find` per member (or simply assert correctness — the win is
    internal).
  - (d) a sequence of `unwilling_member` replies with fresh lists dials each list's index-0 candidate;
    the cap and back-off still terminate the walk.

## TODO

- [ ] (a) Add `correlationId` to `AcceptedWalkOutcome`; populate from the accepted `reg` in `walk.ts`.
- [ ] (a) Thread it through `service.ts` `handleFromOutcome` → `startRenewal` → `createRenewalParticipant`; drop the `freshCorrelationId()` call there; replace the defending comment; add the renew-guard-keying `// NOTE:`.
- [ ] (b) LRU-cap `byCoord`, `lastFetchAt`, `staleGapStrikes` via `LruMap`; add a `maxCoords?` dep + positive-int guard; add the trust-lock-eviction `// NOTE:`.
- [ ] (c) Index `topicSummaries` by topic id (prefer at merge in `gossip/view.ts`); rewrite `snapshot`'s per-member `.find` as an O(1) lookup; keep list-form consumers working.
- [ ] (d) Replace `memberAttempts % candidates.length` with a tried-member `Set`; reset it on the `no_state`/`promoted` transitions; keep the cap + back-off fall-through.
- [ ] Add/extend the per-defect tests above; run build + tests (streamed) green.
- [ ] Write the review/ handoff: honest about the (a) design tension (docs-compliant vs. doc-reconcile) and the two documented tripwires (verifier trust-lock eviction, renew-guard keying).
