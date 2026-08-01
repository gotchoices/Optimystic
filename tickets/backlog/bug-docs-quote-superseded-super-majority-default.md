----
description: The written docs say two-thirds of a peer group must agree before a change is accepted, but the code was changed some time ago to require three-quarters. One document uses the old number to work out a safety margin, and gets an answer far tighter than reality.
files: docs/correctness.md, docs/right-is-right.md, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts, packages/db-core/src/cluster/structs.ts
difficulty: easy
repro: verified
----

# Prose still quotes the pre-unification super-majority default

## What is wrong

`DEFAULT_SUPER_MAJORITY_THRESHOLD` (`packages/db-core/src/cluster/structs.ts:58`) is `0.75`. The
composition root applies it with no override (`resolveClusterPolicy` in
`packages/db-p2p/src/cluster/cluster-policy.ts`), so an unconfigured node — including a
reference-peer started without `--super-majority-threshold` — runs at `0.75`.

Several documents still state the default is `0.67`. That was true before ticket
`6.2-implement-supermajority-threshold-coupling` collapsed three drifting defaults (member `1.0`,
coordinator `0.75`, node composition root `0.67`) onto the one shared constant. The prose was not
swept afterwards.

Verified by reading the constant and each quoted site, not inferred.

## Why it matters

Most of the sites are merely a wrong number in an explanation. One is not.

`docs/correctness.md` (Theorem 2 status note) derives the partition-safety condition
`2 · membershipAdmissionFraction · superMajorityThreshold > 1` and evaluates it as
`2 · 0.75 · 0.67 = 1.005`, describing the result as "true, but with almost no margin", and instructs
the reader to "re-derive this product before changing either" default. With the actual `0.75` the
product is `2 · 0.75 · 0.75 = 1.125`. The safety property still holds — the document *understates*
the margin — but a reader making a change to either default is budgeting against a figure that is
wrong, and the document's own instruction to re-derive was not followed when the default moved.

The same note in code — `packages/db-p2p/src/cluster/cluster-repo.ts:993` — repeats the `1.005`
figure.

## Sites

| File | What it says |
| --- | --- |
| `docs/correctness.md` (5 places: implementation-status notice, §1.5 status, Theorem 1 Case 3, Theorem 2, Theorem 10) | `superMajorityThreshold = 0.67`, and the `1.005` product above |
| `packages/db-p2p/src/cluster/cluster-repo.ts:993` | the `1.005` product in a `NOTE:` comment |
| `docs/right-is-right.md:142` | "configurable `superMajorityThreshold` (default: 0.67)" |
| `packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts:12` | comment calls `0.67` "the default"; the spec's own `0.67` cases are deliberate overrides and are correct as tests |

The same drift in `packages/reference-peer/src/cli.ts` (`--super-majority-threshold` help text) and
`packages/reference-peer/README.md` was already corrected during review of
`corroboration-floor-defaults-to-two-for-large-meshes`; those two need no further work.

`docs/correctness.md` also cites `libp2p-node-base.ts:605` as the resolution site five times. That
line number is stale twice over — the defaults now live in `packages/db-p2p/src/cluster/cluster-policy.ts`.
Worth correcting in the same pass, and worth citing the file and symbol rather than a line number so
it cannot rot again.

## Expected outcome

Every prose statement of the default names the value the code actually resolves, the partition-safety
product is re-derived at that value, and code references point at `resolveClusterPolicy` rather than
a line number. Tests that deliberately pass `0.67` keep doing so; only their "this is the default"
comments change. No behaviour change — this is a documentation correction, and the threshold itself
is not up for revision here.

Found during review of `corroboration-floor-defaults-to-two-for-large-meshes`; not caused by it.
