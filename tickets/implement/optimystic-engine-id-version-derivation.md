description: Replace the hardcoded Quereus engine version string with a runtime read from the installed package, so nodes running different Quereus versions correctly disagree on engine ID.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: easy
----

## Background

`QUEREUS_ENGINE_ID` (`quereus-engine.ts:17`) is used as a peer-comparison key: two nodes whose engine IDs differ will not try to re-execute each other's SQL transactions. Currently it is hardcoded as `'quereus@0.15.1'` while the installed and declared peer version is `4.3.0`. Nodes running genuinely incompatible Quereus versions can still compare equal.

## Solution: runtime read via `createRequire`

At module-load time, resolve the version string from `@quereus/quereus/package.json` using Node's `createRequire`. This is the approach the existing TODO comment anticipated (`"Import version dynamically from @quereus/quereus when it exports its version"`). `@quereus/quereus` is a peerDependency and is therefore external to the tsup bundle — the package.json is always resolvable at runtime in any host that satisfies the peer dep.

```ts
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: _quereusVersion } = _require('@quereus/quereus/package.json') as { version: string };
export const QUEREUS_ENGINE_ID = `quereus@${_quereusVersion}`;
```

Remove the existing JSDoc comment block on the constant (lines 11-16); replace with a single one-liner if the WHY is non-obvious. The `_require` variable is module-scoped and temporary — name it to avoid shadowing any local `require`.

## Test changes (`quereus-engine.spec.ts`)

Two test cases must change:

1. **Remove** the hardcoded equality check:
   ```ts
   it('should be quereus@0.15.1', () => {
       expect(QUEREUS_ENGINE_ID).to.equal('quereus@0.15.1');
   });
   ```
   Replace with a test that reads the installed version and asserts equality:
   ```ts
   it('should match the installed @quereus/quereus version', () => {
       const { createRequire } = await import('module');  // or top-level import in the spec
       const req = createRequire(import.meta.url);
       const { version } = req('@quereus/quereus/package.json') as { version: string };
       expect(QUEREUS_ENGINE_ID).to.equal(`quereus@${version}`);
   });
   ```
   (The spec is already ESM — `import.meta.url` is available. Use a top-level `createRequire` at the spec file level to keep it synchronous.)

2. **Keep** the format regex test unchanged — it's format-only and remains valid:
   ```ts
   it('should have correct engine ID format', () => {
       expect(QUEREUS_ENGINE_ID).to.match(/^quereus@\d+\.\d+\.\d+$/);
   });
   ```

## Edge cases & interactions

- **peerDep not installed**: if the host doesn't install `@quereus/quereus`, `createRequire('@quereus/quereus/package.json')` throws at module load. This is correct behavior — the plugin cannot function without Quereus. No special handling needed.
- **Multiple installed copies** (hoisting): `createRequire(import.meta.url)` resolves from the plugin's own `__filename`, so it resolves the same copy of `@quereus/quereus` that the engine's `import type { Database } from '@quereus/quereus'` resolves — consistent.
- **tsup bundling**: `@quereus/quereus` is a peerDependency; tsup treats peerDependencies as external by default. The `createRequire` call bypasses the bundler entirely (it's a runtime Node API), so no risk of the package.json being baked in or missing from the bundle.
- **Non-semver versions**: if `@quereus/quereus` ever publishes a pre-release version (e.g., `4.4.0-alpha.1`), the format regex test `/^quereus@\d+\.\d+\.\d+$/` will fail. That's acceptable — pre-release versions *should* not match, and the test will surface the mismatch. No fix needed now; add a `// NOTE:` comment at the regex test if desired.
- **No CI codegen needed**: because the ID is derived at runtime (not a build artifact), there is no hardcoded string that can drift. The existing test suite now enforces correctness on every `npm test` run.

## TODO

- In `quereus-engine.ts`: add `import { createRequire } from 'module';` at the top, add the `_require` + `_quereusVersion` derivation, replace the `QUEREUS_ENGINE_ID` assignment.
- Remove the multi-line JSDoc comment block above the constant (lines 11–16); replace with `// Engine ID derived from the installed @quereus/quereus version at runtime.` if needed.
- In `quereus-engine.spec.ts`: add `import { createRequire } from 'module';` at the top (or at the describe block), remove the `'should be quereus@0.15.1'` test, add the `'should match the installed @quereus/quereus version'` test.
- Run `npm test` in `packages/quereus-plugin-optimystic` and confirm all tests pass, including the new version-match test and the existing format regex test.
