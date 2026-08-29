description: This package ships two entry points — one for Node, one for React Native and browsers — and the React Native one was missing nineteen exports, which broke a downstream build. All nineteen were added, and tests now fail if the two ever drift apart again.
files: packages/db-p2p/src/rn.ts, packages/db-p2p/test/entry-parity.spec.ts, packages/db-p2p/test/support/source-graph.ts, packages/db-p2p/test/testing-entry-runtime-deps.spec.ts, packages/db-p2p/readme.md
----

# What landed

`packages/db-p2p` publishes two entry points: `src/index.ts` for Node, and `src/rn.ts` for React
Native and browsers (`package.json` routes the `react-native` condition on `.` there, plus the
explicit `./rn` subpath). Nothing kept them in step, so nineteen modules were exported from one and
not the other — including two type-only symbols a downstream app could not import at all.

**`rn.ts` was regenerated from `index.ts`** rather than patched: both files are now 57
`export * from` lines in identical order, differing only in quote style and the single
`./libp2p-node.js` → `./libp2p-node-rn.js` substitution. A stale comment claiming
`cohort-topic/host.js` was "node-heavy" was removed along with the narrower `peer-sig.js` re-export
it justified; the claim was false and `cohort-topic/index.js` re-exports `peer-sig` anyway.

**`test/entry-parity.spec.ts` is the guard.** It reads both entry files as text — no build, no
bundler, ~25 ms — and compares them at module-specifier granularity. Granularity matters: a runtime
`Object.keys(namespace)` check would only see *value* exports, and the two sharpest reported gaps
(`IKVStore`, `BlockCommitProof`) are type-only and erase at runtime. Two collections carry the
intended asymmetries: `ENTRY_SUBSTITUTIONS` (the one transport-wiring swap) and `NODE_ONLY` (empty
by design — it is the seam a genuinely Node-only module would be added to).

The review pass extended that guard; see findings below.

# Review findings

## Verified before anything else

Read the implement diff cold, then re-derived the claims rather than accepting the handoff summary.

- **The reorder lost nothing.** Both entries hold exactly 57 specifiers, in the same order. Set
  difference in both directions is empty.
- **The substitution is real.** Nothing in `src/` imports `./libp2p-node.js` except `index.ts`, so
  the RN entry genuinely never re-reaches the TCP/WebSocket wiring through a back door. Checked by
  grepping every import of `libp2p-node` across `src/` — the only other hits are prose references to
  `libp2p-node-base.ts` in comments. (`optimystic-node.ts`, the obvious risk, does not import it.)
- **The plan's unverified safety claim holds.** The implementer flagged that `NODE_ONLY`'s emptiness
  rested on a planning-pass measurement they had not re-checked. Re-checked: `packages/db-p2p/src/`
  contains zero `node:`-prefixed imports and zero bare Node-builtin imports (`fs`, `path`, `crypto`,
  `os`, `net`, …). The claim is true — and is now a test rather than a measurement (below).
- **The downstream payoff is real at the type level.** The built `dist/src/rn.d.ts` has 57 `export *`
  lines including `./storage/i-kv-store.js` and `./cluster/commit-proof.js`, and those emitted
  declaration files exist and declare `IKVStore` / the commit-proof types. Both were previously
  unreachable through the `react-native` condition.

## Major findings — none filed as tickets, two fixed at the same site

No ticket was filed. Both real holes were in the new spec itself and closed there; neither had a
class behind it that a separate ticket would retire faster.

**The substitution seam was the one place the guard's own logic broke down.** The spec's soundness
argument is: every line is `export *`, so equal specifier sets imply equal export names. That
argument does not cover `ENTRY_SUBSTITUTIONS`, which deliberately declares two *different* modules
interchangeable. Nothing checked they still export the same names. Adding an export to
`libp2p-node.ts` and not to `libp2p-node-rn.ts` would have reintroduced the exact bug this ticket
exists to prevent, with every assertion green. This is not hypothetical drift bait: the plan
asserted the pair exports "exactly the same name set — `{ createLibp2pNode }`", and it is actually
four names. The claim was already one edit stale before it landed.

Fixed: a new assertion parses each substituted module's own export names and requires the two sets to
be equal, reporting any export shape it cannot attribute to a name (`export *`, `export default`) as
a loud failure rather than silently comparing a shrunken set.

**`NODE_ONLY` being empty was an assertion nothing enforced.** The implementer named this as the
load-bearing gap: add a Node-only module to *both* entries and the parity spec passes while React
Native breaks at runtime. They concluded no automated oracle exists. That is right for Node-only
third-party *packages* — the plan showed `@libp2p/tcp` ships a browser stub that resolves and bundles
cleanly and throws only on construction, so no bundle- or manifest-based check can see it — but it is
wrong for first-party code, where a builtin import is directly observable.

Fixed at the highest rung available: a boundary invariant, not a point check. A new assertion walks
the source import graph from `src/rn.ts` and requires it to reach no Node builtin, naming the
offending builtin and the file importing it. This converts the property the whole `NODE_ONLY`-empty
design rests on from a one-time measurement into something that stays true. The residual — Node-only
third-party packages — is genuinely uncoverable and is documented in the spec header.

## Minor findings, fixed in this pass

- **Duplicate `export *` lines were tolerated.** The comparison uses sets, so a repeated line makes
  the compared set narrower than the file it describes — which is how a stale duplicate hides a real
  edit. Now asserted against, per entry.
- **The source-graph walker was about to be duplicated.** `testing-entry-runtime-deps.spec.ts`
  already had a runtime import-graph walker; the builtin check needed the same one. Extracted to
  `test/support/source-graph.ts` (`walkRuntimeGraph`, returning reached files, packages, and
  builtins-with-importers) and both specs now use it. The existing spec's behaviour is unchanged —
  it reads `.packages` where it used to call its own `reachablePackages`.
- **Docs understated the change.** Every RN reference — `packages/db-p2p/readme.md` §React Native,
  `docs/architecture.md:59`, `docs/optimystic.md:257/259/261`, root `README.md` §React Native — was
  read and is accurate: each describes `/rn` as the entry that omits the Node-only TCP transport,
  which is still exactly true. None of them stated that the rest of the API is identical, which was
  *false* before this ticket and is *true and enforced* after it. One sentence added to the db-p2p
  README saying so and naming the spec. No other doc needed a change.

## Tripwires — recorded, not ticketed

- **The spec trusts `package.json`'s routing.** It compares the two entry *files*; if the
  `react-native` condition were repointed or dropped, React Native would silently get the Node entry
  and every assertion here would still pass. Parked as a `NOTE:` beside the entry constants in
  `entry-parity.spec.ts`, with the revisit condition (the exports map starting to change) and the
  cheap fix (`testing-entry-runtime-deps.spec.ts` already parses the same manifest).
- **Node-only third-party packages remain invisible to any static check.** Already documented in the
  spec's header comment; not repeated as a second `NOTE:`.

## Examined and deliberately left alone

- **The block-comment stripping the implementer flagged for review.** `/\*[\s\S]*?\*\//g` runs before
  line parsing, so a multi-line comment separating two `export *` lines would splice them into one
  line. That is safe by construction rather than by luck: the spliced line fails the shape assertion
  and goes red with a message telling the author to extend the spec. No `NOTE:` — a failure mode that
  reports itself does not need a comment.
- **Regenerating `rn.ts` from `index.ts` versus appending nineteen lines.** The implementer asked for
  a ruling. Regenerating is right: the two files are now diffable line-for-line, which is what makes
  the ordering-insensitive spec readable to a human. Confirmed no export was lost in the reorder.
- **The bundle-size figure (+79 KiB / +2.3%, unminified)** was not re-measured, matching the
  implementer's disclosure. The specifier set is now exactly `index.ts`'s, which already compiled and
  built, so the shape is confirmed; the byte cost is a planning-pass number and is labelled as one.
- No accepted-tradeoff `NOTE:` was found at any site touched, so nothing was re-litigated.

# The guard demonstrably fails

Each new assertion was mutation-tested in isolation (the implementer's four mutations were re-run
too, and `src/` was confirmed byte-clean afterwards):

| mutation | result |
| --- | --- |
| `export const REVIEW_PROBE = 1;` added to `libp2p-node.ts` only | red — diff names `REVIEW_PROBE` |
| duplicate `export * from './protocol-client.js';` in `rn.ts` | red — names the repeated specifier |
| `import 'node:fs'` added to `storage/memory-kv-store.ts` | red — `node:fs <- src/storage/memory-kv-store.ts` |
| `export * from` added to `libp2p-node-rn.ts` | red — names the unparseable line |

# Validation

| check | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p test` | **2283 passing, 44 pending, 0 failing** (2281 before; +2 net new tests) |
| `yarn workspace @optimystic/db-p2p typecheck` | clean |
| `yarn build` (root, all workspaces) | success, ~27 s |
| `yarn lint` (root, whole repo) | clean, exit 0 |

**Integration tests were not run.** `yarn test:integration` is gated behind `OPTIMYSTIC_INTEGRATION=1`
and is long-running — not agent-runnable, and unchanged from the implementer's deferral. The change is
re-export- and test-only with no runtime logic touched.

**No pre-existing failures encountered**; nothing written to `tickets/.pre-existing-error.md`.

**One assumption is still enforced only from this side.** A downstream consumer (`sereus`,
`cached-storage.ts`) relies on a class from either entry being the *same* class object on Node, so
`instanceof` holds across them. Identical module sets give that, it is recorded as a `NOTE:` at the
top of `rn.ts`, and the parity spec holds it — but that file is outside this repo and nothing here
fails if the downstream assumption changes.
