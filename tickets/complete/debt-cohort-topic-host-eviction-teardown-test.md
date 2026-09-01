description: When a node drops its least-used topic to make room for a new one, we now test that the dropped topic actually stops being served, not just that its budget slot is freed.
files:
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # the only file changed (implement + review)
  - packages/db-p2p/src/cohort-topic/host.ts                                # unchanged; `onEvict` (~2076) and the `servesTopic`/`forwarder` diagnostics (~2304, ~2307) are what the test pins
  - packages/db-core/test/cohort-topic/traffic.spec.ts                      # existing `forget()` coverage the test's NOTE defers to
  - docs/cohort-topic.md                                                    # line 1022 already documents the eviction teardown — verified accurate, unchanged
difficulty: easy
----

# Complete: cohort-topic host eviction teardown test

## What landed

Test-only. In `packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts`, describe
`§Anti-DoS — per-cohort topic budget`, test `'a topic drained by the engine TTL sweep releases its budget
slot, ...'`. That test covered only the budget-slot side of an eviction. It now also asserts the teardown
side — the evicted topic stops being served and its cold-start forwarder entry is gone — with negative
controls proving teardown hit only the evicted topic:

```ts
expect(decidingEngine.forwarder(TOPIC_B), 'B holds a cold-start forwarder before eviction').to.not.equal(undefined);  // pre-condition (added in review)
...
expect(decidingEngine.servesTopic(TOPIC_B), ...).to.equal(false);
expect(decidingEngine.forwarder(TOPIC_B), ...).to.equal(undefined);
expect(decidingEngine.forwarder(TOPIC_A), ...).to.not.equal(undefined);
expect(decidingEngine.servesTopic(TOPIC_C), ...).to.equal(true);
expect(decidingEngine.forwarder(TOPIC_C), ...).to.not.equal(undefined);
```

No production code changed at any stage.

## Review findings

### Checked

- **Read the implement diff first.** Note for the record: the test edit actually landed in the *plan*
  commit `6b26adcc`; the `implement` commit `0cf76839` moved only the ticket file and carried no code.
  The content is in the tree either way and matches the handoff description, so nothing was lost — but a
  reader tracing this ticket by `git log --grep="ticket(implement): <slug>"` finds an empty diff.
- **Are the new assertions load-bearing, or vacuous?** This was the real risk: `servesTopic` is
  `store.directParticipants(topicId) > 0 || coldStart.get(topicId) !== undefined`, and the TTL sweep
  already drives `directParticipants` to 0 on its own. If the sweep (or anything else) also removed the
  forwarder, the new assertions would pass with `onEvict` gutted. Verified two ways:
  - `coldStart.remove` has exactly one call site in the whole package — `onEvict` at `host.ts:2077`.
  - Mutation-tested it: stubbed `onEvict` to a no-op, ran
    `yarn workspace @optimystic/db-p2p test --grep "topic drained by the engine TTL sweep"`, and it failed
    on precisely the intended assertion (`the evicted topic no longer serves — its forwarder was torn
    down: expected true to be false`). `host.ts` restored to HEAD afterwards (`git diff` on it is empty).
- **The declared `traffic.forget()` gap.** Confirmed the handoff's reasoning holds:
  `packages/db-core/test/cohort-topic/traffic.spec.ts` has four `forget()` tests (clears windowed +
  last-published counts, snapshot excludes the forgotten local contribution, idempotent on an unobserved
  topic) driving `publish()` directly — the layer where `forget` is actually observable. Asserting it from
  this e2e depth would be vacuous exactly as claimed. Gap accepted as intentional.
- **Docs.** `docs/cohort-topic.md:1022` already describes the eviction teardown ("Evicting a topic also
  tears down its cold-start forwarder and traffic window (via the budget's `onEvict` hook)…") and is
  accurate against `host.ts`. No doc change needed.
- **Lint / typecheck / tests.** `yarn lint` clean, `yarn workspace @optimystic/db-p2p typecheck` clean,
  `yarn workspace @optimystic/db-p2p test` → **2489 passing, 49 pending, 0 failing**. No pre-existing
  failures surfaced.

### Fixed inline (minor)

- **Missing pre-condition made the teardown assertions structurally vacuum-prone.** The test asserted
  `forwarder(TOPIC_B) === undefined` after eviction but never established that B *had* a forwarder before
  it. The mutation test proves it does today, but nothing in the test file pinned it, so a future change
  that stopped creating forwarders for B would silently turn these assertions into no-ops instead of
  failing. Added `expect(decidingEngine.forwarder(TOPIC_B), 'B holds a cold-start forwarder before
  eviction').to.not.equal(undefined)` right after B instantiates.
- **Two wrong claims in the new comments.** The `NOTE:` called `traffic.forget` "the third onEvict arm" —
  `onEvict` has two arms (`coldStart.remove`, `traffic.forget`). And it pointed at a bare `traffic.spec.ts`,
  which does not exist in `db-p2p`; the file is `packages/db-core/test/cohort-topic/traffic.spec.ts`. Both
  corrected.

### Major findings → new tickets

**None.** Nothing found warranted a ticket: the production behaviour under test is correct (mutation-verified),
the one declared gap is genuinely unobservable at this layer and covered elsewhere, and the two defects found
were both in the new test file and cheap to fix in place.

### Tripwires recorded

**None.** No conditional "fine now, matters if X" concern surfaced. The handoff floated broader eviction
scenarios (several topics evicted in one sweep; eviction racing a concurrent registration) as possible
follow-ups — deliberately not filed and not recorded as a tripwire, because `onEvict` is a synchronous
per-eviction callback with a single call site and no shared state across evictions, so a second or
concurrent eviction exercises the identical code path. There is no condition under which the untested
scenarios become a distinct risk, which makes them neither a ticket nor a tripwire.

### Accepted-tradeoff NOTEs encountered

One nearby, at `host.ts:2296-2301` (query-window pruning for non-resident topics — "harmless now… if a node
ever serves high-volume queries for topics it holds no records for, prune non-resident windows on a timer").
Its revisit condition has not tripped and it is outside this ticket's scope; left alone.

### Stale artifact noticed (out of scope, no ticket)

`docs/review.html:391` still describes `TrackingColdStartManager` as having no removal API and budget
eviction leaving the victim's forwarder resident — the exact bug this test now guards against, since fixed.
It reads as a historical/generated review snapshot rather than live documentation, and it predates this
ticket, so it was not edited here. Worth a sweep if anyone treats `docs/review.html` as current.
