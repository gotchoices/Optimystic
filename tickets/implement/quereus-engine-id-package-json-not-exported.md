description: The Quereus plugin crashes on import in normal Node apps because it reads a file the Quereus package forbids; switch to a supported way to read its version.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts, packages/quereus-plugin-optimystic/register.mjs
difficulty: medium
----

## Problem (confirmed)

`packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts:10-15` derives the engine ID via CJS `createRequire` reading `@quereus/quereus/package.json`:

```ts
const _require = createRequire(import.meta.url);
const { version: _quereusVersion } = _require('@quereus/quereus/package.json') as { version: string };
export const QUEREUS_ENGINE_ID = `quereus@${_quereusVersion}`;
```

Under plain Node ESM this throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at module load, taking down every export (QuereusEngine, createQuereusValidator, register, …).

Root cause verified against the installed package. `@quereus/quereus/package.json` `exports`:

```json
"exports": {
  ".":       { "types": "./dist/src/index.d.ts", "import": "./dist/src/index.js" },
  "./parser":{ "types": "...", "import": "..." },
  "./emit":  { "types": "...", "import": "..." }
}
```

- No `./package.json` subpath → reading it is blocked by exports encapsulation.
- `.` defines only `types` + `import`, no `require`/`default` → CJS `require.resolve('@quereus/quereus')` also fails. `createRequire` cannot see this package at all.

## Why tests missed it

`yarn test` runs mocha under `node --import ./register.mjs`, which registers `ts-node/esm`. That loader ignores exports restrictions, so `@quereus/quereus/package.json` resolves under test but not under plain Node. 197 green tests were a false positive — the shipped path (plain-Node import of `dist/`) is never exercised. A regression test MUST run the built module under plain `node` (no ts-node loader), else it is masked identically.

## Fix

Resolve via ESM (honors the `import` condition quereus defines), then read `package.json` off disk by walking up from the resolved entry. Guard on `pkg.name` against stray inner `package.json`. No hardcoded version.

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

Drop the now-unused `createRequire` import from this file.

## Environment notes (verified)

- `import.meta.resolve(specifier)` is sync + stable since Node 20.6. Installed Node is v24; `@types/node` is `^25`.
- **No `node` engines floor exists** — root `package.json` has no `engines`, and the package's `engines` lists only `quereus` (line 71). Add `"node": ">=20.6.0"` to `packages/quereus-plugin-optimystic/package.json` `engines` so the `import.meta.resolve` requirement is declared. Do not add a fragile pre-20.6 fallback.

## Regression coverage

An in-mocha test is insufficient (inherits the ts-node loader that masks the bug). Add a plain-Node smoke check of the **built** module:

- Add script `"test:smoke"` to the package that runs, after build:
  ```
  node --input-type=module -e "import('./dist/index.js').then(m=>{if(!/^quereus@\\d+\\.\\d+\\.\\d+$/.test(m.QUEREUS_ENGINE_ID)){console.error('bad id',m.QUEREUS_ENGINE_ID);process.exit(1)}console.log('smoke ok',m.QUEREUS_ENGINE_ID)}).catch(e=>{console.error('THROW',e.code||e.message);process.exit(1)})"
  ```
- Wire it so it runs in the normal test flow after build (e.g. fold into `test` after the mocha run, or invoke `build` + `test:smoke` in CI). Ensure `dist/` is built before the smoke step — the existing `test` script does not build; confirm whether CI builds first, and if not, chain a build.

## TODO

- Rewrite `quereus-engine.ts:10-15` engine-ID block with the `import.meta.resolve` + upward-walk approach above; remove the unused `createRequire` import.
- Add `"node": ">=20.6.0"` to the package `engines` in `packages/quereus-plugin-optimystic/package.json`.
- Add a `test:smoke` package script (plain-Node import of `dist/index.js`) asserting `QUEREUS_ENGINE_ID` matches `/^quereus@\d+\.\d+\.\d+$/`; wire it into the build/test flow so it runs on built output.
- `yarn build` in the package, then run the smoke command manually — must print `smoke ok quereus@4.3.0` (not `THROW`).
- `yarn test` still green.
