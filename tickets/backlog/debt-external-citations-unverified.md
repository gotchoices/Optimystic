description: The tool that checks whether our documentation still points at real code skips every reference to files in a neighbouring project, so those references can go stale without anyone noticing — and two already had.
files: scripts/check-doc-citations.mjs, docs/transactions.md, AGENTS.md, package.json
difficulty: medium
tradeoffs: Verifying files in a neighbouring project only works when a developer happens to have that project checked out next to this one, so the check would either be skipped on most machines (silent again, just louder about it) or fail for people who have no reason to clone it — a maintainer may reasonably decide a bare warning count, or nothing at all, is the better trade.

# External file references are never checked

## The gap

`yarn lint:docs` verifies that a path named in prose exists in this repository. It deliberately
skips any path beginning with a package scope, e.g. `@quereus/quereus/src/parser/parser.ts`,
because those files live in the Quereus project, not this one. The convention in `AGENTS.md`
*requires* that prefix on external files, so the very marking that makes a citation honest is also
what exempts it from checking.

The result is a blind spot with the same failure mode the citation checker was built to close: the
reference looks precise and authoritative, and rots without a signal.

## Evidence this is not hypothetical

During the review of `debt-doc-code-citations-rot-silently`, `docs/transactions.md` was found citing
two Quereus files that do not exist:

- *src/vtab/context.ts*
- *src/execution/executor.ts*

Neither is present in the Quereus checkout this repository links against, and the
`VirtualTableContext` type they were said to carry is not declared anywhere in it. The document was
corrected by hand; `yarn lint:docs` reported nothing before or after, because both paths carried the
`@quereus/quereus/` prefix.

`packages/db-p2p/readme.md` also references `p2p-fret`, a second external project, though as a name
rather than a path.

## What "solved" looks like

The point is not to make external references pass or fail — it is to stop them from being
*silently* unexamined. Any of these would count as an improvement, in rough order of ambition:

1. **Report the skip.** The summary line already counts citations, mentions and links; have it also
   say how many external references went unverified, and where. A number that a reader can see is
   already better than a silence.
2. **Verify when the neighbour is present.** This repository's root `package.json` already resolves
   Quereus and FRET to sibling checkouts (`portal:` entries, plus the `dev:link` script). When such
   a checkout resolves on the machine running the check, the external path can be verified the same
   way a local one is; when it does not, fall back to (1).
3. **Pin what is expected.** Record which external projects the docs are allowed to cite, so a typo
   in the prefix itself (a project we do not depend on at all) is a finding regardless of what is
   checked out.

Option 2 is the only one that actually catches rot, and it is the one that depends on a developer's
local layout — see `tradeoffs:` above. Deciding how loud the fallback should be is the substance of
this ticket.

## Non-goals

- Cloning or fetching a neighbouring project to run a lint check.
- Making `yarn check` fail on a machine that has no reason to have Quereus checked out.
