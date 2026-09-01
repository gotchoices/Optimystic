description: Documentation used to point at code by line number, and most of those pointers were already wrong. The docs now name a symbol or a quoted phrase instead, and a new check fails the build when a pointer breaks.
files: scripts/check-doc-citations.mjs, package.json, AGENTS.md, README.md, docs/arachnode-ring-handoff.md, docs/architecture.md, docs/correctness.md, docs/internals.md, docs/matchmaking.md, docs/reactivity.md, docs/right-is-right.md, docs/transactions.md, packages/db-p2p/docs/storage.md, packages/db-p2p/readme.md, packages/db-p2p-storage-fs/README.md, packages/quereus-plugin-crypto/docs/crypto.md, packages/quereus-plugin-optimystic/test/README.md, packages/reference-peer/test/README.md
----

# Complete: documentation citations are anchored, and a check keeps them honest

## What shipped

Documentation no longer points at code by line number. A citation now binds an **anchor** — a
symbol name, or a short double-quoted fragment where no symbol fits — to a **path**, in one of two
shapes:

```
`determineRing` in `packages/db-p2p/src/storage/ring-selector.ts`
(`disputeEnabled`, `packages/db-p2p/src/dispute/types.ts`)
```

The convention is written up in `AGENTS.md` § Documentation citations. `scripts/check-doc-citations.mjs`
enforces it, wired as `yarn lint:docs` and chained into `yarn check` between `lint` and `build`. It
verifies four things across tracked markdown outside `tickets/` and `CHANGELOG.md`: no line-number
citations, every backticked path names a tracked file, every anchored citation's anchor is still
present in the file it names, and every doc-to-doc link and its `#section` resolves.

All 19 line-number citations across 10 documents were converted, every anchor re-derived from the
source at the time of the change. Steady state:

```
$ node scripts/check-doc-citations.mjs
check-doc-citations: 45 documents, 71 anchored citations, 572 file mentions, 307 links — all resolve.
```

## Review findings

### Checked

- **Read the implement diff (`62a32f69`) before the handoff summary**, then re-derived each claim
  independently rather than accepting the handoff's account of it.
- **Ran the full `yarn check` chain**, contrary to the handoff's expectation that build and tests
  were out of agent budget — they were not:
  - `yarn lint` — clean.
  - `node scripts/check-doc-citations.mjs` — clean.
  - `yarn typecheck` — 9 s, clean.
  - `yarn build` — 20 s, clean.
  - `yarn test` — **258 + 6 passing**, 6 m 23 s.
  - `yarn test:integration` — **fails when run straight after `yarn test`** (6 failures in
    `@optimystic/quereus-plugin-optimystic`); **passes standalone** (30 + 697 passing, 2 m 42 s),
    as does that workspace on its own (692 passing). Pre-existing and unrelated to this diff, which
    touches no TypeScript — written up in `tickets/.pre-existing-error.md`. Not skipped, not
    silenced.
- **Every converted anchor re-verified against source**, not just against the checker: the
  `ResumeV1`/`ResumeReplyV1` vs `BackfillV1`/`BackfillReplyV1` split in
  `packages/db-core/src/reactivity/resume.ts` and `backfill.ts`; `append` and `select` in
  `packages/db-core/src/collections/diary/diary.ts`; the `untrackBlock` call inside the
  `handleRebalanceEvent` branch of `packages/db-p2p/src/libp2p-node-base.ts`; the "single choke
  point" comment in `packages/db-p2p/src/storage/kv-raw-storage.ts` (the quoted block, including the
  restored `saveBlockProof`, matches the source verbatim modulo wrapping); the "proper-lockfile"
  TODO in the `FileRawStorage` constructor.
- **Deliberate-breakage matrix re-run after every change to the script**, covering all five finding
  classes: renamed symbol anchor, drifted quoted anchor, path pointing at a missing file,
  reintroduced line number, and a link naming a heading that does not exist. Each produced a
  finding naming the document, the line, and what was found instead; exit code 1; all findings
  printed, not just the first.
- **The handoff's three open questions**, each resolved below.

### Found and fixed in this pass

- **Fenced code blocks were never actually exempt.** `blankFences` walked the document and
  `continue`d on any line that did not itself look like a fence, so it blanked only the ``` ``` ```
  delimiter lines and left the block's *body* to be read as prose. Both the script header and
  `AGENTS.md` documented the opposite, and the fence was named as the one escape hatch for text
  that must keep a line number. Confirmed by putting `ring-selector.ts:79` inside a fence and
  watching it get reported. Fixed at the root: every line of an open block is blanked now. The
  fence delimiter pattern was also widened to allow leading `>` markers, so a fence nested in a
  blockquote is recognised — previously it was invisible, and its contents were checked as prose.
  - This also explains the handoff's note that `AGENTS.md` "fired three findings on its own example
    text". That was this bug, not a scoping problem. The examples were made real, which was the
    right call for other reasons, but it treated the symptom.
  - Consequence handled: with fences genuinely exempt, `AGENTS.md`'s own examples would have become
    unchecked. They were moved out of the fence into a blockquote so the document that defines the
    convention is still held to it — the anchored-citation count returns to 71.
- **Two dead external citations in `docs/transactions.md`.** The Phase-2 manifest cited
  `@quereus/quereus/src/vtab/context.ts` and `@quereus/quereus/src/execution/executor.ts`. Neither
  exists in the Quereus checkout this repository links against, and the `VirtualTableContext` type
  they were said to carry is not declared anywhere in it. The check could not see this — it skips
  package-scoped paths by design. Replaced with the one arm that is real
  (`@quereus/quereus/src/parser/parser.ts`) plus a plain statement that the rest was never built.
  The other three sibling-checkout paths cited nearby (`parser.ts`, `util/mutation-statement.ts`,
  `runtime/emit/dml-executor.ts`) were verified present.
- **`AGENTS.md` over-claimed what the check enforces.** It said the check "enforces all of the
  above" and that the fence exemption "is the only escape hatch there is". Neither is true: paths
  with a URI scheme, `../` sibling paths, `@scope/` external paths, anything under `tess/` or
  `tickets/`, and every extension outside `.ts/.tsx/.mts/.cts/.mjs/.md` are all skipped, and an
  anchor written in any third shape is never verified. Rewritten to state plainly what is checked
  and what is deliberately not — a convention document that misdescribes its own enforcement is the
  same failure mode this ticket exists to close.
- **`docs/transactions.md` `quereus-plugin-optimystic` file list** still used bare `src/…` paths
  while its neighbours had been made repo-relative. They resolved only by suffix match, and
  `src/types.ts` / `src/plugin.ts` match several packages. Made repo-relative.
- **`packages/db-p2p/readme.md`** named `p2p-fret` twice in one bullet. Tightened.
- **`run()` was 145 lines** carrying four inline check phases. Decomposed into `buildRepoIndex`,
  `checkLineNumbers`, `checkCitations`, `checkMentions`, `checkLinks` and `resolveLinkTarget`, each
  returning its own count; `run()` is now the loop and the reporting. Behaviour verified identical
  by re-running the breakage matrix and confirming the same counts.
- **Line lookup was O(document length) per call** — `text.slice(0, i).split('\n').length` — and was
  called for every link whether or not it produced a finding. Replaced with a precomputed
  line-start table and a binary search.

### Filed as a new ticket

- **`backlog/debt-external-citations-unverified`** — the `@scope/`-prefixed skip is a real blind
  spot, evidenced by the two dead Quereus paths above. Filed at the boundary-invariant rung rather
  than as a point fix: the ticket asks for the skip to stop being *silent* (report the count, and
  verify against a sibling checkout when one resolves), not for the two paths to be corrected. It
  carries the honest decline argument — verification depends on a developer's local layout, so a
  maintainer may reasonably prefer a visible count to a check that only sometimes runs.

### Recorded as tripwires, not tickets

- **Only inline `[text](target)` links are checked.** A link carrying a title (`](target "title")`)
  or written reference-style (`[text][ref]`) is silently skipped. Neither shape appears anywhere in
  the tree today; both were grepped for. `NOTE:` at `LINK_RE` in
  `scripts/check-doc-citations.mjs`.
- **The `@scope/` blind spot** is also marked at its site — a one-line `NOTE:` above the `npm-scope`
  rule in `skipReason`, pointing at the ticket, so the next reader meets it in the code rather than
  only on the board.
- The handoff's existing `NOTE:` above `findCitations` (a citation in a third connector shape
  degrades to an unverified mention) was re-read and left as it stands. It is accurate, and the
  reasoning against loosening the connectors into proximity matching holds.

### Considered and declined

- **No test harness for the script.** The handoff flagged this as a gap. Left as-is: root `scripts/`
  has none, `release-preflight.mjs` is the standing precedent, and the breakage matrix above is a
  five-case procedure any reviewer can run in under a minute. Adding a first test framework to
  `scripts/` for one lint script is not proportionate.
- **Anchors are matched by substring anywhere in the file**, so a symbol surviving only in a doc
  comment or a `{@link}` still passes. This is stated in the script and is the intended reading —
  the claim is "this name still exists in this file", not "it is defined here". No change.
- **`tickets/**` stays out of scope.** 254 line-number citations remain there; the exclusion is
  argued at the site and the ticket workflow already tells agents to re-derive line numbers. No
  change.

### Handoff questions, answered

- **Is `@optimystic/quereus-plugin-optimystic` the right successor to the dead
  `@optimystic/db-quereus` link?** Yes. Commit `2e95f44a` ("Split plugins.") deleted
  `packages/db-quereus` and created `quereus-plugin-crypto` and `quereus-plugin-optimystic`. The
  bullet describes "query engine and data access patterns", which is the latter — its own
  `package.json` describes it as the Quereus plugin for Optimystic distributed tree collections.
  The crypto half went to `quereus-plugin-crypto`, which is not a db-p2p-related package, so it was
  not added to that list.
- **Was removing the root `README.md` test-loop section the right resolution?** Yes. `START-HERE.md`,
  `TESTING-GUIDE.md` and `QUICK-REFERENCE.md` exist nowhere in the tree. Pointing at
  `packages/reference-peer/test/README.md` and `AGENTS.md` documents what actually exists; writing
  three new documents to satisfy three dead links would be inventing scope.
- **Does `yarn check` reach the end?** Everything up to and including `yarn test` does. The final
  `test:integration` step fails, but only in that position — see the pre-existing failure above.

### Empty categories

- **No security findings.** The change adds no runtime code path: the new script reads files and
  runs `git ls-files`, both read-only, and it never executes or fetches anything a document names.
- **No resource-cleanup findings.** The script is synchronous, opens no handles beyond
  `readFileSync`, and exits.
- **No type-safety findings.** It is plain `.mjs` by deliberate precedent
  (`scripts/release-preflight.mjs`), is outside every `tsconfig`, and `yarn typecheck` is unaffected
  by it.
- **No regressions in the converted prose.** Every anchor was re-checked against source, and no
  claim was found to have been weakened or lost in conversion — the one place where meaning had
  genuinely been ambiguous before (`docs/reactivity.md`, which of four codec types lived in which
  of two files) is now explicit and correct.
