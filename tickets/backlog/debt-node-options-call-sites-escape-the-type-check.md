description: Some benchmark scripts and tests build a peer node by handing it a bag of settings that nothing checks, so renaming or reshaping a setting breaks them silently — nobody finds out until someone runs the script by hand months later. Make those call sites checked like the rest of the code.
files: packages/quereus-plugin-optimystic/test/offline-commit-cost.bench.mjs, packages/quereus-plugin-optimystic/test/repro-issue8.mjs, packages/db-p2p/test/bench-blob-transfer.mjs, packages/db-p2p/test/bench-findcluster.mjs, packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts, packages/upgrade-check/writer/write-scenario.mjs (the one that must stay unchecked), scripts/check-doc-citations.mjs (the guard-script pattern to copy)
difficulty: medium
tradeoffs: These are hand-run benchmarks and repro harnesses, not shipped code, so a maintainer may reasonably decide that a harness which breaks until the next person runs it is an acceptable cost — and the ten-odd test files involved would each need a real type instead of the cast they use today, which is churn across files nobody is otherwise touching.
----

# Building a node should not be possible without the settings being checked

## The problem this prevents

A peer node is built by one call, `createLibp2pNode`, which takes one object of settings. The shape of that object is declared in TypeScript, so in ordinary code a renamed or reshaped setting is a compile error and the person making the change is told immediately, at every site.

Two kinds of call site opt out of that:

- **Benchmark and repro scripts written in plain JavaScript** (`.mjs`), which the type checker does not look at at all. They exist because they are run by hand, one environment variable at a time, and nobody wanted a build step in the loop.
- **Tests that cast the settings object away** — they build the object and then tell the compiler to stop looking (`as any`), usually so they can merge in a few per-test overrides without declaring a type for them.

Both are invisible to `yarn typecheck`, and the scripts are invisible to `yarn test` as well, since nothing runs them. So a change to the node's settings leaves them broken with no signal at all.

**This is not hypothetical.** The change that gave a node one storage setting in place of three (`a-node-takes-all-its-storage-as-one-value`) broke four call sites that the compiler never saw:

- Two plain-JavaScript harnesses kept passing the old shape. Both would have crashed on startup — the node reads a part of the setting that no longer exists — and neither is run by any suite, so the breakage would have sat there until the next person reached for the benchmark.
- Two tests had cast their settings object away, so the compiler passed while the tests themselves crashed. These surfaced only because the review ran the package's whole suite; the implementing pass had run selected files and missed them.

The first two were the expensive ones: a benchmark that crashes the moment you need it is worse than no benchmark, because you only find out when you are already trying to measure something else.

Seven further test files use the same cast today. None of them happens to set the storage setting, so none of them broke this time. That is luck, not design.

## What resolving this should establish

Changing the node's settings should tell you about every call site in this repository, in one place, before anything is run.

Two arms, at the same root: a node's settings are declared once and should be checked everywhere they are written.

- **The hand-run scripts should be type-checked.** Whatever mechanism fits the repository — a type-check pragma plus a configuration that includes them, converting them to TypeScript, or a `scripts/check-*.mjs` guard in the family this repository already has (`check-doc-citations`, `check-libp2p-majors`, `check-undeclared-deps`) — the outcome is that `yarn typecheck` or a sibling `yarn lint:*` fails when one of them names a setting that no longer exists. These scripts need to stay runnable by hand against a built workspace with no build step of their own; a solution that takes that away is not a solution.
- **A test should not be able to cast its node settings away.** The replacement is a real type for the per-test overrides, which is what the two files fixed during the review now do. Whether to enforce that with a check or simply to convert the remaining files and leave it to review is worth deciding when the work is done.

## The one site that must stay unchecked

`packages/upgrade-check/writer/write-scenario.mjs` is deliberately plain JavaScript and must remain exempt. It is copied into a scratch directory holding a **published, older** build of the packages and run there, so it has to compile and run against settings this working tree no longer declares — it even probes at run time for which shape the resolved build understands. Type-checking it against the current declarations would be checking it against the wrong thing. Any guard this ticket adds needs an explicit, commented exemption for it, and the comment should say why rather than just listing the path.

## Things to get right

- **Name the failing site and the setting.** The value here is that the person changing a setting learns immediately; a check that merely says "a harness is broken" has given back most of that.
- **The exemption list is the risk.** One honest exemption with a stated reason is fine. A list that grows whenever the check is inconvenient turns this back into what it replaced.
- **Decide the scope deliberately.** The evidence is in `db-p2p` and `quereus-plugin-optimystic`. Whether other packages' harnesses join is a judgement to make while writing the rule, not an assumption to carry in from here.
