description: The package's own log-channel helper gained the two features it was missing compared to the third-party one some services still use — a separate channel for error messages, and support for the shorthand codes log messages use to print peer identities and errors readably. Reviewed and landed; no defects found.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/test/logger.spec.ts, docs/debugging.md
----

# Complete: `createLogger` widened to replace libp2p's `forComponent` logger

Step 1 of 3. Steps 2 and 3 remain open in `implement/` as
`migrate-services-off-libp2p-logger-factory` and `lock-and-document-db-p2p-log-namespaces`.
No service was migrated here.

## What landed

`packages/db-p2p/createLogger` now returns a `Logger` (`debug.Debugger` plus `.error` and `.trace`
child channels), and `packages/db-p2p/src/logger.ts` registers seven format specifiers on `debug`
— `%p` PeerId, `%a` Multiaddr, `%c` CID, `%e` Error, `%b` base58btc, `%t` base32, `%m` base64 —
ported from `@libp2p/logger`. `%k` was deliberately not ported (`interface-datastore` is not a
declared dependency and nothing formats a `Key`).

`Logger` is a superset of `debug.Debugger`, so all ~40 existing `createLogger` call sites were
untouched. `src/logger.ts` is not re-exported from `src/index.ts` or `src/rn.ts`, so `Logger` is
not new public API surface.

The review pass added the documentation for both halves and two tests; no source behaviour changed
during review.

## Review findings

### Checked

- **The diff itself, before the handoff summary.** Read `git show afac9cb3` cold.
- **Port fidelity.** Compared `formatError`, `printError`, `isAggregateError`, `notEmpty` and the
  six value formatters line-by-line against the installed upstream at
  `packages/db-p2p/node_modules/@libp2p/logger/dist/src/index.js`. They are verbatim, including
  the empty-`errors` `[Error list was empty]` branch and the `.trim()` at the top of `printError`.
  Upstream's `%p` is a bare `v.toString()` (its `truncatePeerId` is used elsewhere, not in the
  formatter), so the port is right not to truncate.
- **The AggregateError indentation arithmetic**, which the handoff explicitly asked a reviewer to
  look at. Verified empirically with a throwaway script (since deleted): each nesting level indents
  its children four more spaces, and a sibling of an inner aggregate stays at the outer level. Now
  pinned by a test rather than by a reading.
- **Global formatter-registry collisions.** `debug.formatters` is process-wide and six other
  packages import the same `debug` module. Grepped every `packages/*/src` for `%p %a %c %b %t %m
  %e`: the only hits are the four db-p2p error lines this work exists for. `%c` is the one letter
  with an existing Node `util.format` meaning (a no-op that swallows its argument); nothing in the
  tree uses it, so the override is inert today.
- **Test-helper claim.** `hasLine` in `test/support/capture-log.ts` predates this diff — the helper
  really was left untouched, and its `optimystic:db-p2p:<n>:*` enable really does reach `:error`.
- **Declared dependencies.** `multiformats`, `@multiformats/multiaddr` and `debug` are all in
  `packages/db-p2p/package.json`; the three `multiformats/bases/*` imports are not undeclared.
- **Test-isolation risk.** The `enabled` accessor test mutates global `debug` state. Confirmed
  `packages/db-p2p/.mocharc.json` sets only a timeout — mocha is serial here, so the
  save/restore pattern is sound. It would be racy under a parallel runner; that is already stated
  in the source.
- **Validation.** `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` all clean;
  `yarn workspace @optimystic/db-p2p test` → **2541 passing, 49 pending, 0 failing** (2539 before
  the two tests added below). No pre-existing failures surfaced; `.pre-existing-error.md` was not
  written. `yarn test:integration` was not run — it drives real TCP meshes and is not
  agent-runnable inside a ticket.

### Found and fixed in this pass (minor)

- **Documentation was stale.** `docs/debugging.md`'s *Adding new loggers* section described
  `createLogger` as returning a plain channel and said format strings are `%s`/`%d`/`%o` — true
  before this diff, wrong after it. Added a *Severity sub-channels and extra specifiers (db-p2p
  only)* section covering the `.error`/`.trace` channels, the wildcard-vs-exact-match filter
  caveat, the suffix ordering when a peer id is also present, and a table of the seven specifiers.
  Step 3's ticket plans to rewrite the *namespace table* in the same file; that is a different part
  of the document and this edit does not collide with it.
- **No test pinned the AggregateError indentation** — the exact thing the handoff flagged as worth
  a second pair of eyes. Added `indents each nesting level of an AggregateError by four more
  spaces`.
- **No test pinned the nullish guard** the six value specifiers all share. Added `renders
  \`undefined\` for a nullish or missing argument on every value specifier`, covering both an
  explicit `null`/`undefined` and a missing argument, in one line each. A future specifier added
  without the guard would throw from inside a log call; this catches the class rather than one
  instance.

### Reviewer calls the handoff asked for — all four resolved as "keep"

- **The `%e` try/catch deviation from upstream: keep.** The stated contract is that `%e` never
  throws, and every `%e` site in this package is a catch block where the bound value is `unknown`.
  Upstream's last resort (`` `${v.toString()}` ``) does raise for a null-prototype object, which is
  a legal thing to throw. Deviating is correct.
- **The `'[unformattable error]'` sentinel: keep.** The obvious alternative,
  `Object.prototype.toString.call(v)`, can itself throw — a `Symbol.toStringTag` getter or a Proxy
  trap runs during it — so it would need its own nested try for a marginally more informative
  string. Not worth the second layer.
- **Always-on `trace` rather than libp2p's conditional stub: keep.** libp2p reads enablement once
  at construction, which is wrong for any logger built before `DEBUG` is set, and a disabled
  `debug` channel is already near-free. The consequence is recorded as a tripwire below.
- **Hardcoded base-encoding expectations: keep.** Calling `base58btc.baseEncode` in the assertion
  would make it tautological — it would pass with `%b` wired to any encoder. The hardcoded strings
  are what makes it a guard, and they are correct (the suite is green against them).

### Recorded as tripwires, not tickets

- **Cross-package formatter sharing.** Importing `src/logger.ts` makes `%p`/`%e`/… work from every
  other package's logger in the same process, and a second package registering one of these letters
  would win silently by import order. Nothing does today. `NOTE:` in `src/logger.ts`'s top comment
  block.
- **Only `%e` is throw-proof.** The other six call `.toString()` or an encoder on whatever they are
  handed, so a caller passing the wrong type turns a log line into an exception. Their call sites
  pass typed values they constructed, so this is currently unreachable; it matches upstream.
  `NOTE:` in the same block.
- **`trace` is a real channel, so `optimystic:db-p2p:*` will show trace lines.** Free while nothing
  calls `.trace`; if trace logging ever becomes voluminous the fix is a narrower documented default
  filter, not stubbing the channel back out. `NOTE:` on the `Logger` doc comment.

### Considered and declined — no ticket filed

- **Splitting `src/logger.ts` into a formatter module plus a factory.** Measured 212 lines
  (`wc -l`), which is not size debt; both halves target the same `debug` instance so the coupling
  is real; and step 3 plans a lint exemption globbed at `packages/*/src/logger.ts`, which a split
  would force into a second entry for no gain.
- **Deduplicating the seven per-package `createLogger` factories.** The formatters are
  libp2p-specific (PeerId, Multiaddr, CID) and no other package embeds libp2p, so there is no
  duplication pressure — only db-p2p needs the widened shape. There is also no shared package to
  host them, and creating one is disproportionate to ~10 duplicated lines per package that predate
  this work.
- **Browser `%c` interaction**, which the handoff listed as an untested gap. Reading `debug`'s
  `common.js`, formatters run before `formatArgs`, so the browser build's own injected `%c` CSS
  directives cannot be double-substituted — the handoff's source reading is right. The residual
  risk is that browser `formatArgs` miscounts `%`-positions when a substituted value itself
  contains a `%X` sequence; that is cosmetic, browser-only, and byte-for-byte identical upstream,
  so it is not a regression this diff introduced.

### Not found

No correctness defect in the diff, and no major finding — hence no new `fix/`, `plan/` or
`backlog/` ticket from this review. The port is faithful, the one deliberate deviation is
justified, and the test suite covers the happy path, both null branches, the non-Error paths, the
unformattable path, and both AggregateError shapes.

## Carried forward, unchanged

The handoff's remaining gaps stand as written and belong to nobody in particular yet: no browser or
React Native build was exercised, `trace`'s ~80-extra-`Debugger`-objects-at-import cost was not
benchmarked, and `isAggregateError(err?: any)` keeps upstream's `any`. None is load-bearing for
steps 2 or 3.
