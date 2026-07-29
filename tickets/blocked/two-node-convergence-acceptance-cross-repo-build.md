----
description: Three separate bug fixes have now shipped to make a two-machine database heal itself, and none of them has been confirmed against the real end-to-end test — because that test lives in two other code repositories that need rebuilding first, which an automated agent is not allowed to do.
files: C:/projects/sereus/packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, C:/projects/sereus/packages/integration-tests/src/harness/build-freshness.ts
----

# Two-node convergence acceptance run needs a human to rebuild two sibling repos

## Why this is a human's call

The acceptance test for a run of fixes in this repo lives in a **different** repo (`sereus`), and
that repo refuses to run its integration tests until *its* compiled output — and a third repo's
(`quereus`) — is rebuilt. Rebuilding repositories this project does not own is outside what a ticket
agent should do unprompted: other agents may be mid-edit there, and a build writes files into a tree
nobody asked us to touch.

## What is unconfirmed

Three fixes have landed in `optimystic`, each one necessary and each one found only because the
previous fix turned out not to be sufficient:

1. `bug-member-commits-unmaterializable-revision` (`d6a22d2`) — a node that refuses a write it
   cannot apply now asks the cluster for what it is missing, instead of doing nothing.
2. `bug-reconcile-cannot-heal-two-node-cohort` (`07cb230`) — that repair no longer demands two
   independent peers vouch for the data when only one other machine exists.
3. `bug-read-repair-unrepairable-small-cluster` (`d31be12`) — the same relaxation on the read path,
   plus the shared rule extracted so the two paths cannot drift.

All three are covered by unit tests in `packages/db-p2p`, which pass. **None has been observed to
make two real nodes actually converge.** Each of the last two was filed because the one before it
was assumed sufficient and was not.

## What to run

From a shell where building sibling repos is acceptable:

```
cd C:/projects/quereus && yarn workspace @quereus/quereus build
cd C:/projects/sereus  && yarn workspace @serfab/cadre-core build
cd C:/projects/optimystic && yarn build
cd C:/projects/sereus/packages/integration-tests
npx vitest run src/scenarios/control-db-two-node-convergence.integration.ts
```

The freshness guard that blocks the run is `sereus/packages/integration-tests/src/harness/build-freshness.ts`.

## What the outcome means

- **Passes** — the chain of three fixes is confirmed; close this and record it against them.
- **Fails** — the mechanism fixed in this repo was necessary but still not sufficient, and the next
  cause is somewhere else again. File the new failure as a fresh `fix/` ticket with the scenario
  output attached; do not assume it is a fourth variation of the same quorum problem.
