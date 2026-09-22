description: `yarn release` now ends by waiting until npm serves every published package at its new version, and prints one line saying so, so downstream repositories know when it is safe to upgrade. Review the new wait script, its tests, and the release doc.
files:
  - scripts/await-published.mjs (new: the runner — lists workspaces, runs `npm view`, prints, sets the exit code)
  - scripts/published-visibility.mjs (new: the pure half — expected list, reading `npm view` answers, the polling loop, report text)
  - scripts/cli-command.mjs (new: the Windows cmd.exe route for `.cmd` shims, lifted out of libp2p-majors.mjs)
  - scripts/libp2p-majors.mjs (`yarnInfoCommand` now uses `cliCommand`; behaviour unchanged)
  - test-harness/published-visibility.test.mjs (new)
  - package.json (`release` gains `&& yarn await-published`; new `await-published` script)
  - docs/releasing.md
----
# The release waits until every package is visible on npm

## What was built

For 1.3.0, `@optimystic/db-core` and `@optimystic/db-p2p` reached the registry 30–90 s after the other packages, and sereus's upgrade run inside that gap picked up a mix of versions. `yarn release` is now `preflight && bump && pub && yarn await-published`.

`scripts/await-published.mjs`:

- Lists the workspaces with `yarn workspaces list --json --no-private` — the same `--no-private` filter `yarn pub` publishes under — and reads each one's `package.json` version.
- Asks `npm view --prefer-online --fetch-retries=0 --fetch-timeout=30000 --json <name>@<version> version` for every package, in parallel. Every 5 s after that it asks again, only about the packages not yet seen. The last round runs at the deadline.
- Success: prints `all N packages published and visible on npm at <version>` and exits 0 (several versions are listed comma-separated if the manifests ever disagree).
- Deadline (default 600 s, `OPTIMYSTIC_PUBLISH_WAIT_SECONDS` overrides it): lists each missing `name@version` with npm's last reason on stderr and exits 1.
- While waiting, it prints a line when the missing set (or a reason) changes, and at least every 30 s.
- Reading `npm view` output: the echoed version means visible. An `E404` error object means not yet, and npm gives that same answer for a version it doesn't list and for a package it has never seen, so a package's first release waits too. Exit 0 with empty output (older npm) also means not yet. Any other npm error means not visible and keeps npm's `code: summary` as the reason. Anything else (a different version, non-JSON) throws and aborts the wait instead of being read past.

## Validation done

- `yarn await-published` against the live registry (manifests at 1.3.0): printed `all 9 packages published and visible on npm at 1.3.0` in about 1.5 s, exit 0.
- Timeout path, using a scratch script with real `npm view` calls over `@optimystic/db-core@9.9.9` and a package that doesn't exist, with a 6 s deadline: progress lines, then both reported as `not on the registry yet`.
- Checked by hand that npm 11 prints an `ECONNREFUSED` JSON error object when the registry is unreachable. That output is the fixture in the test.
- `OPTIMYSTIC_PUBLISH_WAIT_SECONDS=abc` → clear error, exit 1. `--help` prints usage.
- `node scripts/check-libp2p-majors.mjs` still passes after the `cliCommand` refactor (on Windows, so through the cmd.exe route).
- `yarn test:harness` 65/65; `yarn lint`, `yarn lint:docs` clean. No package code changed, so the workspace suites were not re-run.

## Tests added (`test-harness/published-visibility.test.mjs`)

- `expectedPackages` pairs each listed workspace (real CRLF `yarn workspaces list` lines) with its manifest's version.
- `npmViewCommand` refuses a version containing a cmd.exe metacharacter (the safety property of the cmd.exe route; package names were already covered by the `yarnInfoCommand` test).
- `readViewAnswer`: the echoed version counts as visible; E404 and old-npm empty output both count as not yet; other errors keep npm's summary; output it doesn't understand throws.
- `waitForVisibility` over a fake clock: finishes once every package has been seen and asks again only about the unseen ones; at the deadline it gives up after one last round and names each straggler with its latest reason.

## Known gaps / for the reviewer

- **Full vs abbreviated metadata.** `npm view` reads the full packument. Installers usually read the abbreviated (`install-v1`) document, which the registry CDN caches separately, so a small window could remain after the success line. Parked as a `NOTE:` at `npmViewCommand`. Not measured.
- **A package seen once is never re-checked.** If different CDN edges answer differently, one could flip back to "not visible". I judged that unlikely enough not to spend a full re-check every round.
- **Windows probe backstop.** The 60 s `execFile` timeout kills cmd.exe but not the npm process under it, which keeps the pipe open. npm's own `--fetch-timeout=30000 --fetch-retries=0` is what actually bounds a call. The `NOTE:` is at `PROBE_TIMEOUT_MS`. The deadline can be overrun by at most one probe (≈30 s).
- **Docs cleanup beyond the ticket:** `docs/releasing.md` step 3 listed `yarn pub:db-core` / `pub:db-p2p` / `pub:quereus-crypto`, but no package.json defines those scripts, so I removed them. I also fixed "clean + build" to "build", because `pub` doesn't clean.
- Both `yarn workspaces list` and `npm view` run from the repository root (resolved from the script's own path), so the script gives the same answer from any directory, and `npm view` reads the root `.npmrc` if one exists. `npm publish` runs in each package's own directory, so a per-package `.npmrc` (none exists today) would not be read by the wait.
- The preflight prompt's text (`scripts/release-preflight.mjs`) was left alone; it describes what to check before a release, not what happens after publishing.
- Sereus has not been told; downstream guidance is in `docs/releasing.md` § When the release is finished.
