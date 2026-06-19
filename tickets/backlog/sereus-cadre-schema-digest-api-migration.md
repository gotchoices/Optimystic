# Sereus cadre-core schemaDigest uses removed 4-arg digest() signature

description: sereus packages/cadre-core/src/schema-verification.ts calls the old 4-arg digest(data, alg, inEnc, outEnc) API; optimystic's digest is now 3-arg (fields, alg='sha256', enc='base64url'), so the 'utf8' input-encoding arg is read as the output encoding and throws "Unsupported output encoding: utf8". Cross-repo: fix lives in the sereus repo, not optimystic.
prereq: none
files:
  - C:/projects/sereus/packages/cadre-core/src/schema-verification.ts
----

## Summary

This is API-drift breakage in the **sereus** consumer, not a bug in optimystic.
Optimystic's `quereus-plugin-crypto` `digest()` was intentionally changed (optimystic
commits `8cea904` / `f10094c`, ticket `crypto-digest-variadic-config`) from the old
4-arg form:

```
digest(data, algorithm, inputEncoding, outputEncoding)
```

to the framed-tuple 3-arg form:

```
digest(fields: readonly DigestField[], algorithm = 'sha256', encoding: OutputEncoding = 'base64url')
```

Sereus `packages/cadre-core/src/schema-verification.ts:27` still calls the old
signature:

```ts
return digest(payload, 'sha256', 'utf8', 'base64url') as string;
```

With the new signature, arg 3 `'utf8'` is interpreted as the *output* encoding.
`'utf8'` is not a valid `OutputEncoding` (a digest is not UTF-8 text), so
`resolveOutputEncoder('utf8')` throws.

## Failing test

The break is in the sereus repo and surfaces at module-load time of the sereus
integration scenario (the `signSchema(...)` call that builds the shared `SAppConfig`),
so every test in the file fails before any scenario runs:

```
cd C:\projects\sereus\packages\integration-tests
npx vitest run -t "Sequential Burst" src/scenarios/convergence-stress.integration.ts
# (whole file also fails: npx vitest run src/scenarios/convergence-stress.integration.ts)
```

(optimystic is `link:`-ed into sereus, so the sereus tests exercise live optimystic source.)

## Error output (reproduced at optimystic HEAD = b393998)

```
 FAIL  src/scenarios/convergence-stress.integration.ts
Error: Unsupported output encoding: utf8
 ❯ resolveOutputEncoder ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:129:9
 ❯ digest ../../../optimystic/packages/quereus-plugin-crypto/src/crypto.ts:324:56
 ❯ schemaDigest ../cadre-core/src/schema-verification.ts:27:16
 ❯ signSchema ../cadre-core/src/schema-verification.ts:40:13
 ❯ src/scenarios/convergence-stress.integration.ts:52:13
 Test Files  1 failed (1)
```

## Proposed fix (in sereus, not optimystic)

Migrate `schemaDigest` in `packages/cadre-core/src/schema-verification.ts` to the
new digest API. The payload is a single JSON string; pass it as a one-element field
tuple and drop the now-removed input-encoding arg:

```ts
function schemaDigest(schema: string, version: string): string {
  const payload = JSON.stringify({ schema, version });
  return digest([payload], 'sha256', 'base64url') as string;
}
```

`signSchema`/`verifySchema` both route through `schemaDigest`, so the sign/verify
round-trip stays internally consistent after the change. Note the resulting digest
bytes differ from any pre-existing persisted signature (the framed-tuple digest is
domain-separated and is not equal to a bare hash of the same payload), so any stored
schema signatures generated under the old API must be re-signed.

## What was ruled out

- **Not an optimystic regression.** Optimystic's own crypto suite is green
  (`cd packages/quereus-plugin-crypto && yarn test` → 61 passing) and uses the new
  3-arg `digest` API. The 4-arg form was removed deliberately, so reverting optimystic
  would undo intended work.
- **No optimystic-side root cause.** `resolveOutputEncoder` correctly rejects `'utf8'`
  as an output encoding (per `OutputEncoding`); the throw is the intended behavior of
  the new API, triggered by a stale caller.
- **No test-side workaround.** cadre verifies the schema signature on `addStrand` via
  the same `schemaDigest`, so a correctly-signed config cannot bypass the broken call;
  the empirical repro stays blocked until the cadre-core digest call is migrated.

## Disposition

Fix belongs in the sereus repo, which this optimystic runner does not commit and which
may carry concurrent in-flight work. Filed here as a backlog record so the cross-repo
migration is tracked; the actual edit should be made and committed in sereus.
