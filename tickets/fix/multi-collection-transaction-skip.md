----
description: A test that checks coordinating a single transaction across a table and its related index is switched off with no explanation, and it looks like it marks a real unfinished feature rather than a flaky test; investigate and either make it pass or clearly document why it is skipped.
prereq:
files: packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
difficulty: medium
----

Review finding eh-11, skipped-test portion (docs/review.html, Section 9 "Cross-cutting engineering health").

`distributed-transaction-validation.spec.ts:253` contains an unannotated `it.skip('should coordinate multi-collection transactions (table + index)', ...)`. The review notes that the project has twelve other skipped tests, all of which are exemplary — each annotated with a ticket reference explaining the documented expectation it is pinned to. This one is the lone exception: no annotation, and it appears to describe a genuine functional gap (committing a transaction that spans a table plus its index across nodes) rather than a deliberately-parked doc expectation.

Expected end state: understand why the test is skipped by enabling it and observing what fails. Then either:

- If the underlying multi-collection coordination works, fix whatever is stale in the test and re-enable it; or
- If it exposes a real unimplemented capability, annotate the skip with a reference to a tracking ticket (matching the convention the other twelve skips follow) and file/describe that follow-up so the gap is visible rather than silently disabled.

Do not simply delete the test.
