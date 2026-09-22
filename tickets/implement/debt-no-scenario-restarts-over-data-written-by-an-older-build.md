description: Nothing we run ever starts a node on a build newer than the build that wrote its data. Every suite writes and reads with one version, so an upgrade that changes what is stored, or how a stored record is read, can pass every gate and still break the first machine that restarts after updating.
files:
  - packages/db-p2p/test/ (no spec writes with one build and reads with another)
  - packages/db-p2p/src/storage/storage-repo.ts (`BlockMetadata`, `pendingBases`, `pendingClaimOf` — records written by beta.3 or earlier carry no stored base)
  - packages/db-p2p/src/cluster/cluster-repo.ts (the rival-record slot rule, which falls back for records with no stored base)
  - packages/db-core/src/transactor/ (`TransactorSource.transact` — success used to return `undefined` and now returns a truthy result)
  - docs/releasing.md (the release gate, which has no cross-version step)
difficulty: medium
repro: static
severity: wrong-result
likelihood: upgrade-only
tradeoffs: A real cross-version test has to keep an older build around — a published tarball, a second worktree, or a checked-in fixture of on-disk data — and every one of those costs maintenance and can rot into a test that passes because it no longer tests anything.

# No scenario restarts a node over data written by an older build

## Why this is filed

Raised while answering whether the two-member commit fix
(`1-a-two-member-cohort-refuses-a-commit-both-members-hold`, `e6ab12c6` + `30f04bd4`) is safe to
release. Our gate is strong within one version: `yarn check` builds, type-checks, lints and runs
every unit and integration suite, and sereus runs its own scenarios on top. **Every one of those
runs writes its data with the same build that reads it.** So the one thing an upgrade is most
likely to break is the one thing nothing exercises.

This is not hypothetical for this codebase. Two changes already shipped that a same-version suite
cannot see:

- **Stored pending records changed shape.** `PendRequest.baseRevs` and `BlockMetadata.pendingBases`
  were added in the pended-transform work. A record written by beta.3 or earlier has no stored base,
  and the rival-record rule has an explicit fallback for exactly that case. Nothing proves the
  fallback is reached, because no test ever produces a record without a base.
- **A return value's meaning flipped.** `TransactorSource.transact` used to resolve to `undefined`
  on success, so truthiness meant failure; it now resolves to a truthy `CommitSuccess`. In-repo
  callers were all updated, but a prebuilt caller compiled against the old contract reads success
  as failure at runtime, and types cannot catch that across a bundle.

## What to build

A scenario that writes with build A and reads with build B, where A is the previously released
version and B is the working tree. The shape that fits our harness best is probably:

1. Start a node from the published `@optimystic/*` packages at the last release, on a fixed data
   directory.
2. Write enough to cover the formats that changed: a collection with a log tail, a pending record
   left behind by a refused write, and a unique index.
3. Stop it, swap in the working tree's build against the same data directory, restart, and then
   **read back everything written in step 2** and write again on top of it.
4. Assert both directions, not just that the node starts: old data still reads, and new writes
   interleave with it.

A second, cheaper arm worth having either way: one machine on the old build and one on the new, in
a two-member cohort, writing concurrently. That is the mixed-fleet case the maintainer's
"upgrade every machine together" advice currently papers over, and it is where the `transact`
return-value flip would bite.

## Open questions for whoever picks this up

- Where does build A come from? Installing the published packages into a fixture project is the
  most honest, but it makes the suite need the network and pins it to whatever is on npm. A
  checked-in fixture of on-disk data is offline and fast, but it silently stops representing the
  old build the moment it is regenerated.
- Which data directory does this use? The node suites use `classic-level`; the RN app uses a
  different store. The formats are shared, so one level-backed scenario probably covers both, but
  that should be stated rather than assumed.
- Should the gate run it? It is slow and needs an older build, so it may belong in a
  pre-release step in `docs/releasing.md` rather than in `yarn check`.

## Note on scheduling

Filed at the maintainer's request while the release was going out, deliberately in `backlog` so no
runner picks it up mid-release. Promote it to `implement` once the release is done.

**Promoted 2026-09-21** after the 1.2.0 release, at the maintainer's standing request. Build A: the last published release (1.2.0 is on npm; 1.1.0 is also available if a pre-`cadcb919` writer is wanted to cover the one-round commit change). The pending-record shape change (`pendingBases`) predates both, so covering it needs a record with no stored base — a fixture or a writer older than beta.4 — and the ticket's open questions still stand for whoever implements.
