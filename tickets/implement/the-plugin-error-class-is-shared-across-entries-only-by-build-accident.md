description: An application that loads the plugin through one entry point but imports its error class from the other only gets a working "is this that error?" check because the current build happens to put the class in a shared file. If a build setting ever changes that, the check silently stops matching and no test here or downstream would notice, and the application would stop recognising half-saved commits.
files:
  - packages/quereus-plugin-optimystic/tsup.config.ts (`splitting: true`, two entries: `index`, `plugin`)
  - packages/quereus-plugin-optimystic/src/plugin.ts (the `./plugin` entry; exports no error classes today)
  - packages/quereus-plugin-optimystic/src/index.ts (root entry; re-exports `PartialCommitError` from `optimystic-adapter/txn-bridge.ts`)
  - packages/quereus-plugin-optimystic/test/browser-bundle.spec.ts (the existing built-output spec; a natural neighbour for the new assertion)
difficulty: easy
----

# The hazard

Reported 2026-09-17 by sereus's review of its own change (sereus `76cb6880`).

Sereus **loads** the plugin through `@optimystic/quereus-plugin-optimystic/plugin`, the entry its phones and control database use. It **imports** `PartialCommitError` from the root entry, and as of tonight classifies retries with `err instanceof PartialCommitError`. Its name match and its lint rule are removed.

The `PartialCommitError` that `plugin.js` throws must be **the same class object** that `index.js` exports. Today it is, but only because `tsup.config.ts` has `splitting: true` and both entries pull the class from one shared chunk. Verified in the current build: `var PartialCommitError = class extends Error` is defined once, in `dist/chunk-*.js`; `index.js` re-exports it, and `plugin.js` does not mention it at all. If the build ever stops splitting, or splits differently, each entry gets its own copy. Then `instanceof` returns false for every real error, and a half-saved commit is classified as something else. **No test in either repository would fail.**

This is the error the week's retry guidance tells applications to branch on, so it should not rest on a bundler setting.

# What to do

1. **Assert class identity across entries, against the built output.** A spec imports `PartialCommitError` from `dist/index.js` and `dist/plugin.js`, and asserts they are the **same** constructor (`===`). It should also assert that an error thrown through the plugin entry's code path is `instanceof` the root export. Check it has teeth: build once with `splitting: false`, confirm it fails, and restore the setting.
2. **Export the error classes from `./plugin` as well.** Callers who use that entry can then import from where they load, with no cross-entry assumption at all. Include `PartialCommitError`, and consider re-exporting the db-core errors callers are told to classify on (`CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError`). Decide whether re-exporting db-core's classes risks the same two-copies problem across packages. If it does, re-export only the plugin's own class and say why.
3. **Record the rule at the site.** Put a comment in `tsup.config.ts` next to `splitting`, saying error classes must stay single-instance across entries and naming the spec that enforces it.

Reply to sereus once it lands: they can switch their import to `./plugin` if they prefer, or keep the root import, now protected.
