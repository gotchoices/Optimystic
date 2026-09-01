description: Documentation used to point at code by line number, and most of those pointers were already wrong. The docs now name a symbol or a quoted phrase instead, and a new check fails the build when a pointer breaks.
files: scripts/check-doc-citations.mjs, package.json, AGENTS.md, README.md, docs/arachnode-ring-handoff.md, docs/architecture.md, docs/correctness.md, docs/internals.md, docs/matchmaking.md, docs/reactivity.md, docs/right-is-right.md, docs/transactions.md, packages/db-p2p/docs/storage.md, packages/db-p2p/readme.md, packages/db-p2p-storage-fs/README.md, packages/quereus-plugin-crypto/docs/crypto.md, packages/quereus-plugin-optimystic/test/README.md, packages/reference-peer/test/README.md
difficulty: medium
----

# Review: line-number citations replaced by anchors, plus a checker

## What landed

**Convention** — new `## Documentation citations` section in `AGENTS.md`, placed directly under the
existing "also maintain the docs" line. Two citation forms (`` `symbol` in `path` `` and
``(`symbol`, `path`)``), the double-quoted-fragment fallback where no symbol fits, no line numbers,
no ranges, doc-to-doc section anchors, external files carry their package prefix, no
slash-alternation anchors.

**Checker** — `scripts/check-doc-citations.mjs`, plain `.mjs`, no dependencies, following
`scripts/release-preflight.mjs` as precedent. Wired as `yarn lint:docs` and chained into `yarn
check` between `lint` and `build`; `lint` is still exactly `eslint .`.

**Conversions** — all 19 line-number citations across 10 targets converted, every anchor re-derived
from source at implementation time (several of the plan ticket's line numbers had already moved
again). Plus the non-line-number rot the plan identified, and one item it did not.

Current state:

```
$ node scripts/check-doc-citations.mjs
check-doc-citations: 45 documents, 71 anchored citations, 572 file mentions, 307 links — all resolve.
```

## Use cases to exercise

**The check catches what it is for.** Break a citation and confirm the message names document,
line, citation, and what was found instead. All three classes were exercised during implementation
against `docs/correctness.md` and restored afterwards:

| Break | Message produced |
| --- | --- |
| rename an anchor (`disputeEnabled` → `disputeEnabledXYZ`) | ``docs/correctness.md:7: anchor `disputeEnabledXYZ` not found in packages/db-p2p/src/dispute/types.ts`` |
| point a path at a missing file (`dispute-service.ts` → `gone-service.ts`) | ``docs/correctness.md:224: citation names `packages/db-p2p/src/dispute/gone-service.ts`, which is not a tracked file`` |
| reintroduce a line number (`docs/architecture.md:412`) | ``docs/correctness.md:7: line-number citation `docs/architecture.md:412``` |

Exit code is 1 with any finding, and every finding prints, not just the first.

**The GitHub-slug fixtures the plan called out.** All three resolve as passes. Verified directly
against the slugify function — the load-bearing detail is that runs of whitespace are *not*
collapsed, so a stripped em-dash leaves two adjacent hyphens:

| Heading | Slug produced |
| --- | --- |
| `## Part 1 — Damping the ring-shift decision` | `part-1--damping-the-ring-shift-decision` |
| `#### Invariant P — a pending record and a committed record never coexist for one action` | `invariant-p--a-pending-record-and-a-committed-record-never-coexist-for-one-action` |
| `## Browser Bootstrap (WebSocket / WSS)` | `browser-bootstrap-websocket--wss` |

**`tickets/**` really is out of scope.** 254 line-number citations remain under `tickets/` and the
check is green. The steady-state enumeration from the plan returns only `tickets/` hits:

```bash
git ls-files '*.md' | xargs grep -noE '[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|md):[0-9]+(-[0-9]+)?' | grep -v '^tickets/'
```
returns nothing.

**`AGENTS.md` does not fail on the document that defines the convention.** This was the predicted
way to land a red `check`, and it did fire during implementation — three findings on AGENTS.md's own
example text. Resolved by making the examples real rather than by exempting the file: the doc-to-doc
example links at a real heading, and the counterexample bare filename (`parser.ts`) is italicised
rather than backticked, since only inline code spans are treated as file claims.

## Deviations from the plan, and why

The plan's rule set was followed except where the tree proved it would produce false failures. Each
of these is a judgement call a reviewer should weigh:

- **Only `.ts`, `.tsx`, `.mts`, `.cts`, `.mjs` and `.md` paths are existence-checked.** The plan
  measured 17 non-resolving path tokens and classified 2 as genuine rot; the other 15 are
  illustrative or runtime files — `node --inspect app.js`, `Node.js`, the `meta.json` a storage
  backend writes, `coordinator/key1.json`, `./my-storage.js`, `mesh-ready.json`,
  `./quoomb.config.json`. Only two `.js` files are tracked in the entire repository, so policing
  that extension is nearly pure false positives. `.js` → `.ts` fallback resolution is still
  implemented for paths that *are* checked.
- **Only path tokens inside inline code spans (or as markdown link targets) are checked.** Unmarked
  prose — "Node.js, browsers, and React Native are first-class" — is not a claim about a file. This
  is why the mention count reads 572 rather than the plan's 290; different counting basis, not a
  scope change.
- **A backticked anchor must be symbol-shaped** (identifier, optionally dotted, optionally with a
  call's argument list). Without this, `` `yarn typecheck` ``, `` `@ts-expect-error` ``, ticket slugs
  and `` `@<actionId>` `` were all being read as anchors and reported. Non-symbol anchors use the
  double-quoted form, which is the convention's own escape hatch.
- **Exactly two connector shapes are recognised**, not a general proximity heuristic. A proximity
  rule was tried and produced roughly a dozen false failures. **The cost is real and is recorded as
  a tripwire** — see below.
- **`tess/` and `tickets/` path tokens are skipped.** `tess` is a submodule; `tickets/` is transient
  and already out of the document scope.
- **Scope uses `git ls-files --cached --others --exclude-standard`**, not plain `--cached`, so a
  document can cite a file added in the same change before it is staged. Without this the checker
  failed on `AGENTS.md`'s reference to the checker itself. `--exclude-standard` still honours
  `.gitignore`, so `node_modules` and `dist` stay out, and case comparison against git's own output
  is preserved (no `existsSync`).
- **Line-leading blockquote markers are blanked to spaces** (offsets preserved). Without this, any
  citation wrapping across a line inside a `>` quote was silently skipped — a false pass. This is
  what surfaced the `docs/reactivity.md` finding below.

## Judgement calls in the documents — please confirm

- **Root `README.md` test-loop section was removed.** The plan asked for this explicitly and asked
  that it be flagged. The `**📖 See START-HERE.md to begin using the automated test loop!**` line and
  the three-item "Additional documentation" list (`START-HERE.md`, `TESTING-GUIDE.md`,
  `QUICK-REFERENCE.md` — none of which exist anywhere in the repository) were replaced by a single
  sentence pointing at `packages/reference-peer/test/README.md` and `AGENTS.md`. The `yarn workspace
  @optimystic/reference-peer test:quick` code block above it was kept.
- **`packages/db-p2p/readme.md` "Related Packages" had two dead links** the plan did not list:
  `[@optimystic/db-quereus](../db-quereus)` and `[p2p-fret](../fret)`. Retargeted to
  `../quereus-plugin-optimystic` (the package was renamed) and to plain text respectively, since
  `p2p-fret` is an external package with no path inside this repo. **This is a content claim, not
  just a link repair** — worth a second pair of eyes that `quereus-plugin-optimystic` is the right
  successor to `db-quereus`.
- **`docs/transactions.md` change manifest.** Quereus files carry `@quereus/quereus/` prefixes as
  asked. The local ones got real repo-relative paths — and two of them (`src/network-transactor.ts`,
  `src/transaction-validator.ts`) are listed under a `### db-p2p` heading but actually landed in
  `db-core`, as `packages/db-core/src/transactor/network-transactor.ts` and
  `packages/db-core/src/transaction/validator.ts`. A one-line parenthetical says so rather than
  silently contradicting the heading.
- **`packages/quereus-plugin-crypto/docs/crypto.md`** no longer links into `tickets/`. Replaced with
  a sentence describing the mechanism plus a link to `packages/db-p2p/docs/cluster.md §Phase 1:
  Promise Collection`.
- **`packages/quereus-plugin-optimystic/test/README.md`** lost its `TEST-SETUP-SUMMARY.md` bullet;
  that file does not exist.
- **`docs/reactivity.md` §567 was not in the plan's conversion map.** The sentence read "The
  `ResumeV1` / `ResumeReplyV1` / `BackfillV1` / `BackfillReplyV1` codecs below are implemented in
  `resume.ts` / `backfill.ts`" — which of the four types lives in which of the two files was not
  recoverable from the prose. Split into two explicit clauses with full paths. Only surfaced once
  blockquote handling landed.
- **`packages/db-p2p/docs/storage.md`** block quote now includes the dropped `saveBlockProof`, as
  asked.
- **`docs/cohort-topic.md` and `packages/substrate-simulator/README.md` were not edited.** The
  ``(`walk.ts`, `promotion.ts`)`` file-list constructs pass under the path-shaped-anchor rule, as the
  plan predicted. Verified, not rewritten.

## Known gaps — treat the tests as a floor

- **`yarn check` was not run end to end.** Its chain is `lint && lint:docs && build && typecheck &&
  test && test:integration`; build plus both test tiers is far past the ten-minute agent budget, so
  it is out-of-band work for CI or a human. What *was* run: `node scripts/check-doc-citations.mjs`
  (green), `npx eslint scripts/check-doc-citations.mjs` (clean, exit 0), and the deliberate-breakage
  matrix above. **No TypeScript source was modified by this ticket** — the diff is markdown, one new
  `.mjs` script, and two `package.json` script lines — so `build`/`typecheck`/`test` should be
  unaffected, but that is reasoning, not a run. Worth confirming `yarn check` reaches the end.
- **No test harness for the script**, per the plan's explicit instruction (root `scripts/` has none,
  and `release-preflight.mjs` sets the precedent of an unrested script). Verification was by
  construction. If a reviewer disagrees, the three fixture tables above are the natural first cases.
- **Two error paths were reasoned about but not executed**: `git ls-files` being unavailable (a
  tarball export) and the scope filter matching zero documents. Both are coded to print and exit
  non-zero rather than pass vacuously; neither was simulated.
- **Anchor verification silently does not happen for citations written in a third shape.** Recorded
  as a `NOTE:` tripwire above `findCitations` in `scripts/check-doc-citations.mjs`. Adding a shape is
  the fix if rot ever slips through; loosening the connectors into proximity matching is not.
- **A citation's anchor is matched by substring, anywhere in the file** — including inside a comment
  or a `{@link}`. That looseness is intended (the claim is "this name still exists in this file", not
  "it is defined here") but it means a symbol that survives only in a doc comment still passes.

## Suggested review focus

- The false-positive/false-negative trade in `skipReason`, `usableAnchor` and the two connector
  regexes — these are where the check's value is actually decided, and each was tuned against the
  tree rather than derived from first principles.
- Whether removing the root `README.md` test-loop section is the resolution the maintainer wants, or
  whether those three documents should be written instead.
- Whether `@optimystic/quereus-plugin-optimystic` is the right successor for the dead
  `@optimystic/db-quereus` link.
- Run `yarn check` end to end.
