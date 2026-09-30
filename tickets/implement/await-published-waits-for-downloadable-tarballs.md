description: The release step that waits for new packages to appear on npm can finish while a package's download file is still missing, so an install run right after it can fail; make it count a package as published only once its download file can actually be fetched.
architecture: docs/releasing.md#when-the-release-is-finished
files: scripts/published-visibility.mjs, scripts/await-published.mjs, test-harness/published-visibility.test.mjs, docs/releasing.md
repro: static
----
# `yarn await-published` must also wait for each package's tarball

## The defect

`yarn await-published` (`scripts/await-published.mjs`, logic in `scripts/published-visibility.mjs`) counts a package as published when `npm view --json <name>@<version> version` echoes the version back. That reads the registry's metadata document for the package. The file `npm install` actually downloads — the tarball at `dist.tarball`, `https://registry.npmjs.org/<name>/-/<pkg>-<version>.tgz` — is served separately and becomes available at its own moment.

Observed on sereus 1.8.0 (2026-09-30), which ported this step from optimystic: by 18:40 UTC the version metadata answered 200 for all seven packages, while three tarballs still answered 404 several minutes later. A wait built on metadata alone would have printed the "all packages published" line while `npm install` of the release failed. Optimystic 1.8.0 did not hit it (every tarball answered 200 when checked afterwards), so for this repository the defect is inferred from the code plus sereus's measurement, not reproduced here. The lag cannot be reproduced on demand; it only shows during a real publish.

Checked from this machine against the live registry while writing this ticket (nothing published):

- `npm view --prefer-online --json @optimystic/db-core@1.8.1 version dist.tarball` prints an **object**, not a string, once more than one field is asked for: `{ "version": "1.8.1", "dist.tarball": "https://registry.npmjs.org/@optimystic/db-core/-/db-core-1.8.1.tgz" }`.
- The same call for a version that does not exist (`@9.9.9`) exits 1 with the same `{ "error": { "code": "E404", ... } }` object as today, so the not-yet-published path is unchanged.
- `HEAD` on an existing tarball URL answers 200; on a missing one (`db-core-9.9.9.tgz`) it answers 404. So a `HEAD` is enough — no need to download ~1 MB per package.

## The change

A package counts as published only when both hold:

1. `npm view` lists the version (today's check), and
2. a `HEAD` of that version's `dist.tarball`, sent with `cache-control: no-cache`, answers 200.

The straggler reason says which one is missing: the existing `not on the registry yet` for (1), and a new `tarball not downloadable yet` (404) or `tarball answered HTTP <n>` (any other status) or `could not reach <url>: <message>` (network error or timeout) for (2). `progressLine` already prints any reason other than `NOT_YET_VISIBLE`, so the waiting lines name the tarball case with no further change.

Shape, keeping the existing pure/impure split:

- **`scripts/published-visibility.mjs`** (pure):
  - `npmViewCommand` asks for `version dist.tarball` instead of `version`.
  - `readViewAnswer` reads the object form. A 0 exit with `{ version: spec.version, 'dist.tarball': <http(s) URL> }` returns `{ listed: true, tarball }` (name the success shape as you like; it is no longer "visible"). A missing or non-http(s) `dist.tarball` alongside the right version is not visible, with a reason naming the field — do not throw, the registry may fill it in. A version that differs still throws, as today. Empty output with exit 0 and the `E404` / other-error objects keep today's meaning. Validate the URL with `new URL`, not a regex.
  - New `readTarballAnswer(status)` → `{ visible: true }` for 200, `{ visible: false, reason: 'tarball not downloadable yet' }` for 404 (export the constant), `tarball answered HTTP <n>` otherwise.
  - `waitForVisibility` is unchanged: a straggler is re-asked in full (npm view, then HEAD) next round. A package seen once is still never asked again.
- **`scripts/await-published.mjs`** (impure): `probe` runs `npm view`; only when it returns a tarball URL does it `fetch(url, { method: 'HEAD', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })` and pass the status to `readTarballAnswer`. A rejected fetch becomes a not-visible reason (log nothing else, never throw — the loop asks again). Update the file's header comment and `--help` text to say the wait now also checks the tarball.

### Decisions already made

- **`fetch` for the tarball, not npm.** The metadata question stays on `npm view` because it answers with the npm configuration `npm publish` used. For the tarball, npm has no cheap "does this download exist" command: `npm pack <spec>` / `npm cache add` download the whole file and populate npm's cache, and a cached tarball could then answer from cache on a re-run. The URL comes from npm's own answer, so the registry choice is still npm's. The one thing `fetch` loses is npm's credentials: every package here is published `--access public`, so the tarball needs none. Record that as a `NOTE:` at the fetch — if a package is ever published to a registry that requires auth for downloads, the HEAD will answer 401 and the wait will time out naming it; then pass the registry token, or switch to npm.
- **No dist-tag check.** Sereus's port also waits for `dist-tags.<tag>` to point at the version. Here `yarn pub` publishes with no `--tag`, and the prerelease flow in `docs/releasing.md` has no tag of its own to wait for, so a `latest` check would be a guess about the prerelease case. Leave it out; add a `NOTE:` beside the tarball `NOTE:` saying a downstream `yarn up` resolves `latest`, and if an upgrade is ever seen to pick the previous version after this wait succeeded, ask for `dist-tags.latest` in the same `npm view` call (for non-prerelease versions).
- **Abbreviated metadata document: unchanged.** The existing `NOTE:` on `npmViewCommand` already parks it; sereus's measurement saw the version records all at 200 before the tarballs, so the tarball is the later of the two and the check that matters.
- **CDN caching.** `cache-control: no-cache` on a request is not guaranteed to bypass every CDN edge. Add a one-line `NOTE:` at the header constant: if a wait is ever seen to finish while an install elsewhere still 404s the tarball, the edge was stale; retry from the installer's side or add a short settle delay.
- **Success line text stays** `all N packages published and visible on npm at <version>`; docs/releasing.md defines what "visible" now covers.

### Out of scope

- Fret (`C:\projects\Fret`, commit d8e2846) carries the same step and needs its own change in that repository. Do not edit it from here.

## Tests

In `test-harness/published-visibility.test.mjs` (node's built-in runner, `yarn test:harness`), no network:

- Replace "counts the version echoed back as visible" with the object form returning the tarball URL (use the real output quoted above).
- Keep the throw-on-other-version test, rewritten for the object form (`{ "version": "1.2.0", ... }`).
- One test for `readTarballAnswer`: 200 visible, 404 → the tarball reason. This is the reproduction of the bug at the lowest layer that shows it (listed but not downloadable is not visible).
- Existing E404 / ECONNREFUSED / `waitForVisibility` tests stay as they are.

The fetch composition in `await-published.mjs` has no unit test (the file is not imported by tests, by design); check it by running `yarn await-published` against the current release (should print the success line within a few seconds). The listed-but-404 tarball case cannot be produced against the live registry on demand; the `readTarballAnswer` test covers its verdict, and the next real release exercises the composition. Say so in the handoff.

## Docs

`docs/releasing.md` § When the release is finished: say the wait asks npm for each package at its version and then checks that the version's tarball can be downloaded, because the registry makes the tarball available separately and later (the sereus 1.8.0 measurement is the example). Update the "If ten minutes pass first" sentence if the reasons it describes change. Run `yarn lint:docs`.

## TODO

- Change `npmViewCommand` / `readViewAnswer` for the two-field object answer; add `readTarballAnswer` and its reason constant.
- Compose the HEAD probe in `scripts/await-published.mjs`, with the three `NOTE:`s (credentials, dist-tag, CDN); update header comment and `--help`.
- Update and add the tests above; run `yarn test:harness`.
- Run `yarn await-published` against the live registry (expect success at 1.8.1).
- Update docs/releasing.md; run `yarn lint:docs`.
