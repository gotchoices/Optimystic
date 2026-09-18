description: Both Quereus plugins still declare `@quereus/quereus` `^4.3.0` as their peer and engine range. The optimystic plugin now imports `collectTableConstraintNames`, which Quereus first exports in 4.12.0, and relies on the type-alias fix that first shipped in 4.19.4. So a consumer on 4.3 through 4.11 installs without a warning and then fails to load the plugin, and a consumer on 4.12 through 4.19.3 loads it but gets the alias retype defect this release claims to fix.
files:
  - packages/quereus-plugin-optimystic/package.json (`peerDependencies['@quereus/quereus']`, `engines.quereus`)
  - packages/quereus-plugin-crypto/package.json (same two fields; see below)
  - yarn.lock (workspace entries record their peer ranges)
difficulty: easy
----

# The plugins' Quereus range admits versions they cannot run on

Found while drafting release notes for the release after `v1.0.0-beta.3`. This must land before that release is published: the range goes out in the published `package.json`, and a wrong peer range can only be corrected by publishing again.

## What is wrong

- `packages/quereus-plugin-optimystic/src/optimystic-module.ts` imports `collectTableConstraintNames` from `@quereus/quereus`. Quereus 4.12.0 is the first version that exports it, so the plugin cannot load on 4.3–4.11.
- `complete/quereus-differ-treats-type-aliases-as-a-retype` depends on an upstream fix that first shipped in Quereus 4.19.4. The maintainer bumped the dev dependency to `^4.19.4` for that reason. On anything older, the plugin loads, but an alias type name such as `int` is still treated as a retype.
- Both plugins still declare `peerDependencies['@quereus/quereus']: '^4.3.0'` and `engines.quereus: '^4.3.0'`. Only the dev dependency moved.

## What to do

1. Set the optimystic plugin's peer range and `engines.quereus` to `^4.19.4`, matching its dev dependency.
2. For `quereus-plugin-crypto`: check whether its source uses anything newer than 4.3. Search its imports from `@quereus/quereus` and check each one against Quereus's history in `../quereus`. The two plugins have been kept in lockstep, so raise crypto to `^4.19.4` as well unless there is a concrete reason not to, and record which choice you made and why.
3. Run `yarn install` so `yarn.lock`'s workspace entries pick up the new ranges, then `yarn lint:deps` and `yarn constraints`. `yarn.config.cjs` may enforce a relationship between peer and dev ranges; if it does, satisfy it rather than loosening it.
4. Grep the docs and READMEs (both plugins' README.md, `docs/`) for a stated minimum Quereus version and update it.

No source change and no new test. This is package metadata; the check is `yarn install` staying clean and `yarn lint:deps` passing.

