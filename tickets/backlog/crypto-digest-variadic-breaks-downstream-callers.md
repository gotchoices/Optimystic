description: The crypto plugin's recent change to how `digest` is called broke programs that still call it the old way, so a downstream test suite that uses it now fails. We need to decide whether to keep the new form only (and migrate callers) or accept both.
files: packages/quereus-plugin-crypto/src/crypto.ts, packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-crypto/README.md
difficulty: medium
----

## Context

This ticket was split out while triaging a "pre-existing" failure reported against
the sereus repo's `test/strand-membership-peer-rotation.spec.ts`.

The originally-reported failure (the suite failing to load with
`Cannot find package '@quereus/quereus'`) was a separate optimystic-workspace
install problem — a `uint8arrays` version conflict that left `node_modules`
unpopulated. **That has been fixed** by adding a `"uint8arrays": "^6.1.1"`
resolution to the root `package.json` (aligning the whole workspace on the
version `@quereus/quereus` requires, so the `portal:` link no longer conflicts).
With that fix `yarn install` succeeds and the suite loads.

Once the suite loads, a *second, independent* failure is exposed, which is what
this ticket captures.

## The failure

Command (run from the sereus checkout):

```
cd C:\projects\sereus\packages\cadre-core
yarn vitest run test/strand-membership-peer-rotation.spec.ts
```

Result: 10 of 14 tests fail with:

```
Error: Unsupported output encoding: utf8
 ❯ resolveOutputEncoder ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:129:9
 ❯ digest             ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:324:56
 ❯ signStrandPayload  src/strand-membership-writer.ts:50:21
```

## Root cause

The `crypto-digest-variadic-config` ticket (commit `8cea904`, currently in
`tickets/review/`) deliberately reworked the exported JS `digest()` function in
`@optimystic/quereus-plugin-crypto`:

- **Old:** `digest(data: string | Uint8Array, algorithm, inputEncoding, outputEncoding)`
  — hash the bytes of a single value decoded via `inputEncoding`.
- **New:** `digest(fields: readonly DigestField[], algorithm, outputEncoding)`
  — a *framed, injective* multi-field digest; algorithm/encoding bound at
  registration. There is no longer an `inputEncoding` parameter.

The downstream consumer in sereus
(`packages/cadre-core/src/strand-membership-writer.ts`) still calls the old
4-argument form, e.g.:

```ts
const hashBytes = digest(payload, 'sha256', 'utf8', 'bytes') as Uint8Array;   // line 50
const payloadDigest = digest(payload, 'sha256', 'utf8', 'base64url') as string; // line 71
```

With the new signature the third positional argument (`'utf8'`) lands in the
output-encoding slot, which `resolveOutputEncoder` rejects → "Unsupported output
encoding: utf8".

## What was ruled out

- **Not the reported install issue.** That was the `uint8arrays`/`@quereus`
  resolution failure, already fixed; the suite now loads and runs.
- **Not a uint8arrays v5→v6 regression.** The error is purely argument routing in
  `digest()`; it is independent of the uint8arrays version bump.
- **Reverting optimystic is the wrong fix.** The new variadic `digest` was a
  deliberate, reviewed breaking change (injective framing, NULL-distinguishable,
  load-time config). Do not undo it to satisfy old callers.

## Decision needed / suggested work

The fix is fundamentally a **downstream migration in sereus** (update
`strand-membership-writer.ts` and any other callers to the new variadic digest
API + the SQL `digest(...)` signature). That lives outside this repo and could
not be done from the optimystic triage.

From optimystic's side, the open question is whether the breaking change to a
*published* package warrants any of:

- a documented migration note / CHANGELOG entry calling out the signature change
  (README already updated, but downstream callers clearly missed it);
- a deprecation shim or a distinct function name for the old single-value/
  input-encoding behavior, if backward compatibility for existing callers is
  desired;
- coordinating the sereus migration as a paired change.

No code change is proposed here pending that decision.
