description: Migrated the six cohort-topic test suites off fixed real-time sleeps onto condition-polls and explicit timestamps, so those suites run fast and stop flaking on timing. Reviewed and confirmed sound.
files: packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts, packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts, packages/db-core/test/cohort-topic/coldstart.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-core/src/testing/async-wait.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts
----

# Summary

Migrated six cohort-topic spec files off fixed real-timer sleeps. Each `await delay(...)` that
waited for gossip delivery to flow through the fake node/mesh became a `waitFor(...)` on the
resulting observable state; five genuine absence/quiescence windows were retained as documented
bounded `delay` calls. No production source changed — `host.ts`/`cohort-gossip-driver.ts` were read
only to confirm the driver exposes no injectable clock, so condition-poll was the correct default.

Two distinct `waitFor` helpers are in play and the migration used each correctly:
- **Canonical** `@optimystic/db-core/test` → `async-wait.ts` `waitFor(pred, {timeoutMs, description})`,
  returns `Promise<void>`, **throws on timeout**. Used by `gossip-cadence` + `host-antidos-coldstart`
  (db-p2p) and by the db-core specs (imported from source `../../src/testing/async-wait.js`, not the
  package export, so a stale `dist` can't mask a source change).
- **Harness** `cohort-topic-mesh-harness.ts` `waitFor(pred, timeoutMs, intervalMs)`, returns
  `Promise<boolean>` (false on timeout). Used by `live-tier` + `scale-lifecycle` to match the existing
  in-file idiom; asserted via `expect(await waitFor(...), msg).to.equal(true)`.

# Review findings

**What was checked:** the full implement diff (commit `84058a1`) read first with fresh eyes; every
migrated `waitFor` for vacuity and semantic preservation; the retained absence windows for honesty;
both `waitFor` helper contracts (`async-wait.ts`, harness); import wiring (canonical vs harness vs
db-core source); completeness (no missed sleeps in any cohort-topic spec, both packages); lint; tests
run twice each for determinism.

**Correctness / preservation — clean.**
- Every migrated settle kept its original `expect(...)`; the `waitFor` guards propagation, the `expect`
  documents intent. No bare deletions.
- No vacuous polls: each convergence/eviction `waitFor` (`!holds`, `every !holds`) is preceded by a
  positive assertion that the record was first replicated (gossip-cadence 508/564, live-tier 255→261,
  scale-lifecycle 315→321), so "converged to absent" is meaningful, not immediately-true.
- The delicate freshness-gate test (`gossip-cadence` stale-eviction-reordered-after-re-registration)
  correctly anchors on `eB.records(TOPIC).some(r => r.lastPing >= t2)` — a genuine observable of R2
  landing before the reordered t1 eviction is delivered; canonical `waitFor` throws if R2 never lands,
  so it cannot pass vacuously. Synthetic t1→t2 advance left intact.
- Both `waitFor` variants used with the argument shape their signature expects (options object vs
  positional `timeoutMs`); confirmed against each helper's source.

**Absence windows — honest, not lazy (verified).** All 5 retained `delay` sites are genuine "nothing
should happen" windows a condition-poll cannot express, each with an inline rationale:
`gossip-cadence` 555 (stale eviction must not delete), 716 (no ticks after `stop()`), 762/808 (auth
gate must drop); `host-antidos-coldstart` 548 (rejected parent-link must stay `awaiting_parent`).
Sanctioned by the ticket. Confirmed no `setTimeout` remains anywhere in either package's cohort-topic
specs and no other `delay(...)` sleeps exist.

**Tests + lint — pass.**
- `db-p2p/test/cohort-topic/**`: 213 passing, 4 pending — deterministic across 2 runs (16s / 14s).
- `db-core/test/cohort-topic/**`: 426 passing (built `dist` first so the package `/test` export the
  db-p2p specs consume is fresh).
- `eslint` on all six touched files: clean.
- No pre-existing failures surfaced; no `tickets/.pre-existing-error.md` written.

**Minor — noted, no change (conditional/tripwire):**
- *Two-coord inbound routing isolation* (`gossip-cadence.spec.ts` ~404): the negative assertion
  `eB.holds(...) === false` is now anchored on coord A's merge rather than a fixed settle. Because
  both engine handlers are co-dispatched from one synchronous `deliverGossip` fan-out, A's merge
  completing is a good-enough proxy that B's (rejecting) handler has also run. It cannot pass wrongly
  today (B never sets the flag true), but a *future* regression where B wrongly merges and races
  slower than A could slip past. There is no clean B-side signal to anchor on (B rejects → no
  observable), so tightening isn't cleanly possible; the site already carries an inline comment
  explaining the co-dispatch assumption. Recorded here as a tripwire, not a ticket.

**Minor — pre-existing, out of scope:** `live-tier.spec.ts:37` imports `bytesEqual` but never uses it.
Not in the migration diff; `eslint` does not flag it. Left untouched.

**Deferred work — not a defect (index, not home):** the harness `waitFor` (boolean-returning,
`cohort-topic-mesh-harness.ts:64`) still has its own NOTE that downstream tickets replace each call
site with the canonical throw-on-timeout `waitFor` and eventually remove the boolean wrapper. This
ticket's scope was the *sleeps*, and the harness file is not a sleep site; using the existing harness
`waitFor` kept the diff minimal and matched in-file idiom. The harness-`waitFor`→canonical refactor
remains open, folded into the broader condition-poll sweep (tickets 5/6), not re-filed here.

**Major findings:** none — no new fix/plan/backlog tickets filed.
