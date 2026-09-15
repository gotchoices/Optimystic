description: Our React Native setup guide tells app developers to install four stand-ins for Node's built-in modules, but a real build of our React Native entry only ever asks for one of them. Make the build check report stand-ins nothing uses, and trim the guide to match, so apps are not told to install things they do not need.
files:
  - packages/db-p2p/readme.md (§ React Native, "Node.js built-in module shims" table)
  - packages/rn-bundle-check/metro.config.cjs (`NODE_BUILTIN_SHIMS`, the aliases that mirror the table)
  - packages/rn-bundle-check/scripts/rn-bundle-check.mjs (`bundle` already reports every resolution through `onResolve`)
  - packages/rn-bundle-check/test/shim-table-parity.test.mjs
  - packages/rn-bundle-check/shims/node-crypto.js, packages/rn-bundle-check/package.json (`buffer`, `readable-stream`, `@noble/hashes` exist only to serve the aliases)
tradeoffs: A row the React Native entry never reaches may still be needed by a host app's other dependencies or an older libp2p, and an unused alias costs an app nothing to keep, so pruning the guide trades a little accuracy for the risk of breaking someone's build.
----

# What was observed

The db-p2p readme's React Native section has a table of Node built-in modules that an app must alias to stand-in implementations in its Metro config: `os`, `crypto`, `stream` and `buffer`, each also under its `node:` spelling. `yarn check:rn` aliases exactly those rows, and a parity test keeps the config and the table in step, so the readme can now say the rows are "known to be enough".

"Enough" is not "needed". During review of `rn-bundle-and-hermes-compile-check` (2026-09-15, Windows), the real `entry.js` was bundled with the exported `bundle()` function and an `onResolve` callback that recorded every resolution of the eight aliased names plus `react-native`. Only two were ever requested:

- `node:os` → `shims/node-os.js`
- `react-native` → `shims/react-native.js` (the harness-only stub, not a table row)

`os`, `crypto`, `node:crypto`, `stream`, `node:stream`, `buffer` and `node:buffer` were never resolved. One plausible reason, not confirmed: `multiformats`' `browser` field sends Metro to `hashes/sha2-browser.js` rather than the Node `crypto` variant the table names. Metro's resolver warnings about that file appear on every run.

# Why it matters

- The readme tells every host app to write a custom `crypto` shim and install `readable-stream` and `buffer`, which the documented recipe does not need.
- An unused alias hides a regression. With `buffer` aliased, a new `import 'buffer'` anywhere reachable from the React Native entry bundles cleanly, where it would otherwise fail `yarn check:rn` with a pointer to the table.
- Nothing notices when a dependency upgrade makes a row obsolete, so the table only ever grows.

# Expected behaviour

- `yarn check:rn` fails when a table alias is never resolved by the bundle, the same way it already reports an expected export route that the entry never imports (`unreached()` on the route recorder), naming the row to remove.
- The readme table lists only the modules the React Native entry actually reaches. If a row is kept for another reason (for example, a known host dependency), the table says so, and the check has an explicit exemption for it.
- The workspace drops any shim file and devDependency that only served a removed alias.
