description: The release step that waits for new packages to appear on npm now counts a package as published only once its download file can actually be fetched, not just once npm lists the version; review the change.
architecture: docs/releasing.md#when-the-release-is-finished
files: scripts/published-visibility.mjs, scripts/await-published.mjs, test-harness/published-visibility.test.mjs, docs/releasing.md
----
# Review: `yarn await-published` waits for each package's tarball

## What changed

`yarn await-published` used to count a package as published when `npm view <name>@<version> version` echoed the version back. That reads the registry's metadata; the tarball `npm install` downloads (`dist.tarball`) is served separately and later (sereus 1.8.0: all versions listed, three tarballs 404 for minutes). Now a package counts only when both hold:

1. `npm view --json <spec> version dist.tarball` lists the version with an http(s) `dist.tarball`, and
2. a `HEAD` of that URL, sent with `cache-control: no-cache`, answers 200.

Pure half (`scripts/published-visibility.mjs`):

- `npmViewCommand` asks for `version dist.tarball`.
- `readViewAnswer` now returns `{ listed: true, tarball } | { listed: false, reason }` (typedef `ViewAnswer`; the old `{ visible }` shape is now typedef `Visibility`, what `waitForVisibility`'s `probe` returns). Exit 0 goes through `readListing`: version must equal the spec's (else throws, as before); `dist.tarball` missing → `npm view listed no dist.tarball`; present but not http(s) (checked with `URL.canParse` + protocol, no regex) → a reason quoting the value. E404 / other-error / empty-output paths unchanged apart from the field name.
- **Measured, not in the ticket:** when `dist.tarball` is absent, npm 11.3.0 prints the lone remaining field bare — `npm view --json @optimystic/db-core@1.8.1 version dist.nonexistent` prints `"1.8.1"`, not an object. So `readListing` accepts both the object and the bare version string; the bare string is "listed, no tarball" → not visible.
- New `readTarballAnswer(status)` + exported `TARBALL_NOT_YET_DOWNLOADABLE`: 200 visible, 404 → that reason, else `tarball answered HTTP <n>`.
- `waitForVisibility` unchanged (a straggler is re-asked in full next round; a package seen once is never asked again). `timeoutReport` now says upgrades may "fail to download" too. `FETCH_TIMEOUT_MS` doc says it bounds the tarball check as well.

Impure half (`scripts/await-published.mjs`): `probe` runs `npm view`; only when listed does `probeTarball` `fetch(url, { method: 'HEAD', headers: REVALIDATE, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`. A rejected fetch becomes `could not reach <url>: <message>: <cause message>` — it is printed by the existing waiting/timeout lines, never thrown. Three `NOTE:`s as the ticket asked: CDN edges may ignore `no-cache` (at `REVALIDATE`), no npm credentials on the fetch (at `probeTarball`), no `dist-tags.latest` check (beside it). Header comment and `--help` updated.

Docs: `docs/releasing.md` § When the release is finished explains the two checks and why (sereus 1.8.0), and the ten-minutes sentence lists the new reasons.

## Tests (`test-harness/published-visibility.test.mjs`, `yarn test:harness`, no network)

- "reads the version echoed back as listed, with the URL of its tarball" — replaces the old visible test; uses the real two-field object output.
- "does not count the version as listed while npm names no tarball for it" — added beyond the ticket's list: pins the bare-string shape npm actually prints when `dist.tarball` is absent (measured above). Reviewer may judge whether it pays for itself.
- "throws on an answer to some other question…" — the other-version case rewritten in the object form.
- "readTarballAnswer: counts a listed version as published only once its tarball answers 200" — 200 visible, 404 → `TARBALL_NOT_YET_DOWNLOADABLE`. The lowest-layer reproduction of the bug (listed but not downloadable is not visible).
- E404 / ECONNREFUSED / `waitForVisibility` tests kept, adjusted only for the `listed` field name.

## Validation done

- `yarn test:harness`: 67/67 pass. `yarn lint:docs`: all resolve. `eslint` on the three changed `.mjs` files: clean.
- `yarn await-published` against the live registry at 1.8.1: `all 9 packages published and visible on npm at 1.8.1` in ~2.8 s, exit 0.
- By hand (one-off, not committed): the same `fetch` HEAD on `db-core-9.9.9.tgz` → `tarball not downloadable yet`; on `http://127.0.0.1:9/x.tgz` → `could not reach http://127.0.0.1:9/x.tgz: fetch failed: bad port`.

## Known gaps

- The fetch composition in `await-published.mjs` has no unit test (by design: the file is not imported by tests). The listed-but-404 tarball case cannot be produced against the live registry on demand; `readTarballAnswer`'s test covers the verdict, and the next real release exercises the composition end to end.
- The network-error reason format (`err.message` joined with `err.cause?.message`) was checked only for a refused/bad-port local URL and not for a timeout (`AbortSignal.timeout` → `TimeoutError`, message "The operation was aborted due to timeout"); reads fine by inspection.
- Fret (`C:\projects\Fret`) carries the same step and still needs its own change in that repository — out of scope here, not filed.
