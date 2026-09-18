description: Importing anything from the Quereus plugin's main entry, even just an error class, pulls in Node's file-system, path and URL modules, because the plugin works out the Quereus engine version by reading a package.json from disk when it loads. That breaks browser builds outright, and it may break or burden React Native apps too. Applications need these error classes to decide safely whether to retry a write.
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (lines 10–12 import `node:fs`, `node:url`, `node:path`; the engine id is resolved by walking up from the resolved entry and `readFileSync`-ing `package.json`)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (imports `QuereusEngine`, `QUEREUS_ENGINE_ID`)
  - packages/quereus-plugin-optimystic/src/index.ts (root entry; re-exports `PartialCommitError` and everything else)
  - packages/quereus-plugin-optimystic/package.json (`exports`: `.` and `./plugin` only)
  - packages/rn-bundle-check (`yarn check:rn` bundles and Hermes-compiles the db-p2p RN entry; confirm whether it covers the plugin at all)
repro: downstream (browser build)
severity: breaks-consumer
likelihood: normal-use
----

# What was reported

Reported 2026-09-17 by sereus (`sereus-83`). Importing `PartialCommitError` from `@optimystic/quereus-plugin-optimystic`'s root entry broke sereus's **browser** build, because loading that entry imports `fs`, `url` and `path`. Sereus has added a lint rule against the import on its side. That protects sereus, not the next consumer.

It matters more than a packaging nicety. This week's fixes told applications to classify failed writes by error class:
- retry on `TornActionError` only when `final === true`
- never after `SyncRetryExhaustedError`, `CoordinatorPartialCommitError` or `PartialCommitError`

An application that cannot import those classes has to parse error text instead. That is exactly what `backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text` is trying to end.

# The cause, from reading the code

`transaction/quereus-engine.ts` computes `QUEREUS_ENGINE_ID` (`quereus@<version>`) at module load. `@quereus/quereus`'s `exports` map defines no `./package.json` subpath, so the file resolves the package entry, walks up the directories, and `readFileSync`s the first `package.json` whose `name` matches. That needs `node:fs`, `node:url` and `node:path` at module scope. `quereus-validator.ts` imports it, and it is reachable from the root entry.

# Questions for the fix stage

1. **Does this reach React Native?** The maintainer's focus includes RN being solid. Establish whether an RN app that uses the plugin bundles this file, and what happens on Hermes: a Metro resolution failure, a runtime throw, or a shim that silently returns the wrong version. `yarn check:rn` bundles the **db-p2p** RN entry. Say whether it exercises the plugin at all. If not, whether it should is part of this ticket. Check sereus's RN reference app for how it imports the plugin today, and whether it relies on a shim.
2. **Where should the engine id come from?** Options, in rough order of preference:
   - a build-time constant: tsup `define` or a generated module, fixed when the plugin is built against a given quereus
   - an export from `@quereus/quereus` itself, which would need a quereus release, so say so
   - a lazy lookup, done only when a validator actually needs it and only on Node
   
   Note that the engine id is part of what validating members compare, so the id must be **identical** on every machine running the same quereus. A build-time constant is only correct if the plugin's dist is rebuilt whenever the resolved quereus changes. Say how that is guaranteed, or why it does not matter.
3. **Should the error classes also get a browser-safe subpath?** For example `@optimystic/quereus-plugin-optimystic/errors`, re-exporting `PartialCommitError` and whichever db-core errors callers are told to classify on. That is cheap and independently useful, but it does not fix (1) if the root entry stays Node-only. Decide whether both are wanted.

Start with a failing check. A bundle of the plugin's root entry for a browser target (esbuild or Metro, whichever the repo already has tooling for) that fails on the Node built-ins today is the regression guard this should leave behind.
