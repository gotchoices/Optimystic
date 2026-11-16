description: The SQL plugin cannot be loaded at all alongside the current release of the SQL engine it plugs into, because it imports a helper function that the engine removed in its latest minor release. Every program that loads the plugin stops at start-up with a missing-export error.
files: packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (the `@quereus/quereus` import; `storedToColumnSchema`; `storedToMutationContextVar`), packages/quereus-plugin-optimystic/package.json (`peerDependencies` and `devDependencies` ranges for `@quereus/quereus`), ../quereus/packages/quereus/src/types/registry.ts and ../quereus/tickets/complete/unknown-type-names-are-refused.md (read-only: what replaced the helper)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: None for the import itself, which has to go; the open part is what the two call sites should do with a stored type name that is not registered, and a maintainer may want that settled together with the other open catalog tickets instead of in a quick patch.
----

Filed from the Sereus repository, which links this workspace and Quereus as siblings. It is in `backlog/` only because the filer was allowed to add files there and nowhere else; it breaks loading in normal use and is a candidate for `fix/`. The `severity:` scale has no value for "does not load", so `wrong-result` is used as the nearest: nothing is corrupted, and nothing works.

## What happens

`packages/quereus-plugin-optimystic/src/schema/schema-manager.ts` imports four names from `@quereus/quereus`:

```ts
import { buildColumnIndexMap, compilePredicate, getTypeOrDefault, inferType } from '@quereus/quereus';
```

Quereus removed `getTypeOrDefault` in the commit `ticket(implement): unknown-type-names-are-refused` (2026-11-14): the `TypeRegistry` method, the function, and the export from both `packages/quereus/src/types/index.ts` and `packages/quereus/src/index.ts`. The commit is an ancestor of the tag `v5.5.0` (2026-11-15), and `npm view @quereus/quereus version` returns `5.5.0`.

A static ES module import of a name the target does not export fails when the module graph is linked, before any code runs. So the plugin's entry cannot be imported at all.

## Reproduction

Run on 2026-11-16 with Node 24.2.0, from the Sereus checkout, where `node_modules/@optimystic/quereus-plugin-optimystic` and `node_modules/@quereus/quereus` are links to the two sibling checkouts (`dist` of this package built 2026-11-11, Quereus at 5.5.0):

```
cd sereus/packages/cadre-core
node --input-type=module -e "await import('@optimystic/quereus-plugin-optimystic')"
```

Result: `SyntaxError: The requested module '@quereus/quereus' does not provide an export named 'getTypeOrDefault'`.

The built file that carries the import is `packages/quereus-plugin-optimystic/dist/chunk-VWACF6LB.js`.

## Who is affected

- **Any workspace that links this checkout beside the current Quereus checkout.** Observed, above.
- **This workspace's own build and tests.** Inferred, not run: the root `package.json` resolves `@quereus/quereus` to `portal:../quereus/packages/quereus`, so the plugin's type-check should now fail on the import, and a rebuilt `dist` cannot be produced until the import is gone. Running the plugin's `build` would confirm it.
- **A fresh install of the published package.** Inferred, not run: `@optimystic/quereus-plugin-optimystic@1.27.0` is the published version, its source at tag `v1.27.0` has the import, and it declares `peerDependencies: { "@quereus/quereus": "^5.4.0" }`, which 5.5.0 satisfies. An install today that resolves Quereus 5.5.0 should fail the same way. Installing the two published packages into an empty directory and importing the plugin would confirm it. Downstream, `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus` declare the same two ranges.

## The two call sites

Both rebuild a Quereus schema object from what the plugin stored in its catalog.

- `storedToColumnSchema`: `logicalType: col.declaredType !== undefined ? inferType(col.declaredType) : getTypeOrDefault(col.affinity)`. `affinity` is the stored `logicalType.name` of a column whose record carries no declared type.
- `storedToMutationContextVar` (a private method of the schema manager): `logicalType: getTypeOrDefault(variable.type)`.

The removed helper returned the registered type of that name, or the BLOB type when the name was missing or unregistered.

## What Quereus has now

From `../quereus/tickets/complete/unknown-type-names-are-refused.md` and `registry.ts`:

- `getType(name)` is still exported and returns `undefined` for an unregistered name. `inferType(name)` is still exported and is lenient: exact name, then the base name before `(`, then the SQLite affinity rules, then BLOB.
- Quereus's stated reason for the removal is that silently turning an unknown type name into BLOB is a wrong result. Its own replacement at the one internal call site (`change-scope.ts`) throws, naming the type. With the new `strict_type_names` option on (the default), `SchemaManager.buildColumnSchemas`, which the ticket says is shared by `importTable` (the store catalog rehydrate path), refuses an unregistered declared type.

## Expected behaviour

The plugin loads against every Quereus version its declared range admits. That means either the code uses only names present across the range, or the range is raised to the version the code needs.

For a stored type name that is not registered in the running process, one behaviour is chosen on purpose and stated: either the table is refused with an error that names the type (what Quereus now does for its own catalogs), or it falls back as before. The old fallback is what Quereus removed as a defect, and a column read as BLOB when it was stored as something else is a silent mismatch on the very field (`StoredColumnSchema.affinity`) whose comment says the storage-adoption guard and the row codec key on it, so refusal looks like the consistent choice; the plugin's rehydrate path and its catalog tests decide whether that is safe for stores written by older releases.

## Not in this ticket

Whether Quereus should have removed a public export in a minor release is a question for Quereus's board. Nothing there or here records it.
