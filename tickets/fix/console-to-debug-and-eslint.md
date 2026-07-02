----
description: Library code writes directly to the console in about sixteen places instead of using the proper logger, and the project's lint command does nothing, so this kind of stray output and other issues never get caught automatically.
prereq:
files: package.json, packages/db-p2p/src, packages/quereus-plugin-optimystic/src, packages/reference-peer/src
difficulty: medium
----

Review finding eh-3, logging portion (docs/review.html, Section 9 "Cross-cutting engineering health").

About sixteen stray `console.*` calls sit in library code — the review names `network-transactor`, `cluster-repo`, `restoration-coordinator-v2`, `libp2p-key-network`, and `optimystic-module` among the offenders. Library code should route diagnostic output through the per-package `debug` logger so consumers can enable/disable it, not print unconditionally to the console.

Separately, the root `lint` script is a stub: `"echo 'Lint not configured for all packages'"`. Because lint is a no-op, regressions like new stray `console.*` calls are never caught.

Expected end state:

- Sweep the stray `console.*` calls in library `src` to the appropriate per-package `debug` logger. Legitimate CLI/entry-point user-facing output (for example in a command-line tool that is meant to print to the terminal) should stay, but be exempted explicitly rather than by accident.
- Configure ESLint across the packages with a `no-console` rule, with targeted overrides where console output is genuinely intended (CLI binaries, scripts). Replace the stub root `lint` script with one that actually runs ESLint across the workspace so `no-console` (and future rules) gate in CI.
