description: This package publishes two entry points — one for Node, one for React Native and browsers — and nothing keeps them in step, so exports have gone missing and only turned up when a downstream build broke. Measurement showed every one of the nineteen differing modules belongs on both, so the fix is to add them and add a test that fails here the next time the two drift apart.
files: packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/test/entry-parity.spec.ts, packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/src/libp2p-node-rn.ts, packages/db-p2p-storage-rn/src/leveldb-kv-store.ts
difficulty: medium
----

# Make the two entry points provably identical, and keep them that way

`packages/db-p2p` publishes two entry points. `src/index.ts` is the Node one; `src/rn.ts` is the one
React Native and browsers get (`package.json` routes the `react-native` condition on `.` there, plus
the explicit `./rn` subpath). Nothing keeps them in step. `withReadCache` went missing from `rn.ts`
and surfaced as a **downstream build failure**, not as anything red in this repo.

The planning pass measured the whole gap rather than eyeballing it, and the answer came back
unusually clean. **All 19 modules belong on both entries, and the exclusion list is empty.**

## What the measurements showed

Three separate checks, all run against the current tree:

**1. No first-party module in the gap touches a Node builtin.** A transitive import walk over each of
the 19 modules found zero `node:`-prefixed or bare-builtin (`fs`, `net`, `crypto`, …) specifiers.
Node-ness in this package lives entirely in third-party packages, never in our own source.

**2. None of the 19 introduces a single new third-party package to the RN entry.** This is the
decisive one. `rn.ts` already reaches 28 external packages and 113 first-party files transitively,
because `libp2p-node-rn.ts` pulls nearly the whole graph. Adding each gap module and re-walking:

| module | new external packages | new first-party files |
| --- | --- | --- |
| all 19 gap modules | **0** | 0–4 each (13 of them add 0) |
| `libp2p-node.js` | `@libp2p/tcp`, `@libp2p/websockets` | 1 |

So `libp2p-node.js` is the *only* module in the gap that pulls anything new, and what it pulls is
exactly the intended Node/RN asymmetry. Everything else is **already in the RN bundle** — it is
merely not re-exported. Concretely: `cluster/commit-proof.js`, the module the plan flagged as the
sharpest gap, adds **zero** new packages and **zero** new files. Its `@libp2p/crypto/keys` import —
which the plan wanted checked before adding — is already reached from the current `rn.ts` via
`libp2p-node-rn.ts`. That question is settled: it is safe.

**3. The combined entry bundles clean.** `src/rn.ts` plus all 19 modules, bundled by esbuild under
`react-native`/`browser` conditions: succeeds, no warnings, **3585 KiB vs 3506 KiB baseline —
+79 KiB, +2.3%**, unminified. That is the answer to the plan's bundle-size concern, and it is small
because the code was already being pulled in.

## Two approaches the plan proposed that measurement ruled out

Both were tried and both are dead ends. Do not spend time on them.

**A bundle-succeeds check is not an RN-safety oracle.** The plan hoped an import-graph walk or a
bundle could prove RN-safety by construction. It cannot. Bundling the *Node* entry `src/index.ts` —
`@libp2p/tcp`, `@libp2p/websockets` and all — under `react-native`/`browser` conditions **succeeds
cleanly**. The reason is an ecosystem convention: `@libp2p/tcp` ships a `browser` field remapping
`tcp.js` to `tcp.browser.js`, a stub whose constructor throws `'TCP connections are not possible in
browsers'`. It resolves and bundles fine and fails at runtime. A bundle check would pass on the
known-bad entry, so it has zero discriminating power here and would be a test that can never fail.

For the same reason, **`package.json` `browser`/`react-native` fields are not a usable signal**:
`@libp2p/tcp`, the most Node-only package in the tree, declares *both*, while genuinely safe
`@noble/curves` and `@libp2p/peer-id` declare neither.

**A runtime `Object.keys(namespace)` comparison would miss the actual bug.** Tempting, since it
compares real exported names — but it only sees *value* exports. The two sharpest reported symptoms
are **type-only**: `BlockCommitProof` (a downstream app had to derive it via
`Parameters<IRawStorage['saveBlockProof']>[2]` because it could not import it) and `IKVStore`. Both
erase at runtime and would sail past such a check. The guard must work at module granularity on the
source, not on runtime namespace keys.

There is also a live in-repo instance of the same class:
`packages/db-p2p-storage-rn/src/leveldb-kv-store.ts:1` does
`import type { IKVStore } from '@optimystic/db-p2p'` — and `storage/i-kv-store.js` is one of the 19
missing from `rn.ts`. That is a React-Native package importing a type its own entry condition does
not expose.

## The exclusion list is empty, and the mapping is invisible

`libp2p-node.ts` and `libp2p-node-rn.ts` export **exactly the same name set** — `{ createLibp2pNode }`
— so the one intended asymmetry disappears at the export level. Verified end-to-end with esbuild's
metafile: `index.ts` exports 226 names; `rn.ts` plus the 19 exports **226, with an empty diff in both
directions**.

So after this change the invariant is exact and needs no exceptions:

> The two entries re-export the same set of modules, with `./libp2p-node.js` ↔ `./libp2p-node-rn.js`
> as the single declared substitution.

Write the exclusion list as an empty, documented collection anyway — it is the seam a future
genuinely-Node-only module gets added to, and its emptiness is the point.

## The existing exclusion comment is factually wrong — correct it, don't preserve it

`rn.ts` currently carries:

```ts
// Browser-safe peer signing seam. The rest of ./cohort-topic pulls node-heavy host.js,
// so only peer-sig (@noble/curves + peer-id) is surfaced through the RN/browser entry.
export * from './cohort-topic/peer-sig.js';
```

`cohort-topic/host.ts` is **already in the RN bundle**, reached via `libp2p-node-rn.ts`. It imports no
Node builtin and no Node-only package. Exporting `./cohort-topic/index.js` adds 0 new external
packages and 1 new first-party file. The stated reason does not hold; the comment must go, replaced
by `export * from './cohort-topic/index.js'` (which re-exports `peer-sig` itself, so the existing
line becomes redundant and should be removed rather than kept alongside).

## The guard

A mocha+chai spec at `packages/db-p2p/test/entry-parity.spec.ts`, matching the package's existing
test style (see the sibling specs in `packages/db-p2p/test/`). It reads the two entry files as text —
no build step, no bundler, runs in plain `yarn test`.

It works at **module-specifier granularity**, which is what makes it catch type-only drift. To keep
that granularity *sufficient*, it also asserts the two files stay in the trivially-comparable shape
they are in today:

```ts
/** Modules deliberately present on only one entry, with the reason. Empty by design — see the
 *  ticket: every module in db-p2p is browser-safe except the libp2p transport wiring, and that is
 *  handled by ENTRY_SUBSTITUTIONS below rather than by exclusion. */
const NODE_ONLY: ReadonlyMap<string, string> = new Map();

/** The one intended asymmetry: the Node entry wires TCP/WebSocket transports, the RN entry does not.
 *  Both modules export exactly `createLibp2pNode`, so this is invisible at the name level. */
const ENTRY_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ['./libp2p-node.js', './libp2p-node-rn.js'],
]);
```

Assertions:

- Every non-blank, non-comment line in **both** entries is an `export * from '<specifier>'`. This is
  what makes specifier-set equality imply export-name equality; if someone introduces a selective
  `export { x }`, the comparison silently stops being sound, so fail loudly and make them extend the
  spec.
- After applying `ENTRY_SUBSTITUTIONS` to the Node set and removing `NODE_ONLY`, the two specifier
  sets are **equal**. Report both directions separately with the offending specifiers in the message
  — "in `index.ts` but not `rn.ts`" is the drift that broke the downstream build; the reverse
  direction matters too and is currently also empty.
- Both sides of every substitution and every `NODE_ONLY` key actually appear in the entry they claim
  to, so the mapping cannot rot into a no-op after a rename.
- Every specifier in both entries resolves to a file on disk. Cheap, and catches a typo'd re-export
  that `export *` would otherwise only surface at build time.

Also record the class-identity invariant as a `NOTE:` at the top of `rn.ts`: both entries re-export
the same modules, so a class obtained from either has the same identity on Node and `instanceof`
holds across them. A downstream consumer (`sereus`, `cached-storage.ts`) states this assumption in a
comment and relies on it for `instanceof` checks; that file is outside this repo and cannot be
tested from here, but the assumption is now enforced from this side by the parity spec.

## Edge cases & interactions

- **Type-only exports are the whole point.** Confirm by inspection that the guard would have caught
  the `IKVStore` and `BlockCommitProof` gaps. A name-level or runtime check would not.
- **Duplicate/ambiguous star exports.** Adding `./cohort-topic/index.js` while `./cohort-topic/peer-sig.js`
  is still listed re-exports the same bindings twice. They resolve to the same original binding so it
  is legal, but remove the redundant line rather than relying on that. esbuild reported no ambiguity
  warnings for the combined set, and the resulting specifier set is exactly `index.ts`'s (57
  specifiers each), which already compiles under `tsc`.
- **The substitution must be modelled as a mapping, not flagged as drift.** A guard that simply
  diffs the two sets reports `libp2p-node.js`/`libp2p-node-rn.js` as two spurious findings.
- **Comment and blank-line handling.** `rn.ts` currently has a two-line `//` comment; `index.ts` has
  none. The line parser must skip `//` and blank lines, and must not be fooled by a specifier
  containing `//` (none today, but `'./a.js' // note` trailing comments are the realistic case).
- **Quote style differs between the files** — `index.ts` uses double quotes, `rn.ts` single. Parse
  both.
- **Bundle weight** is a real cost even at +2.3%; the measured figure is unminified and pre
  tree-shaking, so consumers who import narrowly pay less. Named here so the reviewer does not
  re-litigate it: it was measured, not assumed.
- **`p2p-fret` resolves through a committed `portal:` resolution** to a sibling checkout
  (`../Fret/packages/fret`, root `package.json`). Deliberate project config, but it means the RN
  graph can pull a second copy of `@libp2p/crypto` from that checkout. Not this ticket's problem —
  do not chase it — but do not be surprised by the path if a bundle error mentions it.

## TODO

- Add the 19 missing `export * from` lines to `packages/db-p2p/src/rn.ts`, keeping the file's
  existing single-quote style and grouping them to mirror `index.ts`'s ordering:
  `cluster/client-signature-verifier`, `cluster/commit-cert`, `cluster/commit-proof`,
  `cluster/rebalance-monitor`, `cluster/spread-on-churn`, `cluster/block-transfer`,
  `cluster/block-transfer-service`, `cluster/i-transaction-state-store`,
  `cluster/memory-transaction-state-store`, `cluster/persistent-transaction-state-store`,
  `inbound-authorization`, `storage/block-archive`, `storage/i-kv-store`, `storage/memory-kv-store`,
  `reputation/index`, `dispute/index`, `cohort-topic/index`, `matchmaking/index`, `reactivity/index`.
- Remove the now-redundant `export * from './cohort-topic/peer-sig.js'` line and its two-line comment
  asserting that `host.js` is node-heavy — the claim is false and is superseded by
  `cohort-topic/index.js`.
- Add the `NOTE:` at the top of `rn.ts` recording the class-identity invariant and pointing at the
  parity spec as its enforcement.
- Write `packages/db-p2p/test/entry-parity.spec.ts` with the assertions above, `NODE_ONLY` empty and
  documented, and `ENTRY_SUBSTITUTIONS` holding the single `libp2p-node` mapping.
- Verify the spec actually fails when it should: temporarily delete one export line from `rn.ts`,
  confirm red with a message naming that specifier, restore. Do the same for a line added to `rn.ts`
  only. A parity spec that cannot fail is the failure mode to avoid here.
- Run `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/db-p2p typecheck`.
- Run `yarn build` from the root — `db-p2p-storage-rn` and `db-p2p-storage-web` consume these
  entries, and `leveldb-kv-store.ts`'s `IKVStore` import is directly affected by the change.
