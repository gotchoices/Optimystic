description: The release step that waits for new packages to appear on npm now counts a package as published only once its download file can actually be fetched, not just once npm lists the version.
architecture: docs/releasing.md#when-the-release-is-finished
files: scripts/published-visibility.mjs, scripts/await-published.mjs, test-harness/published-visibility.test.mjs, docs/releasing.md
----
# `yarn await-published` waits for each package's tarball

## What landed

`yarn await-published` used to count a package as published once `npm view <name>@<version> version` echoed the version back. That reads the registry's metadata; the tarball `npm install` downloads is served separately and later (sereus 1.8.0: every version listed while three tarballs answered 404 for minutes). Now a package counts only when both hold:

1. `npm view --json <spec> version dist.tarball` lists the version with an http(s) `dist.tarball`, and
2. a `HEAD` of that URL, sent with `cache-control: no-cache`, answers 200.

Pure half, `scripts/published-visibility.mjs`: `readViewAnswer` returns `{ listed, tarball | reason }` (typedef `ViewAnswer`); `readListing` accepts both the object npm prints for two fields and the bare version string npm 11 prints when `dist.tarball` is absent (the latter is "listed, no tarball" → not visible); `readTarballAnswer(status)` gives the verdict (200 visible, 404 `TARBALL_NOT_YET_DOWNLOADABLE`, else `tarball answered HTTP <n>`). Impure half, `scripts/await-published.mjs`: `probe` runs `npm view`, then `probeTarball` only when listed; a rejected fetch becomes a printed reason, never a throw. Three `NOTE:` tripwires: CDN edges may ignore `no-cache` (at `REVALIDATE`), no npm credentials on the fetch, and no `dist-tags.latest` check (both at `probeTarball`). `docs/releasing.md` § When the release is finished explains both checks.

Validation: `yarn test:harness` 67/67, `yarn lint:docs` clean, eslint clean on the three scripts, and `yarn await-published` against the live registry at 1.8.1 → `all 9 packages published and visible on npm at 1.8.1`.

## Review findings

Read the diff of `ticket(implement): await-published-waits-for-downloadable-tarballs` first, then the handoff.

- **Correctness of the npm output parsing** — checked live: `npm view --json @optimystic/db-core@1.8.1 version dist.tarball` (npm 11.3.0) prints `{ "version": …, "dist.tarball": … }`, the key the code reads. The bare-string arm and the version-mismatch throw were traced by hand for string / object / `null` / array answers; all either read correctly or throw "does not understand". No change.
- **The http(s) check** — checked whether it is redundant with fetch failing on odd URLs. It is not: `fetch('data:,x', { method: 'HEAD' })` resolves 200 without contacting anything, so without the check a `data:` `dist.tarball` would count as published. Kept, and added a one-line why-comment on `isHttpUrl` (minor, fixed inline).
- **Error paths** — a timed-out or refused fetch, a non-200/404 status, and an `npm view` timeout all become a straggler reason printed by the existing waiting/timeout lines; the wait re-asks the whole probe next round. Each probe is now bounded at 60 s (npm) + 30 s (tarball), well inside the 10-minute deadline. HEAD responses carry no body, so nothing is left unconsumed. No change.
- **Docs** — `docs/releasing.md`: after the new "served means two things" paragraph, "Its last line is the one to wait for" no longer had a clear subject; reworded to "The script's last line…" in its own paragraph. "Before it, an upgrade can resolve a mix of versions" now also says "or fail to download one". Re-wrapped one over-long line the implement pass left. (Minor, fixed inline.) The `--help` text, header comment and `timeoutReport` already matched the new behaviour.
- **Tests** — kept all. The bare-string test pins a measured npm output shape that `readListing` branches on; the `readTarballAnswer` test is the lowest-layer reproduction of the bug (listed but 404 is not published). No test added: the fetch composition in `await-published.mjs` is glue the next real release exercises end to end, and the file is deliberately not imported by tests.
- **Tripwires** — the three `NOTE:`s the implementer placed (CDN edge staleness, unauthenticated fetch, `latest` dist-tag) are genuinely conditional and correctly parked at their sites; nothing new to park.
- **Major findings / tickets filed** — none. Nothing found that needed a ticket.
- **Out of scope, noted** — Fret (`C:\projects\Fret`) carries the same release step and needs the same change in its own repository; not filed here, as the implementer also noted.
