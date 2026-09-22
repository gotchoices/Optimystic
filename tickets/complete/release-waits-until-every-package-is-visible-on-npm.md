description: `yarn release` now ends by waiting until npm serves every published package at its new version, and prints one line saying so, so downstream repositories know when it is safe to upgrade.
files:
  - scripts/await-published.mjs
  - scripts/published-visibility.mjs
  - scripts/cli-command.mjs
  - scripts/libp2p-majors.mjs
  - test-harness/published-visibility.test.mjs
  - package.json
  - docs/releasing.md
----
# The release waits until every package is visible on npm

## What was built

For 1.3.0, `@optimystic/db-core` and `@optimystic/db-p2p` reached the registry 30–90 s after the other packages, and a downstream upgrade inside that gap picked up a mix of versions. `yarn release` is now `preflight && bump && pub && yarn await-published`.

`scripts/await-published.mjs` lists the public workspaces (`yarn workspaces list --json --no-private`, the same filter `yarn pub` publishes under), reads each manifest's version, and asks `npm view --prefer-online --fetch-retries=0 --fetch-timeout=30000 --json <name>@<version> version` for each, re-asking every 5 s only about packages not yet seen, until all are visible (prints `all N packages published and visible on npm at <version>`, exit 0) or the deadline passes (default 600 s, `OPTIMYSTIC_PUBLISH_WAIT_SECONDS`; lists each missing package with npm's reason, exit 1). The pure logic lives in `scripts/published-visibility.mjs`; the Windows cmd.exe route for `.cmd` shims was lifted out of `scripts/libp2p-majors.mjs` into `scripts/cli-command.mjs` and is shared. `docs/releasing.md` gained § When the release is finished and tells maintainers to upgrade downstream only after the success line.

## Review findings

Checked: the implement diff in full (runner, pure half, shared CLI helper, `yarn info` refactor, tests, package.json, releasing doc); the polling loop's deadline arithmetic (last round runs exactly at the deadline, sleep never negative); `npm view` answer reading across visible / E404 / old-npm empty output / other npm errors / unrecognised output; command-start and timeout handling in `run`; that the listing filter matches `yarn pub`'s; cmd.exe argument safety (names and versions validated before building the command); docs for stale references.

- **Fixed (minor):** an empty workspace listing would have printed the release-finished line (`all 0 packages … at `) immediately. `expectedPackages` now throws when no public workspace is listed. No test added — a one-line guard with no branching worth pinning.
- **Tripwires already parked by the implementer, left as is:** full vs abbreviated (`install-v1`) registry metadata may briefly disagree (`NOTE:` at `npmViewCommand`); on Windows the 60 s probe backstop kills cmd.exe but not npm, so npm's own fetch timeout is the real bound (`NOTE:` at `PROBE_TIMEOUT_MS`). Both are genuinely conditional; no ticket.
- **Considered, no action:** a package seen once is never re-checked, so inconsistent CDN edges could in principle flip it back — speculative, the cost of re-checking every round is not justified without an observed case. A per-package `.npmrc` would not be read by the wait (it runs from the root) — none exists today.
- **Tests:** the five added tests each pin a branch of real logic (listing/manifest pairing, cmd.exe safety of the version check, each class of `npm view` answer, the fake-clock loop's resend and deadline behaviour); none restate wiring or mock repo-owned modules. Kept all, added none.
- **Docs:** `docs/releasing.md` reflects the new step, the checklist, and the ordering relative to `write-fixture`; the removed `yarn pub:*` scripts were confirmed absent from every package.json. No other doc references the release flow's tail.
- **Major findings:** none — nothing warranted a ticket.

Validation: `yarn test:harness` 65/65, `yarn lint` and `yarn lint:docs` clean, `node scripts/check-libp2p-majors.mjs` passes (Windows, cmd.exe route), `node scripts/await-published.mjs` against the live registry printed `all 9 packages published and visible on npm at 1.3.0`.
