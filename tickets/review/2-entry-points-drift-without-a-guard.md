description: The package's React Native entry point was missing nineteen exports that its Node entry had, which broke a downstream build; all nineteen were added and a test now fails if the two ever drift apart again.
files: packages/db-p2p/src/rn.ts, packages/db-p2p/test/entry-parity.spec.ts, packages/db-p2p/src/index.ts
----

# Entry-point parity: implemented and guarded

Two files changed, nothing else:

- `packages/db-p2p/src/rn.ts` — rewritten to mirror `src/index.ts` exactly (+30/−4).
- `packages/db-p2p/test/entry-parity.spec.ts` — new guard, 7 tests.

## What was done

**`rn.ts` now mirrors `index.ts` line-for-line.** Rather than appending 19 lines in some new order,
the file was regenerated *from* `index.ts` (quote style converted to single, `./libp2p-node.js` →
`./libp2p-node-rn.js`). Both files are now 57 `export *` lines in identical order, so a side-by-side
diff is trivially readable and future additions land in the same place in both.

The redundant `export * from './cohort-topic/peer-sig.js'` and its two-line comment claiming
`host.js` is node-heavy were removed; `./cohort-topic/index.js` re-exports `peer-sig` itself.

A `NOTE:` header on `rn.ts` records the class-identity invariant (identical module set → same class
object → `instanceof` holds across entries) and points at the spec as its enforcement.

**The gap was re-measured, not assumed.** Set difference against the current tree returned exactly
the 19 modules the plan listed, plus `peer-sig.js` as the only rn-only specifier. The plan's numbers
held.

**One plan detail was slightly off and is corrected in the code comment:** the plan says
`libp2p-node.ts`/`libp2p-node-rn.ts` export "exactly the same name set — `{ createLibp2pNode }`".
They export four names each (`createLibp2pNode`, plus types `Libp2pTransports`, `NodeOptions`,
`RawStorageProvider`). The *claim that matters* — both sides export the same set, so the
substitution is invisible at name level — is correct.

## The guard

`test/entry-parity.spec.ts`, mocha+chai, reads both entries as text. No build, no bundler; runs in
plain `yarn test` in ~10ms. `NODE_ONLY` is an empty documented `Map`; `ENTRY_SUBSTITUTIONS` holds the
single `libp2p-node` mapping. Seven assertions: shape (both files, `export *`-only), substitution
liveness, `NODE_ONLY` liveness, set equality (both directions reported separately), on-disk
resolution (both files).

## Validation — what was actually run

| check | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p test` | **2281 passing, 44 pending, 0 failing** |
| `yarn workspace @optimystic/db-p2p typecheck` | clean |
| `yarn build` (root, all workspaces) | success, 27s |
| `npx eslint` on both changed files | clean, exit 0 |

**The guard was mutation-tested — it demonstrably fails.** This was the plan's explicit
"a parity spec that cannot fail is the failure mode to avoid" requirement:

- Deleted `./storage/i-kv-store.js` from `rn.ts` → red, message names `./storage/i-kv-store.js`.
- Added an rn-only line → red on the reverse direction.
- Added `export { foo } from …` → red on the shape assertion, telling the author to extend the spec.
- Restored → green (7 passing). Working tree confirmed clean afterward.

**The downstream payoff was verified end-to-end, not inferred.** Against the *built* `dist/src/rn.d.ts`
(57 exports), a scratch file importing `IKVStore` and `BlockCommitProof` — the two type-only symbols
named as the sharpest reported symptoms — compiles under `tsc --strict --module nodenext`. Both were
previously unreachable through the `react-native` condition. The scratch file was deleted.

## Reviewer: known gaps, honestly

**The bundle-size figure was not re-measured.** The plan's +79 KiB / +2.3% (unminified) came from an
esbuild run in the planning pass. I did not repeat it. The root build succeeds and the specifier set
is now exactly `index.ts`'s, which already compiled, so the shape is confirmed — but if the exact
byte cost matters to you, re-measure it.

**This is a parity guard, not an RN-safety guard — and that distinction is load-bearing.** The spec
proves the two entries export the same modules. It does *not* prove those modules are browser-safe.
Add a genuinely Node-only module to **both** entries and the spec passes green while React Native
breaks at runtime. The plan established why a bundle check can't fill this hole (`@libp2p/tcp`
bundles cleanly under browser conditions via a stub that throws only on construction), so no
automated RN-safety oracle exists here. The sibling `testing-entry-runtime-deps.spec.ts` covers a
different axis (undeclared deps), not this one. **`NODE_ONLY` being empty is the current safety
argument, and it rests on the plan's measurement that no first-party module imports a Node builtin —
which I did not independently re-verify.** Worth a look if you want to pressure-test anything.

**The `sereus` `instanceof` assumption is enforced only from this side.** That file is outside this
repo. The invariant is now documented in `rn.ts` and held by the parity spec, but nothing here fails
if the downstream assumption changes.

**Integration tests were not run.** `yarn test:integration` is gated behind `OPTIMYSTIC_INTEGRATION=1`
and is long-running; skipped as not agent-runnable. The change is re-export-only with no runtime
logic touched, so risk is low, but it is untested by me.

**No pre-existing failures encountered** — nothing written to `tickets/.pre-existing-error.md`.

## Suggested review focus

- Is regenerating `rn.ts` from `index.ts` the right call versus appending 19 lines? It produces a
  bigger diff (4 removed lines are re-ordering, not deletions) but leaves the files trivially
  comparable. Confirm no export was lost in the reorder — the spec covers this, but a human diff of
  the two files side by side is cheap.
- The spec's block-comment stripping (`/\*[\s\S]*?\*\//g`) runs before line parsing. Harmless today
  (neither file has block comments) and it makes a future JSDoc header non-breaking, but it is
  regex-based, not a parser.
- Whether `NODE_ONLY`'s emptiness deserves a stronger runtime backstop, given the gap above.
