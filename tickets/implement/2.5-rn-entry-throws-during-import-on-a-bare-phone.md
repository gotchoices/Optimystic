description: One file that the React Native build of this networking package loads immediately builds two objects that a phone's JavaScript engine does not provide, so on a phone whose host app has not already patched that gap, simply importing the package crashes before any of its code has a chance to run.
files:
  - packages/db-p2p/src/storage/raw-store-codec.ts (lines 21-22, `new TextEncoder()` / `new TextDecoder()` at module scope)
  - packages/db-p2p/src/storage/kv-raw-storage.ts (imports raw-store-codec.ts)
  - packages/db-p2p/src/storage/cached-raw-storage.ts (imports raw-store-codec.ts)
  - packages/db-p2p/src/storage/storage-repo.ts (line 1188, `structuredClone` on the materialization path)
  - packages/db-p2p/src/rn.ts (the React Native entry point; re-exports all of the above)
  - packages/db-p2p/readme.md (§ React Native, the polyfill table)
difficulty: medium
----

# Why

Found 2026-09-16 while implementing
`tickets/complete/2-a-library-call-that-does-not-exist-on-phones.md` (a ticket about two other
Hermes-unsupported calls). That ticket's investigation grepped every platform global across
`packages/*/src` at once and turned up something bigger than the two calls it set out to fix.

`packages/db-p2p/src/storage/raw-store-codec.ts` constructs its text encoder and decoder at
**module scope**, not inside a function:

```ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();
```

React Native's JavaScript engine, Hermes, does not provide `TextDecoder` natively (this
repository's own `packages/db-p2p/readme.md` § React Native already documents that as a required
polyfill, and flags it "constructed at module load, so without it the app fails at startup" for
exactly this reason — this file is the case that note is about).

Because the construction happens at module scope, the failure happens the moment the module is
*loaded*, not the moment its functions are *called*. `raw-store-codec.ts` is imported (directly or
transitively) by `kv-raw-storage.ts` and `cached-raw-storage.ts`, both of which
`packages/db-p2p/src/rn.ts` — the React Native entry point — re-exports. So on a Hermes runtime
with no `TextDecoder` polyfill installed yet, **`import '@optimystic/db-p2p/rn'` throws while the
module graph is still loading** — before the importing application has a chance to run any of its
own polyfill-installation code that might otherwise have raced it into place.

That is a stronger failure than "a code path throws when reached" — it is "the package cannot be
imported at all." `test/entry-parity.spec.ts` cannot catch this: it only compares the two entries'
module *lists*, which are identical by design; the gap is in what those modules *evaluate*, not
which modules they are. `yarn check:rn` cannot catch it either — it bundles the RN entry with Metro
and compiles it with Hermes, and a call to a missing global compiles fine and only fails when
actually executed.

A second, related instance on the same entry: `packages/db-p2p/src/storage/storage-repo.ts:1188`
calls `structuredClone` (twice) on its materialization path:

```ts
const newBlock = applyTransform(structuredClone(base), structuredClone(transform));
```

`structuredClone` is likewise absent on Hermes and likewise already documented in the readme's
polyfill table as required ("`structuredClone()` | @optimystic/db-core | JSON round-trip is
sufficient"). This one is not a module-scope, import-time failure — it only throws when
`storage-repo.ts`'s materialization path actually runs — but it is the same class of gap and the
same package, so it is included here rather than filed separately.

**This does not make the package self-sufficient on Hermes even after both are fixed.** The
dependency graph still needs a `TextDecoder` before this package's own code runs at all:
`multiformats` and `yamux` construct `new TextDecoder('utf8')` at their own module scope, and a
phone must have that polyfill installed regardless of anything in this repository. Removing this
package's own two instances narrows this package's *own* contribution to the problem; it does not
remove the requirement to install the polyfill. Both things are true and should stay distinct in
whatever this ticket's implementer writes up — see the "Correction" and "worst one" sections of
`tickets/complete/2-a-library-call-that-does-not-exist-on-phones.md` for the fuller reasoning that
led here, including a description of the same `TextDecoder`-at-module-scope hazard independently
diagnosed in the sereus reference app's `polyfills/hermes.ts:63`.

# What to build

1. **`raw-store-codec.ts`: construct the encoder/decoder lazily** instead of at module scope —
   e.g. a small `getEncoder()`/`getDecoder()` that constructs on first use and memoizes, or move
   the `new TextEncoder()`/`new TextDecoder()` calls inside `encodeJson`/`decodeJson`/
   `encodeActionId`/`decodeActionId` themselves. Whichever shape, importing this module must no
   longer construct anything — only *calling* one of its functions should, so that a host that
   installs its `TextDecoder` polyfill before first use (which is the ordering RN's own
   `index.js` already establishes, per that entry's comment) never hits the crash, even though
   nothing in this file forced that ordering on it before.
2. **`storage-repo.ts:1188`: replace `structuredClone` with an explicit clone helper.** A JSON
   round-trip (`JSON.parse(JSON.stringify(x))`) is what the readme already tells integrators is
   sufficient for this package's use of `structuredClone`, so match that rather than inventing a
   different clone contract. Confirm what `base` and `transform` actually contain on this path
   (block data — should be JSON-safe) before assuming a JSON round-trip preserves everything a
   consumer needs; if it does not (e.g. a value the round-trip does not preserve, such as
   `undefined` inside an array — see `docs/internals.md` "Storage Returns References" and
   `tree.ts:196`'s comment about `structuredClone` preserving `undefined`), say so and pick a
   clone that does.
3. **Update `packages/db-p2p/readme.md` § React Native** to reflect the narrower requirement:
   `TextDecoder` and `structuredClone` are still required polyfills (multiformats/yamux and
   db-core still need them), but this package's own source no longer *adds* an import-time
   failure mode on top of that. Word it so a reader does not conclude the polyfills are now
   optional.
4. Add or extend a test that imports `@optimystic/db-p2p/rn` (or exercises the two fixed call
   sites) in an environment where `TextDecoder`/`structuredClone` are deliberately undefined,
   confirming import no longer throws and the two fixed call sites fail no earlier than they did
   before (i.e. only when actually invoked, not at import time) — this is the regression
   `test/entry-parity.spec.ts` cannot see, described above.

# Edge cases & interactions

- Lazy construction must still behave correctly when called concurrently/repeatedly — memoize
  rather than reconstructing per call, matching the current module-scope singleton's behavior.
- Do not change `encodeJson`/`decodeJson`/`encodeActionId`/`decodeActionId`'s signatures or the
  round-trip fidelity behavior documented in this file's own header comment (the open-ended
  `RevisionRange` encoding, `[E]` — see the comment above the encoder/decoder today).
- This ticket's fix does not touch `multiformats`/`yamux`'s own module-scope `TextDecoder` use —
  those are third-party and out of reach; the readme update (step 3) must not imply otherwise.

# TODO

- Lazily construct the encoder/decoder in `raw-store-codec.ts`; confirm nothing else in the
  package still constructs a `TextEncoder`/`TextDecoder` at module scope (re-run the grep from
  `tickets/complete/2-a-library-call-that-does-not-exist-on-phones.md`: `new TextEncoder|new
  TextDecoder` across `packages/*/src`, and check which hits are module-scope vs. inside a
  function).
- Replace `storage-repo.ts:1188`'s `structuredClone` with an explicit clone helper.
- Update the readme.
- Add the import-without-globals regression test.
- Run `yarn workspace @optimystic/db-p2p test`, `yarn workspace @optimystic/db-p2p build`, and
  `yarn check:rn`.
