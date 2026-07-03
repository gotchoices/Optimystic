description: Stray direct-to-terminal log calls in library code now route through each package's toggleable debug logger, and a fresh ESLint setup with a no-console rule catches new ones automatically.
prereq:
files: eslint.config.js, package.json, docs/debugging.md, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/src/logger.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/cohort-topic/coldstart.ts, packages/db-core/test/cohort-topic/coldstart.spec.ts, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/cluster-repo.ts
difficulty: medium
----

Implemented the logging + lint half of review finding eh-3 (docs/review.html §9). Two pieces:
(1) every stray `console.*` in library `src` now routes through the package's `debug` logger
(silent unless `DEBUG=optimystic:*` is set); (2) ESLint was stood up from nothing with a
`no-console` rule so regressions get caught, replacing the old do-nothing `lint` script.

## What landed (implement stage, commit 3e84c2e)

- 11 `console.*` call sites across 8 library files swapped to `createLogger(...)` loggers,
  severity intent preserved via `WARN:`/`ERROR:` message prefixes.
- New `quereus-plugin-optimystic/src/logger.ts` (base namespace `optimystic:quereus-plugin`),
  `@types/debug` devDep added there.
- `eslint.config.js` (flat, ESLint 9 + typescript-eslint) at repo root; root devDeps `eslint`,
  `typescript-eslint`, `@eslint/js`, `typescript`; root `lint` script → `eslint .`.
- CLI/entry/demo/test files left as `console.*` on purpose and explicitly exempted in the
  ESLint config (`no-console: off` override), not by omission.
- Scope deliberately narrow: `no-console` is the only enforced rule; the recommended presets
  are off to avoid flooding on pre-existing `any`/untyped globals. Documented in a SCOPE
  comment in `eslint.config.js`.

## Review findings

Adversarial pass over the implement diff (commit 3e84c2e). What was checked, found, and done:

- **Logger references resolve — CHECKED, clean.** Verified every swapped site binds to a real
  logger: `network-transactor` (module `log`), `coldstart` (new module `log`), `cluster-repo`
  (module `log = createLogger('cluster-member')`), `libp2p-key-network` (`this.log`),
  `restoration-coordinator-v2` (`this.log`), and all four quereus sites (module `log`). No
  dangling identifier; all three touched packages build clean (`build:db-core`, `build:db-p2p`,
  `build:quereus-optimystic` → exit 0).

- **printf format specifiers — CHECKED, clean.** Reviewed each swap that moved from string
  concatenation to `%s`/`%o`/`%d` placeholders (coldstart, network-transactor ×2, cluster-repo,
  libp2p-key-network, restoration, collection-factory shutdown, plugin). Arg order and
  specifiers match the values in every case.

- **`debug` runtime dependency — CHECKED, clean.** `quereus-plugin-optimystic/src/logger.ts`
  imports `debug`; confirmed `debug ^4.4.3` is a real `dependencies` entry (not just the new
  `@types/debug` devDep), and tsup does not externalize it — so it bundles rather than failing
  at runtime.

- **ESLint gate actually fires — CHECKED, clean.** `yarn lint` → exit 0. Proved the gate is not
  a no-op: a probe `console.log` in `packages/db-core/src/__probe__.ts` errored
  `no-console` (exit 1); probe removed. Exempt files (demo, reference-peer cli/mesh) lint clean
  despite their `console.*`. Re-grepped `packages/*/src` — only the three exempt files retain
  `console.*`.

- **MAJOR / test regression — FOUND and FIXED inline.** `db-core/test/cohort-topic/coldstart.spec.ts`
  ("keeps a forwarder holding parent-ops when parent registration fails") overrode
  `console.warn` and asserted exactly one warning fires when parent registration fails. The
  implement swap changed `coldstart.ts` from `console.warn(...)` to the silent `debug` logger,
  so the spy captured zero calls — a real failing test introduced by this diff (the implementer
  explicitly skipped running tests). Fixed the test to exercise the new mechanism: enable the
  `optimystic:db-core:cohort-topic:coldstart` namespace, capture `debug.log`, and assert the
  message is emitted. Restores state in `finally`. Verified: full db-core suite → 1136 passing.
  This was the only test asserting on a swapped console site (grepped every package's `test/`
  and `*.spec.ts` for console spies + the swapped message strings).

- **Docs out of date — FOUND and FIXED inline (minor).** `docs/debugging.md` documents the
  package→namespace map and per-package sub-namespaces, but the ticket introduced a new base
  namespace (`optimystic:quereus-plugin`) and a new db-core sub-namespace
  (`cohort-topic:coldstart`) without updating it. Added the `quereus-plugin-optimystic` package
  row, the `cohort-topic:coldstart` sub-namespace row, a `quereus-plugin sub-namespaces` table
  (`plugin`/`module`/`collection-factory`), and a quereus example in "Adding new loggers".

- **Tests run — CHECKED, all pass.** `yarn lint` exit 0; db-core 1136 passing; db-p2p 1103
  passing / 36 pending; quereus-plugin-optimystic 255 passing / 12 pending. Did NOT run
  reference-peer/demo/storage-*/substrate-simulator/quereus-crypto suites — those packages have
  no swapped source (the diff touches only db-core, db-p2p, quereus-plugin), so they are outside
  this change's blast radius.

- **Tripwires — noticed, left parked (not tickets).** Two conditional concerns are already
  recorded as `NOTE:` comments in `eslint.config.js` by the implementer, and are correct as
  tripwires: (a) broader lint is deferred — only `no-console` enforced, recommended presets off
  to avoid flooding on pre-existing `any`/globals; becomes work only if someone wants stricter
  linting (needs a `globals` block + an `any` cleanup pass first). (b)
  `reportUnusedDisableDirectives` is silenced so the dormant pre-existing
  `// eslint-disable @typescript-eslint/...` comments don't warn; re-enable when the recommended
  rules are turned on, else genuinely-unused directives will hide. No new tripwires added.

- **Namespace reuse vs. ticket suggestions — CHECKED, accepted.** Two sites (cluster-repo,
  restoration-coordinator-v2) reuse an existing logger in the file rather than a distinct new
  namespace the ticket named. Intentional (avoids two loggers per file); the reused namespaces
  are documented in `docs/debugging.md`. No change.

- **Historical review artifact — left as-is.** `docs/review.html` §9 eh-3 is the point-in-time
  assessment that spawned this ticket; not updated to mark "resolved" — it is an archived record,
  and the resolution is tracked in git history and this complete ticket.

### Disposition summary

No new tickets filed. One regression and one docs gap were minor/self-contained and fixed in
this pass; two tripwires were already correctly parked as code comments. No major follow-up
work identified.
