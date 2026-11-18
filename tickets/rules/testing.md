# Which tests each stage runs

A package's full suite takes minutes (db-p2p and the Quereus plugin each run for several), so it is run once per ticket, in review, and nowhere else. This overrides the generic "ensure build and tests pass" and "run tests during implement" wording in the ticket workflow rules.

<!-- stage:fix -->
Run only what reproduces the bug: the one spec file, or `yarn test -- --grep "<pattern>"`, in the package that owns it. No full package suite, no `yarn test:integration`, no `yarn check:rn`, no `yarn check`.
<!-- /stage -->

<!-- stage:plan -->
Run no tests. Reading code and specs is enough to plan. If you need to confirm a behaviour, run one spec file at most.
<!-- /stage -->

<!-- stage:implement -->
Build the packages you changed (`yarn build` in each, then `yarn typecheck` from the root when `quereus-plugin-optimystic` or `quereus-plugin-crypto` changed). Run only the spec files you added or changed, and the specs that cover the code you changed, by file (`node --import ./register.mjs node_modules/mocha/bin/mocha.js test/<file>.spec.ts`) or by `--grep`. Run `yarn lint:docs` when you changed docs, and `yarn lint:deps` when you changed a manifest or added an import.

Do **not** run a package's full `yarn test`, `yarn test:integration`, `yarn check:rn` or `yarn check`; review runs the full suites. In the handoff, list the commands you ran.
<!-- /stage -->

<!-- stage:review -->
Run the full suites once, after your own fixes are in: `yarn test` in every package the change touches and in every package that depends on one of them (db-core changes reach db-p2p and quereus-plugin-optimystic; db-p2p changes reach quereus-plugin-optimystic), and `yarn lint`. Add `yarn test:integration` when the change touches networking, cohort assembly, reactivity or matchmaking, and `yarn check:rn` when it adds or changes imports in code that ships to React Native. Before then, iterate on individual spec files or `--grep`; do not run a full suite twice.
<!-- /stage -->
