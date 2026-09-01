description: Our documentation points readers at exact line numbers in source files, and those pointers silently go wrong whenever the code is edited. Most of them are already wrong today. Adopt a citation style that survives edits, convert the documents to it, and add a check that catches new breakage.
files: scripts/check-doc-citations.mjs, scripts/release-preflight.mjs, package.json, AGENTS.md, docs/arachnode-ring-handoff.md, docs/architecture.md, docs/correctness.md, docs/internals.md, docs/matchmaking.md, docs/reactivity.md, docs/right-is-right.md, docs/transactions.md, docs/cohort-topic.md, README.md, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/README.md, packages/db-core/docs/logs.md, packages/substrate-simulator/README.md, packages/quereus-plugin-crypto/docs/crypto.md, packages/reference-peer/test/README.md
difficulty: medium
----

# Documentation citations of the form `file.ts:123` go stale silently

Prose documents cite source code by file *and line number*. Nothing verifies these. When the cited
file is edited above the cited line the citation still *looks* valid but points at unrelated code,
and the reader has no signal that it drifted.

The plan stage re-audited the tree and settled every open design question. This ticket is
execution: adopt the convention, convert the documents, land the check.

## Measured state (re-audited 2026-09-01 at commit `4adae8e9`)

The plan-stage audit table was re-derived from scratch and **confirmed exactly**: 19 line-number
citations covering 10 distinct targets; **6 of the 10 point at the wrong code**, 2 are off by a few
lines, 2 are exact. The per-target detail is reproduced in *Conversion map* below, with the correct
target re-verified for each.

Beyond the line numbers, measuring the whole citation surface turned up more:

- **591 path-shaped tokens** appear in the 45 in-scope documents. **535 resolve to exactly one
  tracked file**, 39 are ambiguous (dominated by bare `index.ts`, which matches 43 tracked files),
  17 do not resolve.
- Two of those 17 are **genuine rot that has nothing to do with line numbers**, which is what earns
  the path-existence half of the check its keep:
  - `packages/reference-peer/test/README.md` cites `packages/db-core/src/collections/diary.ts`; the
    file is `packages/db-core/src/collections/diary/diary.ts`.
  - Root `README.md` links to `packages/db-p2p/README.md`, but the tracked file is
    `packages/db-p2p/readme.md` — lowercase. Fine on Windows and macOS, **broken on Linux and in
    GitHub's web renderer**.
- Root `README.md` also links to `START-HERE.md`, `TESTING-GUIDE.md` and `QUICK-REFERENCE.md`.
  None of the three exists anywhere in the repository.
- `packages/quereus-plugin-crypto/docs/crypto.md` links to
  `../../../tickets/complete/4-cluster-signature-verification.md` — a ticket that is neither on the
  board nor in `tickets/.pruned-tickets.jsonl`.
- **35 citations already use the target convention** (symbol plus path). 24 verify clean; the other
  11 are the corner cases that drove the normalization rules below.

Three facts that shaped the design:

- **The prior repair did not hold.** An earlier review recorded `ring-selector.ts:79` and
  `file-storage.ts:52` as "repaired in place". Both are stale again. Re-derive every target; trust
  no prior claim, including this ticket's own table.
- **Doc-to-doc citations rot and hide it better.** `docs/matchmaking.md` reads
  `[cohort-topic.md:242](cohort-topic.md#topic-traffic-signal)`. The *link* resolves to the right
  section; the *visible text* names a line 136 lines off. Link-target checking alone would never
  catch this — the line-number ban is what catches it.
- **`packages/db-p2p-storage-fs/README.md` is one file.** A recursive grep on Windows reports both
  `README.md` and `readme.md`; `git ls-files` confirms a single tracked `README.md`. Do not "fix"
  a duplicate that is not there.

## The convention

Write this into `AGENTS.md`. Its **General** section already carries "also maintain the docs";
this belongs beside it. There is no separate docs style guide.

**A citation binds an anchor to a file.** Two forms, both already in house style:

```
`determineRing` in `packages/db-p2p/src/storage/ring-selector.ts`
(`disputeEnabled`, `packages/db-p2p/src/dispute/types.ts`)
```

- **The anchor is a symbol name** wherever one exists. A symbol survives edits above it, is
  greppable, and degrades to "search for this name" rather than to silently wrong.
- **Where no symbol fits** — a comment, a magic constant, a TODO — the anchor is a **short
  distinctive fragment in double quotes**: `` the "single choke point" comment in `…/kv-raw-storage.ts` ``.
  Only if neither a symbol nor a distinctive fragment is available, cite the *enclosing* symbol and
  say in prose which part is meant.
- **Line numbers never appear in prose.** Not singly, not as ranges.
- **Ranges are replaced by the enclosing symbol plus prose.** `:47-56` pointing at part of a method
  becomes the method name and a sentence saying which part.
- **Doc-to-doc references use section anchors**, and the visible text names the section, not a line:
  `[cohort-topic.md §Topic traffic signal](cohort-topic.md#topic-traffic-signal)`.
- **A file outside this repository must say so** by carrying its package or repo prefix —
  `@quereus/quereus/src/parser/parser.ts`, not a bare `parser.ts` that reads as ours.
- **Slash-alternation anchors are not permitted.** Write `encodeRecoverReplyV1` and
  `decodeRecoverReplyV1`, or cite the shared type, rather than `encode/decodeRecoverReplyV1`.

A bare filename in flowing prose — "`libp2p-node-base.ts` wires the services" — is a *mention*, not
a citation. It stays legal and is checked only for existence. This is deliberate: 290 such mentions
exist and 288 already resolve; forcing them all to full repo-relative paths would be ~982 edits of
pure churn and would make the prose worse.

## The check

New root-level script `scripts/check-doc-citations.mjs`, following `scripts/release-preflight.mjs`
as precedent: plain `.mjs`, no build step, no dependencies. Wire as `lint:docs` in the root
`package.json` and chain it into `check`. Do **not** fold it into `lint` — `lint` is `eslint .` and
should stay that.

### Scope

Tracked `*.md` files (`git ls-files`, never a filesystem walk — an untracked `node_modules` walk
pulls in thousands of vendored markdown files and was the first thing to mislead this audit),
minus:

- `tickets/**` — see the note below,
- `**/node_modules/**`,
- `**/CHANGELOG.md` (generated).

That is 45 files today. **Fenced code blocks are excluded from every check** — a fence is a literal
transcript or snippet, not prose making a claim about where code lives. Measured cost of this
carve-out today: zero. The line-number pattern appears 19 times in prose and 0 times inside fences.

`tickets/**` is excluded on purpose. Tickets carry hundreds of line-number citations and are
point-in-time work records — a ticket in `complete/` is *supposed* to describe the tree as it was.
Add a `NOTE:` at the exclusion in the script recording that active tickets in `backlog/`, `plan/`
and `fix/` do carry the same rot, that the ticket workflow already tells agents to re-derive line
numbers rather than trust them, and that if ticket citations ever start misleading agents in
practice the fix is to extend this scope rather than to write a second checker.

### Rules

**Path resolution.** Strip a leading `./`. A token resolves if it equals a tracked path or is a
suffix of exactly one tracked path at a `/` boundary. Package-relative forms like
`cluster/cluster-policy.ts` must keep working — 161 of the 301 slash-bearing tokens are
package-relative, and requiring repo-relative everywhere is churn this ticket does not want.

If a `.js`/`.mjs` token does not resolve, **retry it as `.ts`/`.tsx`**. This repo is
NodeNext-style TypeScript: import specifiers are written `./index.js` while the file on disk is
`index.ts`. Without this rule, docs that quote an import specifier fail spuriously.

**Skip a path token entirely** when it is not a claim about this repository:

- it carries a URI scheme (`http:`, `https:`, `file:`, `github:`),
- it starts with `../` (sibling repo — `../../Fret/docs/fret.md` is legitimate),
- its first segment is an npm scope (`@quereus/…`),
- it contains a `dist` or `node_modules` path segment (build output is untracked by design),
- it contains a glob or placeholder character (`*`, `<`, `>`, `{`, `}`, whitespace),
- it has no alphanumeric stem before the extension (`.d.ts` used as a category noun).

**Ambiguity.** More than one match is an error *only for an anchored citation*, where the checker
must know which file to search. A bare mention needs only one-or-more matches. This is a useful
forcing function: an author citing `index.ts` is told to add leading segments.

**Anchor verification.** Search the resolved file for the anchor:

- A double-quoted anchor is a literal substring search, whitespace-normalized. No reduction.
- A backticked anchor is tried literally first. If absent, reduce it — drop a leading `Qualifier.`
  chain, drop a `(…)` argument list — and require the remaining identifier. This reduction is
  required, not optional: it is what makes `ClusterCoordinator.executeTransaction`,
  `sourceBlockMeta()`, `TransactionBridge.addStatement`, `logBlockHashPayload(block)` and
  `buildNotificationV1(event, commitCert, ctx)` pass. All five name real symbols; the docs simply
  omit the type annotations the source carries.
- **An anchor that is itself path-shaped is not an anchor.** ``(`walk.ts`, `promotion.ts`)`` is a
  two-file list, not a citation. Without this rule it produces three false failures today.

**Doc-to-doc links.** Verify the target `.md` resolves, and that a `#anchor` matches a heading in
the target. Slugify headings the way GitHub does: strip characters that are neither word
characters, whitespace, nor hyphens, lowercase, then replace **each** remaining whitespace
character with a hyphen. **Do not collapse runs of whitespace.** An em-dash in a heading —
`## Part 1 — Damping the ring-shift decision` — leaves two adjacent spaces and therefore two
adjacent hyphens. Collapsing produced three false failures during the audit, and all three links
are in fact correct. Treat these as fixtures:

| Heading | Correct slug |
| --- | --- |
| `## Part 1 — Damping the ring-shift decision` | `part-1--damping-the-ring-shift-decision` |
| `#### Invariant P — a pending record and a committed record never coexist for one action` | `invariant-p--a-pending-record-and-a-committed-record-never-coexist-for-one-action` |
| `## Browser Bootstrap (WebSocket / WSS)` | `browser-bootstrap-websocket--wss` |

**Line-number ban.** Outside fences, any `name.(ts|tsx|js|mjs|md):<digits>` is an error. There is
**no allowlist and no per-citation escape marker**: the convention keeps zero line numbers, so an
exception mechanism would only be a place for drift to hide. The fence carve-out is the whole
escape hatch, and it is sufficient — a stack trace or tool transcript belongs in a fence anyway.

**Failure message.** Name the document, the line, the citation, and what was found instead. A
failure that only says "broken citation" costs the next person the entire audit again. Shape:

```
docs/arachnode-ring-handoff.md:47: line-number citation `ring-selector.ts:79`
  — cite a symbol instead: `determineRing` in `packages/db-p2p/src/storage/ring-selector.ts`
docs/foo.md:12: anchor "resolveClusterPolic" not found in packages/db-p2p/src/cluster/cluster-policy.ts
```

Exit non-zero on any finding; print every finding, not just the first.

## Conversion map

Every target below was re-verified at commit `4adae8e9`. **Re-derive each one again anyway** — these
line numbers will themselves have moved by the time the work runs. The anchors are the durable part.

| Document | Current citation | Convert to (anchor / path) |
| --- | --- | --- |
| `docs/arachnode-ring-handoff.md` | `ring-selector.ts:79` | `determineRing` / `packages/db-p2p/src/storage/ring-selector.ts` |
| `docs/arachnode-ring-handoff.md` | `libp2p-node-base.ts:982-988` | `untrackBlock` on the `handleRebalanceEvent` path / `packages/db-p2p/src/libp2p-node-base.ts` |
| `docs/architecture.md` | `…/collection.ts:502` | `randomBytes(16)` / `packages/db-core/src/collection/collection.ts` |
| `docs/correctness.md` ×5, `docs/right-is-right.md` ×1 | `dispute/types.ts:124` | `disputeEnabled` / `packages/db-p2p/src/dispute/types.ts` |
| `docs/correctness.md` ×2, `docs/right-is-right.md` ×1 | `dispute-service.ts:137` | `initiateDispute` / `packages/db-p2p/src/dispute/dispute-service.ts` |
| `docs/correctness.md`, `docs/internals.md` | `…/transactor-source.ts:36` | `randomBytes(32)` / `packages/db-core/src/transactor/transactor-source.ts` |
| `docs/matchmaking.md` | `[cohort-topic.md:242](…#topic-traffic-signal)` | visible text → `cohort-topic.md §Topic traffic signal` (link already correct) |
| `packages/db-p2p/docs/storage.md` | `…/kv-raw-storage.ts:47-56` | `"single choke point"` / `packages/db-p2p/src/storage/kv-raw-storage.ts` |
| `packages/db-p2p/docs/storage.md` | `…/file-storage.ts:466` | `FileRawStorage` / `packages/db-p2p-storage-fs/src/file-storage.ts` |
| `packages/db-p2p-storage-fs/README.md` | `file-storage.ts:52` | `"proper-lockfile"` / `packages/db-p2p-storage-fs/src/file-storage.ts` |

`randomBytes(16)` and `randomBytes(32)` are deliberately kept with their argument, and both match
the source literally. The distinction is the entire point of those two citations — do not reduce
them to a bare `randomBytes`.

**Convert the whole set, not a subset.** A document carrying two citation conventions is worse than
one carrying either; that is precisely why an earlier review left the mixed set alone.

### Other conversions the check will demand

- `packages/reference-peer/test/README.md` — `packages/db-core/src/collections/diary.ts` →
  `packages/db-core/src/collections/diary/diary.ts`.
- Root `README.md` — `packages/db-p2p/README.md` → `packages/db-p2p/readme.md`; and the three
  links to `START-HERE.md`, `TESTING-GUIDE.md`, `QUICK-REFERENCE.md`. Those files do not exist.
  Remove the links and the surrounding "automated test loop" pitch rather than inventing documents
  to satisfy them — but say so plainly in the handoff, since deleting a README section is a
  judgement call a reviewer should see.
- `packages/quereus-plugin-crypto/docs/crypto.md` — the link to
  `tickets/complete/4-cluster-signature-verification.md`. Docs should not link into `tickets/` at
  all; tickets are transient and get swept. Replace with a prose reference to the mechanism, or
  point at the relevant `docs/` section.
- `docs/transactions.md` lines ~1585–1628 — a historical change-manifest bullet list mixing Quereus
  files (`src/parser/parser.ts`, `src/vtab/context.ts`, `src/execution/executor.ts`,
  `dml-executor.ts`) with ours (`src/network-transactor.ts`, `src/transaction-validator.ts`).
  Give the Quereus ones their `@quereus/quereus/` prefix and the local ones their real
  repo-relative paths. A reader currently cannot tell which repository those files live in — this
  is a genuine readability win, not just check-appeasement.
- `docs/reactivity.md` — `encode/decodeRecoverReplyV1`: write both names or cite the
  `RecoverReplyV1` type.
- `docs/cohort-topic.md` and `packages/substrate-simulator/README.md` — the ``(`walk.ts`,
  `promotion.ts`)`` file-list constructs need no edit once the path-shaped-anchor rule lands.
  Verify, do not rewrite.

### While you are in `packages/db-p2p/docs/storage.md`

The block quote at the `kv-raw-storage.ts` citation reproduces the source comment as
"saveMetadata / saveRevision / save\*Transaction / saveMaterializedBlock". The comment in the code
reads "saveMetadata / saveRevision / save\*Transaction / **saveBlockProof** / saveMaterializedBlock".
The quotation has dropped a method. Fix the quote — it is one word, you are already editing that
line, and a misquotation is a pointer-fidelity defect of exactly the kind this ticket exists to
remove. Broader prose accuracy stays out of scope.

## Edge cases & interactions

- **Windows path separators.** `git ls-files` yields forward slashes; `node:path` on Windows will
  hand back backslashes if used carelessly. Normalize to `/` before any suffix comparison, or the
  check passes locally and fails in CI.
- **Case-insensitive filesystem.** `packages/db-p2p/readme.md` vs `README.md` is the bug this
  finds; the checker must therefore compare **case-sensitively** against `git ls-files` output,
  never via a filesystem `existsSync`, which would report the wrong answer on Windows and macOS
  and silently mask the class.
- **Fence detection.** Handle both ``` and ~~~ fences, and fences opened with more than three
  characters. Blank the fenced region rather than deleting it, so reported line numbers stay
  correct — an off-by-N failure message re-imposes the audit cost the message exists to avoid.
- **Inline code spans containing a fence-like sequence**, and fences nested inside list items
  (indented fences). An unterminated fence must not blank the rest of the file and silently pass.
- **A citation split across a line break.** ``the single source of truth is `logBlockHashPayload(block)` in\n`packages/db-core/src/log/log.ts` `` occurs today in `packages/db-core/docs/logs.md`. The
  form-matching regex must tolerate a newline between anchor and path, or it silently skips real
  citations — a false *pass*, which is worse than a false failure because nothing signals it.
- **Anchor found only inside a comment.** `sourceBlockMeta` appears in a `{@link}` doc comment as
  well as at its definition. Substring search accepts either. That is the intended looseness — the
  check is "this name still exists in this file", not "this name is defined here".
- **Self-referential documents.** `AGENTS.md` will itself contain the example citations and the
  banned-pattern illustration. Whatever example text goes in must either be inside a fence or use
  a form the checker accepts, or the check fails on the document that defines it. Verify this
  explicitly — it is the most likely way to land a red `check`.
- **This ticket and the plan ticket** contain many `file.ts:123` strings. They live under
  `tickets/`, which is out of scope. Confirm that exclusion actually works rather than assuming it.
- **Empty result set.** If the scope filter is wrong the checker inspects zero files, finds zero
  problems, and reports success. Fail loudly if the in-scope file count is zero, and print the
  count on success so a silently-empty run is visible.
- **`git ls-files` unavailable** (a tarball export, no git). Report and exit non-zero rather than
  passing vacuously.

## Tests

No test framework covers root `scripts/` today, and `release-preflight.mjs` sets the precedent of
an unrested script. Do not stand up a harness for this. Verify by construction instead, and record
the results in the handoff:

- Run against the converted tree: passes, and prints the number of documents and citations checked.
- Break one citation deliberately (rename an anchor in a scratch copy, or point a path at a file
  that does not exist), confirm the exit code is non-zero and the message names document, line,
  citation and what was found. Restore it.
- Confirm the three GitHub-slug fixtures in the table above resolve as *passes*, not failures.
- Confirm `tickets/` line-number citations do not trip the check.
- Confirm `yarn check` still reaches the end.

Expected steady state: the enumeration from the plan ticket

```bash
git ls-files '*.md' | xargs grep -noE '[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|md):[0-9]+(-[0-9]+)?'
```

returns hits only under `tickets/`.

## TODO

- Write the convention into `AGENTS.md` beside the existing "also maintain the docs" guidance —
  the two citation forms, the quoted-fragment fallback, no line numbers, no ranges, doc-to-doc
  section anchors, external files carry their package prefix, no slash-alternation anchors.
- Add `scripts/check-doc-citations.mjs`: scope via `git ls-files`, blank fenced blocks, then apply
  the path-resolution, anchor-verification, doc-to-doc link and line-number-ban rules above.
- Include the `NOTE:` recording why `tickets/**` is excluded and what would justify extending it.
- Convert the 19 line-number citations per the conversion map, re-deriving each target.
- Fix the non-line-number breakage: `diary.ts` path, the four root-`README.md` links, the
  `crypto.md` ticket link, the `transactions.md` manifest paths, the `reactivity.md`
  slash-alternation anchor.
- Correct the dropped `saveBlockProof` in the `storage.md` block quote.
- Add `lint:docs` to the root `package.json` and chain it into `check`; leave `lint` as `eslint .`.
- Run the verification list above; confirm the enumeration command returns only `tickets/` hits.
- Hand off to `review/` naming anything left undone — in particular whether the root `README.md`
  test-loop section was removed or otherwise resolved.
