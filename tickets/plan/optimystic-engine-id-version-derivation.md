description: A version tag used to decide whether two nodes agree on how to re-run SQL is hardcoded and has drifted from the real installed version, so nodes running genuinely different (incompatible) SQL engines can still think they match.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts
difficulty: easy
----

## Problem

`QUEREUS_ENGINE_ID = 'quereus@0.15.1'` (`quereus-engine.ts:17`) is a hardcoded
constant. It has drifted: the peer dependency is `^0.16.2` and the installed dev
version is different again. Validators dispatch re-execution of a transaction's
statements by matching this engine ID exactly. Because the constant is frozen and
wrong, peers running genuinely different Quereus versions — with potentially
different SQL semantics — still compare equal, so the version fence provides no
protection. It is fencing in name only.

## Desired outcome

The engine ID reflects the **actually installed** `@quereus/quereus` version, and
a mismatch between the constant and the lockfile cannot silently ship.

Suggested direction (from review): generate the constant from
`@quereus/quereus`'s `package.json` at build time, and add a CI check that
verifies it against the lockfile so drift fails the build rather than passing
silently.

## Cross-section coordination

The review flags this as related to a Transaction-section concern about the same
engine-ID / version fencing (tracked in that section as "tx-7"). If that section
also files an engine-ID ticket, these should be **unified into one fix** rather
than implemented twice — prefer a single source of truth for how the engine ID is
derived, and prereq-link the dependent. A human/runner should dedupe if both
exist.

## Notes

- Decide build-time codegen vs runtime read of the installed package.json
  (runtime read avoids a build step but must resolve the same package the engine
  actually uses).
- Define the CI assertion precisely (constant == resolved version from lockfile).
