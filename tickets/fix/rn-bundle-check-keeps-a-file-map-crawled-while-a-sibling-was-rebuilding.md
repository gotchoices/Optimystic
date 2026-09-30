description: `yarn check:rn` failed with "Unable to resolve module p2p-fret" on every run after one that overlapped Fret's release build, and passed as soon as this repository's Metro file-map cache was deleted. A cached crawl that lost a sibling repository's files is reused instead of being re-crawled.
files:
  - packages/rn-bundle-check/metro.config.cjs (`siblingWatchRoots`, `cacheStores`, `resolver.useWatchman: false`)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs
  - packages/rn-bundle-check/readme.md
----
# The React Native bundle check reuses a crawl that lost a sibling's files

## Observed (2026-09-30)

A `yarn check` ran while Fret's 1.0.0 release was rebuilding `../Fret/packages/fret/dist`. Its
`check:rn` step failed:

```
Unable to resolve module p2p-fret from ...\packages\db-p2p\dist\src\cluster\spread-on-churn.js:
p2p-fret could not be found within the project or in these directories: ..\db-p2p\node_modules ...
```

After Fret's release finished, with `dist/src/index.js` present and
`packages/db-p2p/node_modules/p2p-fret` linking to it, a second `yarn check:rn` failed the same way
(now on `rebalance-monitor.js`). The config's `watchFolders` were correct (`C:\projects\optimystic`,
`C:\projects\Fret`, `C:\projects\quereus`). The file-map cache the failing runs wrote
(`%TEMP%\metro-file-map-6421d15b…-29bdd9a2…`) held the `p2p-fret` symlinks but no file under
`C:\projects\Fret`. Deleting that one cache file made the next run pass (bundle 4.7 s, hermesc
13.1 s).

## Not established

Why the Fret root dropped out of the crawl and was never re-crawled — whether the Node crawler
abandons a whole root on an ENOENT mid-walk, or the cached map is reused without re-checking a root
that came back. A second run did not recover on its own, so a sibling rebuilt while a check runs
(any release, `yarn clean && yarn build` there) can leave `check:rn` red until someone finds the
cache by hand.

## TODO

- Reproduce: remove and restore `../Fret/packages/fret/dist` around a `check:rn` run, and see
  whether a second run recovers.
- Fix so a stale crawl cannot outlive the condition that produced it. Options include keying or
  placing the file-map cache inside `node_modules/.cache/rn-bundle-check` beside the transform
  cache (so `clean` clears it), resetting it on failure and retrying once, or making the error name
  the cache to delete.
- Document the recovery in packages/rn-bundle-check/readme.md.
