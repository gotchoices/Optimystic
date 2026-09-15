description: When a cohort tells a registering peer "ask this other member instead" and that member can't be reached, the whole registration attempt fails immediately instead of trying another named member or backing off, even though the design says a failed direct dial should fall back.
files: packages/db-core/src/cohort-topic/walk.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/test/cohort-topic/walk.spec.ts, packages/db-p2p/src/cohort-topic/topic-router.ts
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The rejection already surfaces to the caller of `register`, whose own retry policy restarts the walk, so this costs one extra full walk rather than correctness; a maintainer may prefer that simplicity over adding per-candidate fallback inside the walk.
----
# The register walk's direct member dial has no failure handling

## What happens

The cohort-topic register walk (`WalkEngine.register` in `packages/db-core/src/cohort-topic/walk.ts`) normally routes each attempt through the ring (`router.routeAndAct`). When a cohort replies `unwilling_member` with a list of alternative members, the walk retries the same coordinate by dialing one named member directly (`router.dialMember`, around line 206).

That call is awaited with no `try`/`catch`. If the named member is unreachable (a dial failure), or replies with nothing (db-p2p's `FretTopicRouter.dialMember` rejects with `NoResultReplyError`), the rejection propagates straight out of `walk.register`, and so out of `CohortTopicService.register` / `lookup` and the renewal `relookup`. The walk never tries the next candidate the cohort named, never falls back to routing, and never returns its usual `retry_later` back-off outcome.

## Why it looks unintended

The port's own contract, `ITopicRouter.dialMember` in `packages/db-core/src/cohort-topic/ports.ts`, says: "Direct dial to a cached primary; falls back to `routeAndAct` on failure (caller decides)." The walk is that caller, and it makes no decision. Renewal, the other `dialMember` caller, does handle it: `RenewalParticipant.trySend` counts a rejection as a failed ping.

No db-core walk test makes `dialMember` reject, so the current behaviour is unpinned.

The same class of problem ("one member failing ends a multi-candidate walk") was just fixed for reactivity recovery in `debt-stream-reply-no-result-untyped`. This is the remaining instance found during that review.

## Expected behaviour

A direct-dial rejection on an `unwilling_member` retry should be treated like that member declining: try the next untried candidate (the walk already tracks `triedMembers`), or fall back to routing / `retry_later` once candidates are exhausted. It should not reject out of `register`.

A walk test should cover a rejecting `dialMember`, both with another candidate available and with none.

To confirm the report: add a walk.spec router whose `dialMember` throws, drive an `unwilling_member` reply with two candidates, and observe that `register` rejects instead of dialing the second candidate.
