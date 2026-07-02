## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY
- No lengthy summaries
- Don't worry about backwards compatibility yet
- Use yarn
- Prefix unused arguments with `_`
- Enclose `case` blocks in braces if any consts/variables
- Prefix calls to unused promises (micro-tasks) with `void`
- ES Modules
- Don't be type lazy - avoid `any`
- Don't eat exceptions w/o at least logging; exceptions should be exceptional - not control flow
- Small, single-purpose functions/methods.  Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- Be cross-platform (browser, node, RN, etc.)
- .editorconfig contains formatting (tabs for code)

## Testing

All packages use mocha + chai directly (no aegir wrapper). The test command pattern is:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors
```

Each testable package has a `register.mjs` that sets up `ts-node/esm`. Run tests via `yarn test` from any package, or `yarn test:<name>` from root.

To grep for a specific test: `yarn test -- --grep "pattern"`

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.


This is an important system; write production-grade, maintainble, and expressive code that we don't have to revisit later.  Read @docs/internals.md to come up to speed - also maintain the docs.

## Code search (tess)

**First tool** for any "where / how / why" question about this codebase: the local code-aware index wired to `mcp__code-search__*`. Reach for `grep`/`Glob` only when you already know the exact filename or literal string. Pick the right sub-tool — they are not interchangeable.

**Decision rule:**

- Query is identifier-shaped (any single symbol, camelCase, snake_case, or a list of names like `fooBar bazQux`)? → `find_references`.
- Query is prose ("where do we evict pages", "what handles JWT refresh", you don't yet know the identifier)? → `search_code`.
- About to run more than one `grep` to reconstruct context? → run `search_code` first instead. That is the moment it pays off, even when you already know an identifier.

`search_code` embeds the query as natural language. Identifier-bag queries can still work when the identifiers co-locate in real code, but prose phrasing is more reliable. If `search_code` returns a weak-top warning, the relative-percentage ranking is unreliable — switch to `find_references` or rephrase as prose, do **not** trust the ordering on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores are relative within each result set, not absolute. `k` defaults to 5 (max 50) — raise it for broad sweeps, lower it when you know the top hit is enough. `path_filter` is a SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). This is the indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand a snippet from either tool without a separate `Read`.

**Fallbacks:**

- Use `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (the index is chunk-granular and may miss adjacent matches inside one chunk).
- Never fall back to `grep` when `find_references` would suffice — it's strictly slower and pulls more bytes.

**What's indexed:** project source files tracked by git, minus `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, and a few cache dirs. If a query about prose-heavy material (long-form architecture docs, design notes, READMEs in nested folders) returns nothing, the file may be outside the indexed set — fall back to `Read`/`Glob` for those paths. Projects can override the filter via `tickets/index-config.json` (see tess README § Customize what gets indexed).

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
