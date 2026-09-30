description: The release step that waits for packages to appear on npm asks `npm view name@version`, which can answer before the package's tarball can be downloaded, so the wait can end while `npm install` of the release still fails.
files:
  - scripts/published-visibility.mjs (the pure half: which packages, what counts as visible; its `NOTE:` on `npm view` reading the full metadata document)
  - scripts/await-published.mjs (the polling loop, `yarn await-published`)
  - test-harness/published-visibility.test.mjs
  - docs/releasing.md
source: sereus-ec, measured on the sereus 1.8.0 release (sereus ported this step from optimystic 50435c72 / 618f3ed8; its follow-up is sereus tickets/plan/2-release-waits-until-every-package-is-installable.md)
----
# The publish wait can end before the tarballs are downloadable

## Report

Sereus 1.8.0, 2026-09-30. By 18:40 UTC the manifest URL `/<name>/1.8.0` answered 200 for all seven
@serfab packages, while the tarball URL `/-/<pkg>-1.8.0.tgz` for three of them still answered 404
several minutes later. A wait built on `npm view name@version`, which is what `await-published` polls,
would have reported that release installable while `npm install` failed.

Optimystic 1.8.0 did not hit it: checked afterwards, every package's `dist.tarball` answered 200.

## Proposed direction

Sereus's port changes one thing: once a manifest answers, it polls that manifest's `dist.tarball` URL
(HEAD or GET, `cache-control: no-cache`) until it answers 200, and only then counts the package as
published. `npm view <spec> dist.tarball` already returns the URL, so the probe stays inside the
existing visible/not-visible verdict in `published-visibility.mjs`.

## TODO

- Confirm the gap against the registry's behaviour (manifest 200 while the tarball 404s) rather than
  taking one release's timing as the rule.
- Make a package count as published only when its tarball answers 200; keep the reason text naming
  which of the two was missing.
- Extend `test-harness/published-visibility.test.mjs` for the tarball-missing case.
- Update docs/releasing.md.
- Fret has the same step (d8e2846); that repository needs its own change.
