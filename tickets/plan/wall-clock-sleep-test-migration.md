----
description: The test suite waits on real wall-clock timers in dozens of places, some of them several seconds long, which makes the suite slow and prone to intermittent failures; plan a migration to the deterministic fake-clock approach already proven elsewhere in the project.
prereq:
files: packages/db-p2p/test/cluster-coordinator.spec.ts, packages/db-p2p/test/cohort-topic
difficulty: hard
----

Review finding eh-3, test-determinism portion (docs/review.html, Section 9 "Cross-cutting engineering health").

There are roughly 70 wall-clock sleep sites across 29 test files; only about six suites use virtual clocks. The worst offenders are 2.5-4.5 second sleeps in `cluster-coordinator.spec.ts`. Real-time sleeps make the suite slow and flaky: they either waste time (padded to be safe) or fail intermittently under load (too tight).

Expected end state: wall-clock sleeps are replaced with either the fake-clock pattern already proven in the cohort-topic scale suites, or condition-polling helpers (wait-until-predicate with a bounded timeout) where a fake clock does not fit. The plan should inventory the 29 files, group them by which mechanism suits each (fake clock vs condition polling), pick a canonical helper/pattern for each mechanism, and sequence the migration so it can be done in coherent batches rather than one giant change.

## Edge cases & interactions

- Some sleeps mask genuine asynchronous settling (gossip propagation, cluster convergence); replacing them with a fake clock requires that all timers in the code under test are driven by an injectable clock, otherwise advancing fake time will not advance the real timers and the test will hang or pass vacuously. The plan must identify which subsystems already accept an injectable clock and which need one threaded through first (and whether that is in scope or a prerequisite).
- Condition-polling helpers must have a bounded timeout so a genuinely broken condition fails the test instead of hanging until the runner's idle timeout kills the whole run.
- Migrating a suite must not weaken what it asserts — a sleep that was there to let an event propagate should become an explicit wait for that event/state, not just a removal.
- Batch the migration so each ticket is one agent run; a single change across all 29 files is too large and risks masking regressions.
- Verify migrated suites still pass deterministically across repeated runs (the whole point), not just once.
