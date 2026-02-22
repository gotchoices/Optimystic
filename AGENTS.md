## General

- No lengthy summaries
* Comments should only be non-obvious, and should be timeless (no "added this", etc.)
* Prefix with `_` for unused arguments.
* Enclose `case` blocks in braces if any consts/variables introduced.
* Prefix intentional calls to unused promises (micro-tasks) with `void`.
* ES Modules
* This project uses @.editorconfig.  Summary: Tab indentation,  Single quotes for strings.  Complete configuration in [.editorconfig](mdc:.editorconfig).
* "satisfies" better than casting when possible
* Don't use "any" lazily; only for dynamic typing.  Don't "monkey patch" attributes into objects; use proper types and interfaces.
* Inline imports() only for dynamic loading
* Avoid "swallowing" exceptions; exceptions should be exceptional - use results for expected conditions.
- Don't worry about backwards compatibility yet.
* Small, single-purpose functions/methods.  Decompose into separate functions over documented sub-sections - function names document the semantics.
* We want to be platform agnostic (browser, node, RN, etc.) unless we're explicitly building something platform specific

## Testing

All packages use mocha + chai directly (no aegir wrapper). The test command pattern is:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors
```

Each testable package has a `register.mjs` that sets up `ts-node/esm`. Run tests via `yarn test` from any package, or `yarn test:<name>` from root.

To grep for a specific test: `yarn test -- --grep "pattern"`

## Tasks

- If the user mentions tasks (e.g. work task...), read tasks/AGENTS.md to know what to do

This is an important system; write production-grade, maintainble, and expressive code that we don't have to revisit later.  Read @docs/internals.md to come up to speed - also maintain the docs.
