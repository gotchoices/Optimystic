----
description: One of the core database package's advertised entry points points at files that are deliberately excluded from what gets published, so anyone installing the package from a registry gets a broken import even though it works inside this repository.
prereq:
files: packages/db-core/package.json, packages/db-core/test/test-transactor.ts, packages/demo/src/run.ts
difficulty: easy
----

Review finding eh-2 (docs/review.html, Section 9 "Cross-cutting engineering health").

`packages/db-core/package.json` declares a `"./test"` subpath export that points at `dist/test/test-transactor.js`:

```
"./test": {
  "types": "./dist/test/test-transactor.d.ts",
  "import": "./dist/test/test-transactor.js"
}
```

but its `files` array contains `"!dist/test"`, so the published tarball omits exactly the directory the export points to. `packages/demo/src/run.ts` imports `@optimystic/db-core/test`; this resolves fine inside the monorepo through workspace linking, but breaks for every consumer who installs `@optimystic/db-core` from a registry because the referenced files were never shipped.

Expected end state: the `./test` entry point resolves for a registry install. Either move `TestTransactor` (and anything it needs) into `src/testing/` so it ships under `dist/src` and is covered by the existing `files` globs, then repoint the export; or stop excluding `dist/test` from the published `files`. Prefer the `src/testing/` move so test-only helpers still live in a clearly-named place while being part of the published surface. Update the export target, the `demo/src/run.ts` import if the path changes, and confirm a `yarn pack` (or dry-run publish) of db-core actually contains the referenced file.
