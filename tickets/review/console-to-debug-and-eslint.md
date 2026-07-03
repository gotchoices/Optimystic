----
description: Stray direct-to-terminal log calls in library code now go through each package's toggleable debug logger, and a fresh ESLint setup with a no-console rule catches any new ones automatically.
prereq:
files: eslint.config.js, package.json, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/src/logger.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/cohort-topic/coldstart.ts, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cluster/cluster-repo.ts
difficulty: medium
----

Implements the logging + lint half of review finding eh-3 (docs/review.html §9). Two pieces landed together: (1) every stray `console.*` in library `src` now routes through the package's `debug` logger (silent unless `DEBUG=optimystic:*` is set); (2) ESLint was stood up from nothing with a `no-console` rule so regressions get caught, replacing the old do-nothing `lint` script.

## What changed

### Library console → debug sweep (11 call sites, 8 files)

Each site now uses a `createLogger(...)` from the package's `logger.ts`. Severity intent preserved by prefixing the message string with `WARN:`/`ERROR:` where the original was a warn/error (`debug` has no levels). No log was swallowed — every catch that previously printed still logs (visible when the namespace is enabled).

- `db-core/src/transactor/network-transactor.ts:455,561` — reused the file's existing module `log` (`createLogger('network-transactor')`).
- `db-core/src/cohort-topic/coldstart.ts:210` — added `import { createLogger }` + module-level `log = createLogger('cohort-topic:coldstart')`.
- `db-p2p/src/storage/restoration-coordinator-v2.ts:188` — reused the class's existing `this.log` (`createLogger('storage:restoration')`). **Note:** the ticket suggested adding a new `createLogger('restoration-coordinator')`, but the class already had a `this.log` member — reused it instead of adding a duplicate (a first attempt that added one produced a "Duplicate identifier 'log'" compile error, now resolved).
- `db-p2p/src/libp2p-key-network.ts:551` — reused existing `this.log`.
- `db-p2p/src/cluster/cluster-repo.ts:1229` — reused the file's existing module `log` (`createLogger('cluster-member')`). Ticket suggested `'cluster-repo'`; reused the existing logger rather than adding a second namespace to the same file.
- `quereus-plugin-optimystic/src/plugin.ts:21` — new package logger, `createLogger('plugin')`. The pre-existing `if (config.debug)` guard was kept (behavior-preserving).
- `quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:125,437` — module-level `createLogger('collection-factory')`.
- `quereus-plugin-optimystic/src/optimystic-module.ts:307,327,334,356` — module-level `createLogger('module')`.

New file: `quereus-plugin-optimystic/src/logger.ts` — mirrors db-core's pattern, `BASE_NAMESPACE = 'optimystic:quereus-plugin'`. Kept minimal (no `verbose` export — no call site needed it). Added `@types/debug` devDep to that package.

### Exempt (left as `console.*` on purpose)

CLI / entry / demo files — their job is terminal output. Left untouched **and** explicitly exempted in the ESLint config (`no-console: off` override), not by omission:
`reference-peer/src/cli.ts`, `reference-peer/src/mesh.ts`, `demo/src/**`, `scripts/**`, `**/test/**`, `**/*.spec.ts`.

### ESLint (new)

`eslint.config.js` at repo root (flat config, ESLint 9 + `typescript-eslint`). Root devDeps added: `eslint`, `typescript-eslint`, `@eslint/js`, **and `typescript`** (the parser peer-depends on it and root had none — without it `eslint .` crashes with "Cannot find module 'typescript'"). Root `lint` script is now `eslint .`.

**Scope is deliberately narrow: `no-console` is the only enforced rule.** The recommended `typescript-eslint`/`@eslint/js` presets are NOT enabled — this codebase leans on `any` and untyped globals, so `recommended` would flood lint red with unrelated violations and mask the gate. This is the ticket's sanctioned fallback; documented in a SCOPE comment in `eslint.config.js`.

## Validation performed

- `yarn lint` → **exit 0** (clean, no warnings).
- Gate proven to fire: linting a stdin snippet with a `console.log` mapped to `packages/db-core/src/__probe__.ts` → `error no-console`. Same snippet mapped to `packages/reference-peer/src/cli.ts` (exempt) → no error.
- Re-grep `console\.` under `packages/**/src/**/*.ts` → only the three exempt files (cli.ts, mesh.ts, demo/run.ts) remain. No `console.*` in library `.js` sources (grepped, zero matches).
- `yarn build:db-core`, `yarn build:db-p2p`, `yarn build:quereus-optimystic` → all exit 0. The new `logger.ts` is bundled by tsup (imported from the plugin entry points) and the DTS build resolves `@types/debug`.
- Did NOT run `yarn test` — the swaps are behavior-preserving (silent-by-default) and the ticket calls build+lint the meaningful gate.

## For the reviewer — where to look / known gaps

- **Test floor, not ceiling:** no runtime test exercises the logger output. The build proves it compiles; it does not prove a message actually renders under `DEBUG=optimystic:*`. If you want belt-and-suspenders, run any package with `DEBUG=optimystic:*` set and trigger one of the swapped paths (e.g. a failed cluster propagate) to eyeball output.
- **printf-style format strings:** several swaps changed string concatenation to `debug`'s `%s`/`%o`/`%d` placeholders (e.g. `log('WARN: invalid multiaddr from connection %s %o', a, err)`). Worth a glance that arg order and specifiers match the values — a wrong specifier degrades the message but won't throw.
- **Namespace reuse vs. ticket suggestions:** two sites (cluster-repo, restoration-coordinator-v2) reuse an existing logger in the file rather than the new namespace the ticket named. Intentional — avoids two loggers per file. Flag if you'd rather have the distinct namespaces.
- **Pre-existing surprise:** the tree already carried speculative `// eslint-disable @typescript-eslint/...` comments (in `db-core/src/utility/nameof.ts` and several `db-p2p`/`quereus` spec files) even though ESLint never existed. These reference rules our narrow config doesn't enable, which made ESLint hard-error ("Definition for rule ... was not found"). Handled by registering the `@typescript-eslint` plugin (rule names resolve, all rules stay off) and setting `reportUnusedDisableDirectives: 'off'`. Both documented inline in `eslint.config.js`.

## Review findings (tripwires noticed, parked — not tickets)

- **Broader lint deferred (tripwire).** Only `no-console` is enforced; `typescript-eslint recommended` is off to avoid flooding on pre-existing `any`/globals. Parked as a SCOPE `NOTE:` comment in `eslint.config.js` (with the concrete follow-up: add a `globals` block + clean up `any`/no-undef, then turn the presets on). Fine now; becomes work only if someone wants stricter linting.
- **`reportUnusedDisableDirectives` silenced (tripwire).** Turned off so the dormant pre-existing disable comments don't warn. Parked as a `NOTE:` in `eslint.config.js`. Re-enable when the recommended rules are turned on, else genuinely-unused directives will hide.
- **LSP-only diagnostics during edit** (`Cannot find name 'setTimeout'/'TextEncoder'/'NodeJS'`) in db-p2p files were the editor language server not loading node types; `tsc`/`tsup` builds are clean. Not a code issue — no action.
