## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- No inline `import()` unless dynamic load
- No summary docs; update existing docs
- Stay DRY
- No long summaries
- Skip backwards compat for now
- Use yarn
- Prefix unused args with `_`
- Brace `case` blocks if any consts/variables
- Prefix unused promise calls (micro-tasks) with `void`
- ES Modules
- No type lazy - avoid `any`
- No eating exceptions w/o log; exceptions exceptional - not control flow
- Small single-purpose functions/methods. Decomposed sub-functions over grouped sections
- No janky half-baked parsers; use full parser or brainstorm other way with dev
- Cross-platform (browser, node, RN, etc.)
- .editorconfig hold formatting (tabs for code)

## Testing

All packages use mocha + chai direct (no aegir wrapper). Test command pattern:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors
```

Each testable package has `register.mjs` that sets up `ts-node/esm`. Run tests via `yarn test` from any package, or `yarn test:<name>` from root.

Grep specific test: `yarn test -- --grep "pattern"`

## Tickets (tess)

Project use [tess](tess/) for AI-driven ticket management.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/) directory.

Important system; write production-grade, maintainable, expressive code — no revisit later. Read @docs/internals.md to come up to speed - also maintain docs.

## Code search (tess)

**First tool** for any "where / how / why" question about codebase: local code-aware index at `mcp__code-search__*`. Use `grep`/`Glob` only when exact filename or literal string known. Pick right sub-tool — not interchangeable.

**Decision rule:**

- Query identifier-shaped (single symbol, camelCase, snake_case, or name list like `fooBar bazQux`)? → `find_references`.
- Query prose ("where do we evict pages", "what handles JWT refresh", identifier unknown)? → `search_code`.
- About to run more than one `grep` to rebuild context? → run `search_code` first. That moment it pays off, even when identifier known.

`search_code` embeds query as natural language. Identifier-bag queries work when identifiers co-locate in real code, but prose phrasing more reliable. If `search_code` returns weak-top warning, relative-percentage ranking unreliable — switch to `find_references` or rephrase as prose, do **not** trust ordering on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores relative within each result set, not absolute. `k` defaults to 5 (max 50) — raise for broad sweeps, lower when top hit enough. `path_filter` is SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). Indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand snippet from either tool w/o separate `Read`.

**Fallbacks:**

- Use `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (index chunk-granular, may miss adjacent matches in one chunk).
- Never fall back to `grep` when `find_references` suffices — strictly slower, pulls more bytes.

**What's indexed:** project source files tracked by git, minus `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, and few cache dirs. If query about prose-heavy material (long-form architecture docs, design notes, nested READMEs) returns nothing, file may be outside indexed set — fall back to `Read`/`Glob` for those paths. Projects override filter via `tickets/index-config.json` (see tess README § Customize what gets indexed).

## Caveman

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