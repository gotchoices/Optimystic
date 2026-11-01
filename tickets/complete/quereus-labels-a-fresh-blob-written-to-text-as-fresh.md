description: Quereus labelled a 16-byte random value written bare to a text column as fresh although the engine stores a lossy text rendering of the bytes, so the plugin judged such an offline insert assured. Fixed upstream in Quereus 4.21.1; the plugin now requires it.
architecture: docs/offline-sync.md#what-the-analysis-needs-from-quereus
files: packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts, packages/quereus-plugin-optimystic/test/write-description.spec.ts, docs/offline-sync.md, packages/quereus-plugin-optimystic/README.md
----

# Quereus labels a fresh blob written to text as fresh (complete)

The fix is upstream: Quereus ticket `write-scope-fresh-blob-into-text-column`, released in
`@quereus/quereus` 4.21.1. The classifier now applies the fresh-conversion rule
(`afterWriteConversion` in `@quereus/quereus/src/planner/analysis/value-provenance.ts`) to every
column, including a `text` column for which no `WriteCoercionNode` is planned.

## What changed here

- The plugin's `@quereus/quereus` dev and peer ranges and `engines.quereus` are raised to `^4.21.1`.
  A published plugin can then no longer be installed beside 4.21.0, which still mislabels the write.
  `yarn lint:deps` passes. `QUEREUS_VERSION` was regenerated to `4.21.1` by the build. The other
  workspaces keep `^4.21.0`, since none of them reads write provenance.
- `packages/quereus-plugin-optimystic/test/write-description.spec.ts` pins the case: "a fresh blob
  written bare to a text key is not fresh".
- The 4.21.0 caveat is removed from docs/offline-sync.md §What the analysis needs from Quereus. The
  README § Offline mode still recommends `hex(randomblob(16))` for a random text key, and now gives
  the reason as "not fresh", because a bare `randomblob(16)` into text is correctly judged not
  assured.

## Testing

The plugin suite passes: 1176 passing, 14 pending. `yarn typecheck` and `yarn lint:docs` pass.
