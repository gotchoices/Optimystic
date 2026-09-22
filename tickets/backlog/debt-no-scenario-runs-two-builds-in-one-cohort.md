description: Nothing runs an older published build and the current build at the same time, as two machines sharing the same data — the state a network is in partway through an upgrade. A change in how two builds talk to each other only shows up there, and every suite today runs one build.
files:
  - packages/upgrade-check/scripts/write-fixture.mjs (`installPublishedBuild` and `verifyInstalledBuild` already install and check an exact published build in a scratch directory)
  - packages/upgrade-check/writer/write-scenario.mjs (how a published build is driven today: one solo node, then exit)
  - packages/upgrade-check/test/current-build.ts (how the current build is started over the same kind of node)
  - docs/releasing.md (where a pre-release step would be listed)
  - tickets/backlog/debt-mixed-version-identify-incompatibility.md (a shipped instance of the class this would catch)
tradeoffs: The maintainer's standing advice is to upgrade every machine together, and a scenario like this needs a published build installed from npm at run time and a second process on real sockets, so it can only be a slow manual pre-release step that may never earn its keep if every deployment does upgrade together.
----
# No scenario runs two builds in one cohort

Split off from `debt-no-scenario-restarts-over-data-written-by-an-older-build`, which built the restart half: `packages/upgrade-check` starts the current build over data a published build wrote. That covers what is *stored*. It says nothing about what is *sent*: every node in every suite, that one included, runs one build, so the protocol between two different builds is never exercised.

## Why it matters

A network upgrades one machine at a time unless its operator coordinates otherwise, so for some period an old node and a new node share a cohort, pend and commit to each other, answer each other's reads and repair each other's blocks. Messages are plain JSON with optional fields, so many changes are compatible by construction (an older peer ignores a field it does not know; a newer one reads an absent field as the old default — `isConflictFailure` in `packages/db-core/src/network/stale-failure.ts` is written for exactly that). Others are not, and nothing tells them apart before a user's network finds out:

- `debt-mixed-version-identify-incompatibility` — nodes on either side of `849fd94` cannot complete libp2p's identify handshake, so each sees the other as connected but ineligible for work. Found by reading code, not by a test.
- Anything signed. A promise or commit vote's signing payload is a byte layout (`ClusterMember.signVote`); a build that changes it gets its votes rejected by every older member.

One thing the original ticket placed here does not belong here: the change of `TransactorSource.transact` from resolving `undefined` on success to resolving a `CommitResult`. Its only caller is `Collection`, inside `db-core`, so two processes each run a consistent pair and never see each other's. The risk it names — an older package calling a newer one *in one process* — is an install question, recorded as a note under "Version alignment" in `docs/releasing.md`.

## What to build

A scenario with an older published build and the current build as two members of one two-member cohort, on loopback TCP:

- Install the published build into a scratch directory the way `write-fixture` does, and start it as a child process that runs one node (`clusterSize: 2`) and takes commands — write a row, append to a diary, read everything back — over its standard input and output.
- Start the current build's node in the test process, bootstrapped to the child, and wait until each node's cohort for a block includes the other.
- Have both write concurrently: rows into one table with a `unique` column, and appends to one diary.
- Assert both directions: each node reads the other's committed writes, both indexes agree with the table on both nodes (the plugin's `verifyIndexes`), and a duplicate of a unique value written on one node is refused on the other.
- Stop both, restart each over its own data on the same build, and read everything back again.

It cannot run in `yarn test` or `yarn check`: it needs the network to install the older build, and a two-member cohort over real sockets is slow to assemble. It belongs in `docs/releasing.md` as a step run before a release, against the previous release.

## Open questions

- Which older version: only the last release, or every release someone might still be running? Each is a separate install and run.
- What the answer should be when it fails. A release may deliberately break the protocol ("Don't worry about backwards compatibility yet", AGENTS.md); then the useful output is a release note saying machines must upgrade together, not a red gate. The step should say which of the two it is looking for.
