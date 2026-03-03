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
