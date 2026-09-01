description: Three different test files each contain their own near-identical copy of the same small piece of test plumbing for capturing log output, so a fix or improvement to one of them does not reach the other two.
files:
  - packages/db-p2p/test/support/capture-log.ts (the fullest copy; namespace prefix hard-coded)
  - packages/db-core/test/collection.spec.ts (inline copy, `captureCollectionLog`, ~line 1355)
  - packages/db-core/test/cohort-topic/coldstart.spec.ts (inline copy, ~lines 106-127)
  - packages/db-core/src/testing/ (candidate shared home — published as the `@optimystic/db-core/test` subpath)
difficulty: easy
tradeoffs: It is roughly ten lines duplicated three times in test-only code that nothing ships, and the one real design question it raises (whether the shared home may depend on Node built-ins) costs more thought than the duplication currently costs — a maintainer could fairly leave it until a fourth copy appears.
----

# One log-capture helper, copied three times

## What is duplicated

Several suites assert on what the code writes to its `debug` log channels. Capturing that output
takes the same small dance every time: remember which channels are currently switched on, switch on
the one under test, replace `debug`'s output sink with an array collector, run the code, then put
all three back. Three files each carry their own copy of that dance:

- `packages/db-p2p/test/support/capture-log.ts` — the most developed copy. Exports `captureLog`
  plus assertion helpers (`hasTag`, `hasLine`, `formatCaptured`, `hasTagAtRev`). Its one
  non-reusable detail is that it prepends the fixed channel prefix `optimystic:db-p2p:` to the
  name it is given, so it cannot capture a db-core channel at all.
- `packages/db-core/test/collection.spec.ts` — an inline copy that returns already-formatted
  strings rather than raw argument lists.
- `packages/db-core/test/cohort-topic/coldstart.spec.ts` — an inline copy that returns raw argument
  lists.

They have already drifted in what they return, which is the cost: an improvement to one (say,
handling a channel name with a wildcard, or restoring correctly when the test body throws) reaches
neither of the others, and a reader cannot tell which copy is the good one.

## What "done" looks like

One helper, used by all three sites, that takes the channel name(s) to switch on rather than
assuming a package. The db-p2p-specific prefixing becomes a thin wrapper over it, so db-p2p's
existing call sites keep reading the way they do now.

## The one decision to make first

The natural shared home is `packages/db-core/src/testing/`, because db-p2p already depends on
db-core and that folder is published separately as the `@optimystic/db-core/test` entry point. But
everything under `packages/db-core/src/` today imports **zero** Node built-ins on purpose — db-core
is meant to run unchanged in browsers and React Native, and the storage packages for those targets
consume it. Two of the three copies reach for Node's `util.format` to turn a captured line into
text, because `debug` hands its sink an unsubstituted template (`rev=%d`) plus the values as
separate arguments.

That is avoidable rather than blocking: the shared helper can return the raw argument lists (as the
db-p2p and coldstart copies already do) and leave the formatting to whichever test actually needs
the text. Confirm that before writing it — if it turns out the shared helper genuinely needs
`node:util`, then whether the `@optimystic/db-core/test` subpath is allowed to depend on Node is a
question worth settling deliberately rather than in passing, since that subpath is published.

## Related shared-fixture work (backlog gardening, 2026-09-01)

`debt-transaction-spec-oversized` carries an arm with the identical shape one directory over: the
four-part `TransactionValidator` wiring is hand-copied at roughly fifteen sites inside
`packages/db-core/test/transaction.spec.ts` and again in two other db-core specs, and it proposes
lifting the copies into a shared `packages/db-core/test/helpers/` module.

The two were **not** merged — this one is a ten-line helper dedup, that one is a 5,150-line file
split, and they resolve at different sites. But they disagree about where db-core's shared test
plumbing should live: this ticket proposes `packages/db-core/src/testing/` (published as the
`@optimystic/db-core/test` subpath, which is why it raises the Node-built-ins question), and that one
proposes `packages/db-core/test/helpers/` (unpublished, so no such constraint). Whichever lands first
picks the home; the second should follow it rather than open a third location.
