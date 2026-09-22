description: `yarn release` returns as soon as `npm publish` has been called for every workspace, but the registry shows the new versions at different times. For 1.3.0, db-core and db-p2p appeared 30–90 s after the other packages, and a downstream upgrade script run in that gap picked up a mix of versions. The release should end by waiting until every published package's new version is visible, then print one clear line saying so.
files:
  - package.json (`release`, `pub` scripts)
  - scripts/ (new: a post-publish visibility check)
  - docs/releasing.md
----
# The release waits until every package is visible on npm

## Observed

Reported by sereus: after `yarn release` for 1.3.0, `@optimystic/db-core` and `@optimystic/db-p2p` reached the registry 30–90 s after the other packages. Sereus's maintainer ran their `upgrade:optimystic` inside that gap and got the new versions of some packages and the old versions of these two. `pub` is `yarn workspaces foreach -Apt --no-private npm publish --access public` — parallel and topological, so the publish order is already dependencies-first; the spread is registry visibility, not publish order, and a line printed after `pub` returns would still be premature.

## Design

- A new script (e.g. `scripts/await-published.mjs`) run as the last step of `release` (after `yarn pub`): list every non-private workspace and its `package.json` version (reuse whatever workspace listing the repo's other scripts already use; `yarn workspaces list --json` plus each manifest is enough), then poll the registry for each `name@version` until all are visible or a deadline passes.
  - Visibility check: `npm view <name>@<version> version` (honours the user's npm config and registry), with a short interval and an overall deadline (default about 10 minutes, overridable by env var).
  - Success: print one line — `all N packages published and visible on npm at <version>` — and exit 0.
  - Deadline: print which `name@version` are still missing and exit non-zero, so the release visibly did not finish.
- Also expose it as its own script (e.g. `yarn await-published`) so it can be re-run after a partial or interrupted publish.
- Keep it dependency-free (node built-ins plus the `npm`/`yarn` CLIs already required by `pub`), cross-platform (Windows included), and unit-test the pure parts (building the expected list, deciding done/missing from a map of answers) under `yarn test:harness` like the other release scripts, with the network call injected.
- `docs/releasing.md`: say that `yarn release` ends with this wait, what the final line means, and that downstream repos should upgrade only after it.
