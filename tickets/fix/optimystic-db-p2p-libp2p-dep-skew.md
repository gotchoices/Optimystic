description: Resolve the @optimystic/db-p2p nested-libp2p version skew that produces 22 "export not found" warnings (StrictSign/StrictNoSign/TopicValidatorResult ← @libp2p/interface, streamMessage ← protons-runtime) in strict-ESM bundlers (the downstream NS webpack). Currently suppressed downstream via exportsPresence:'warn'.
prereq:
files: packages/db-p2p/package.json, ../sereus/packages/reference-app-ns/webpack.config.js, ../sereus/packages/reference-app-rn/metro.config.js
difficulty: easy
----

## Problem

`@optimystic/db-p2p` pulls in nested copies of `@chainsafe/libp2p-gossipsub`,
`@libp2p/autonat`, and `@libp2p/dcutr` that were built against **older** peer
versions of `@libp2p/interface` and `protons-runtime`. Those peers later renamed
or moved the symbols, so the nested deps import names that no longer exist:

- `StrictSign`, `StrictNoSign`, `TopicValidatorResult` ← `@libp2p/interface`
  (now live elsewhere / renamed)
- `streamMessage` ← `protons-runtime`

A strict-ESM bundler treats a missing named export as a hard error. To make the
downstream NativeScript build (sereus `@serfab/reference-app-ns`, webpack 5) compile,
its `webpack.config.js` sets `module.parser.javascript.exportsPresence = 'warn'`,
downgrading these to **22 warnings**. Metro (sereus `reference-app-rn`) tolerates them
silently, so the RN app never surfaced the skew. The code paths are reportedly not hit
at runtime, but the warnings are noise and the broad `exportsPresence:'warn'` relaxation
masks any *real* missing-export regression that might appear later.

## Expected resolution

Align the `db-p2p` dependency tree so the nested gossipsub / autonat / dcutr resolve a
`@libp2p/interface` + `protons-runtime` that actually export the symbols they import
(dedupe to a single compatible set, or bump the nested deps). This is an **optimystic**
fix (`packages/db-p2p`); sereus consumes it via root `resolutions`.

Once aligned, the sereus NS app's `exportsPresence:'warn'` override in
`../sereus/packages/reference-app-ns/webpack.config.js` should be removed so the build
re-enables strict missing-export detection (verify `test:bundle` stays at 0 errors,
0 — or only intentional — warnings). That downstream removal + verification is tracked
separately in sereus (`reference-app-ns-drop-exportspresence-override`).

## Notes

- Surfaced during sereus review of `reference-app-ns-runtime`. Not blocking: the app
  bundles and (pending device validation) is expected to run, matching RN behavior.
- Verify the same skew in the RN Metro path while here — fixing it in `db-p2p` cleans
  both sereus reference apps at once.
