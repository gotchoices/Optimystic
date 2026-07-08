description: The Quereus plugin now crashes on import in normal Node apps because it tries to read a file the Quereus package doesn't allow reading; make it get the version a supported way.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts, packages/quereus-plugin-optimystic/register.mjs, packages/quereus-plugin-optimystic/package.json
difficulty: medium
----

## Symptom

Importing the built plugin (`dist/index.js`) under a standard Node ESM host throws at module load:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './package.json'
is not defined by "exports" in .../@quereus/quereus/package.json
```

Reproduce (from `packages/quereus-plugin-optimystic`, after `yarn build`):

```sh
node --input-type=module -e "import('./dist/index.js').then(m=>console.log(m.QUEREUS_ENGINE_ID)).catch(e=>console.log('THROW',e.code))"
# -> THROW ERR_PACKAGE_PATH_NOT_EXPORTED
```

The whole module fails to load, so every export (QuereusEngine, createQuereusValidator, register, …) is unusable — a hard regression versus the previous hardcoded-string version, which loaded fine.

## Root cause

The prior ticket (`optimystic-engine-id-version-derivation`) replaced the hardcoded engine ID with:

```ts
const _require = createRequire(import.meta.url);
const { version } = _require('@quereus/quereus/package.json');
export const QUEREUS_ENGINE_ID = `quereus@${version}`;
```

`@quereus/quereus` ships an `exports` map that exposes only `.`, `./parser`, `./emit` — **not** `./package.json`. Node's exports encapsulation therefore blocks the subpath `@quereus/quereus/package.json`. Worse, `createRequire` yields a **CJS** `require`, which matches the `require` export condition — but quereus's `.` entry defines only `types` + `import` (no `require`/`default`), so even `_require.resolve('@quereus/quereus')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` ("No exports main defined"). CJS resolution cannot see this package at all.

## Why the test suite did not catch it

`yarn test` runs mocha under `node --import ./register.mjs`, and `register.mjs` registers the `ts-node/esm` loader. That loader resolves bare/subpath specifiers leniently and **ignores the exports restriction**, so `@quereus/quereus/package.json` resolves under test but not under plain Node. The 197 green tests were a false positive: the code path that ships (plain-Node import of `dist/`) is never exercised by the harness.

Any regression test for this MUST run the built module under a plain `node` process (no ts-node loader) — an in-suite mocha test will be masked the same way.

## Recommended fix

Resolve via ESM (which honors the `import` condition quereus actually defines), then read `package.json` off the filesystem by walking up from the resolved entry. Verified working (returns `4.3.0`) under plain Node:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// import.meta.resolve honors the "import" export condition that
// @quereus/quereus defines; createRequire (CJS/"require") does not.
const entryUrl = import.meta.resolve('@quereus/quereus');
let dir = dirname(fileURLToPath(entryUrl));
let version: string | undefined;
for (let i = 0; i < 6 && !version; i++) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		if (pkg.name === '@quereus/quereus') version = pkg.version;
	} catch { /* keep walking up */ }
	dir = dirname(dir);
}
if (!version) throw new Error('Could not resolve @quereus/quereus version');
export const QUEREUS_ENGINE_ID = `quereus@${version}`;
```

Notes / decisions for the implementer:
- `import.meta.resolve(specifier)` is sync and stable in Node 20+. Confirm the repo's minimum Node (`engines` in package.json) is ≥ 20; if older, fall back to `createRequire(import.meta.url).resolve` **with the `import` conditions** is not available — instead resolve the package dir another supported way. Prefer bumping/confirming the Node floor over a fragile fallback.
- The `pkg.name === '@quereus/quereus'` guard makes the upward walk robust against any stray inner `package.json`.
- Do NOT reintroduce a hardcoded version.

## Required regression coverage

Add a check that runs the **built** module under **plain Node** (no ts-node), so this class of exports/loader mismatch can never silently pass again. Options:
- A tiny `node --input-type=module -e "import('./dist/index.js') ..."` smoke step wired into the package `test` script (run after build, before/after mocha), asserting the import resolves and `QUEREUS_ENGINE_ID` matches `/^quereus@\d+\.\d+\.\d+$/`; or
- A separate `test:smoke` script invoked in CI.
An in-mocha test alone is insufficient — it inherits the ts-node loader that masks the bug.

## Verification checklist

- [ ] `yarn build` then the plain-node reproduce command above prints a version (not `THROW`).
- [ ] `yarn test` still green.
- [ ] New plain-node smoke check present and passing.
