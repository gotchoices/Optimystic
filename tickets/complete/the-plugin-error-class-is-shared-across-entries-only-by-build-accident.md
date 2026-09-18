description: The Quereus plugin's "is this a half-saved commit?" check used to work only because of a build setting nobody was watching; both of the plugin's entry points now export the commit-failure error classes directly, and a test holds the two entries to the same objects.
architecture: docs/transactions.md
files:
  - packages/quereus-plugin-optimystic/src/plugin.ts (re-exports `PartialCommitError`, `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError`)
  - packages/quereus-plugin-optimystic/src/index.ts (now re-exports the same three db-core errors, symmetric with `./plugin`)
  - packages/quereus-plugin-optimystic/tsup.config.ts (comment next to `splitting: true`)
  - packages/quereus-plugin-optimystic/test/entry-identity.spec.ts (new; the identity guard)
  - packages/quereus-plugin-optimystic/README.md (§ Error Handling)
  - docs/transactions.md (one line: where to import the partial-commit pair from)
----

# What landed

The plugin builds two entry points from one tsup config: the root (`dist/index.js`) and `./plugin` (`dist/plugin.js`, the one hosts load the plugin through). `PartialCommitError` used to be exported only from the root, so a host loading via `./plugin` and classifying with `instanceof` against the root's export (sereus does exactly this, reported 2026-09-17 from its change `76cb6880`) relied on both entries sharing one build chunk — true only because of `splitting: true`.

- Both entries now export the four error classes a caller classifies commit and write failures by: the plugin's own `PartialCommitError`, and db-core's `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError`. A host can import them from whichever entry it already loads, with no cross-entry assumption. Re-exporting db-core classes introduces no copy: db-core is `external` in `tsup.config.ts`, and the built chunk shows `export { ... } from '@optimystic/db-core'`, unbundled.
- `test/entry-identity.spec.ts` checks the **built** output: every error class is exported from both entries, **every** name both entries export is the identical object (plus `./plugin`'s default === root's `register`), and an error constructed via `./plugin` is `instanceof` the root's class.
- `tsup.config.ts` explains why `splitting: true` must stay; README and `docs/transactions.md` say where to import the classes from.

For sereus (`sereus-83` / `sereus-ef`): importing from `@optimystic/quereus-plugin-optimystic/plugin` or from the root both work and now return the same classes, backed by a test. Either is fine.

# Review findings

Read the implement diff (`b68b740f`) before the handoff. Checked: correctness of the exports, build output, test strength and placement, comment hygiene, docs, lint, full suite.

**Fixed inline (minor):**
- **The identity test checked one name; now it checks the whole class.** The implement spec compared only `PartialCommitError`. Any other export shared by both entries (the three db-core errors, `register`) had no guard. It is replaced by a general check: every name both entries export must be `===`, and the four error classes must be present in both so the check can't pass because one entry dropped a name. That retires the class of bug (a per-entry copy of any shared export), not just this instance.
- **The test was in the wrong file.** It lived in `test/browser-bundle.spec.ts` and added top-level `../dist/*` imports there, so a missing or stale `dist` would also stop the unrelated browser-bundle guard from loading. It is now in its own `test/entry-identity.spec.ts`; `browser-bundle.spec.ts` is back to its pre-ticket content. The references in `tsup.config.ts`, `plugin.ts` and `index.ts` point at the new file.
- **The error exports were lopsided.** Only `./plugin` exported the three db-core errors, so the README had to say which entry had which class, and a host importing from the root had to reach into `@optimystic/db-core`. The root now exports them too, so the rule is simply "both entries export all four error classes", and the test enforces it.
- **Comments were too long.** `plugin.ts`'s 15-line comment (including the dual-package aside the handoff asked about) is cut to 5 lines that keep the why: why these are exported here, and why re-exporting db-core is safe. The dual-package hazard (two separately installed copies of db-core) isn't something this package can cause or detect, so the comment no longer covers it. The `tsup.config.ts` comment is shorter too.
- **Docs:** the README paragraph was rewritten for symmetry. Its "coordinator-side errors" label was wrong for `SyncRetryExhaustedError`/`TornActionError`, which come from the writer-side collection code, so each class is now described and linked to the doc that covers it (`docs/transactions.md` for the partial-commit pair, `docs/internals.md` for the other two). `docs/transactions.md`'s "must handle both `CoordinatorPartialCommitError` and `PartialCommitError`" line now says where to import them.

**Verified:**
- The built chunk imports `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError` from `@optimystic/db-core` as an unbundled import, which is the basis for "safe to re-export". The `.d.ts` output also shares one chunk (`plugin-*.d.ts`), so the types match across entries too.
- Teeth check, rerun independently on the new spec: I built with `splitting: false` and 2 of 3 specs failed (the `===` check on `PartialCommitError`, and the `instanceof` check). I restored `splitting: true` and rebuilt; `tsup.config.ts` now differs from HEAD only by the comment.
- `npm run build`, `npm run typecheck` (tsconfig includes `test/`), `npx eslint` on every changed TS file, and `yarn lint:docs` (all citations resolve) are all clean.
- `npm test` in the plugin package gave **996 passing, 13 pending**, `smoke ok quereus@4.19.4`. That is 993 before the ticket + 3 new specs; the pending count is unchanged.

**Considered, no action:**
- Driving a real multi-tree commit failure instead of constructing the error by hand: not needed. `./plugin`'s export is a direct re-export of the class `TransactionBridge` throws, and throw-path behavior is already covered by `two-node-unique-value-race.spec.ts` and `legacy-commit-atomicity.spec.ts`.
- A dedicated `/errors` subpath: declined for the same reason the prior ticket gave (error classes live on the two existing entries).
- Module-level state that isn't exported (caches, registries in the shared chunk) would also be duplicated if splitting were turned off. The same spec fails in that configuration, so no separate guard is needed.
- No tickets filed and no tripwires added: nothing conditional or out of scope came up.

**Not run:** `yarn check:rn`, `yarn test:integration`, the full-monorepo `yarn check`/`yarn lint:deps`. The change adds re-exports of a package already in both entries' import graphs (db-core) and touches no React Native–specific or other-workspace code.
