description: Review runtime derivation of QUEREUS_ENGINE_ID from the installed package version instead of a hardcoded string.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: easy
----

## What was done

Replaced the hardcoded `'quereus@0.15.1'` constant in `quereus-engine.ts` with a runtime read from `@quereus/quereus/package.json` via Node's `createRequire`:

```ts
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { version: _quereusVersion } = _require('@quereus/quereus/package.json') as { version: string };
export const QUEREUS_ENGINE_ID = `quereus@${_quereusVersion}`;
```

Removed the stale multi-line JSDoc comment block (including the incorrect version and the now-resolved TODO). Added a single `// Engine ID derived from...` comment.

Updated `quereus-engine.spec.ts`:
- Removed hardcoded `'should be quereus@0.15.1'` test
- Added `'should match the installed @quereus/quereus version'` test that reads the same package.json at test time
- Kept existing format regex test unchanged

## Test results

197 tests passing, 0 failures. Both Engine ID tests (format regex + installed-version match) pass.

## Use cases for review

1. **Correct version**: `QUEREUS_ENGINE_ID` reflects the actually-installed `@quereus/quereus` version at runtime.
2. **Node disagreement**: Two nodes running different Quereus versions will produce different engine IDs and correctly refuse to re-execute each other's transactions.
3. **Missing peerDep**: If `@quereus/quereus` is absent, module load throws immediately — correct fail-fast behavior.
4. **Bundle safety**: `createRequire` is a runtime Node API, bypasses tsup bundler; `@quereus/quereus` remains external.

## Known gaps / notes

- The format regex test (`/^quereus@\d+\.\d+\.\d+$/`) will fail on pre-release versions (e.g. `4.4.0-alpha.1`). This is intentional — pre-release should not satisfy the stable format. No fix needed now; noted below.

## Review findings

- Tripwire noted in test file: format regex breaks on pre-release `@quereus/quereus` versions — parked as `// NOTE:` comment at the regex test site.
