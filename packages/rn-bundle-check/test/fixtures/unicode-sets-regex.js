// Fixture for test/hermes-syntax.test.mjs: a regular expression with the `v` (unicode sets) flag.
// Babel passes it through untouched and legacy Hermes rejects it, so it proves the compile stage
// catches what the bundle stage cannot.

export const re = /[\p{L}--[a-z]]/v;
