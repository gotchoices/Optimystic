description: Our documentation points readers at exact line numbers in source files, and those pointers silently go wrong whenever the code is edited. Most of them are already wrong today. Decide on a citation style that survives edits, convert what exists, and add a check that catches new breakage.
files: scripts/release-preflight.mjs, package.json, AGENTS.md, docs/arachnode-ring-handoff.md, docs/architecture.md, docs/correctness.md, docs/internals.md, docs/matchmaking.md, docs/right-is-right.md, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/README.md
difficulty: medium
----

# Documentation citations of the form `file.ts:123` go stale silently

## The problem

Prose documents cite source code by file *and line number* — for example
``the constructor carries a TODO (`file-storage.ts:52`)``. Nothing verifies these. When the cited
file is edited above the cited line, the citation still *looks* valid but now points at unrelated
code. The reader has no signal that it drifted; they read whatever sits at that line and draw a wrong
conclusion.

## Measured state of the tree (audited 2026-09-01, at commit `ff40a02d`)

Enumerate every citation with:

```bash
grep -rnoE '[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|md):[0-9]+(-[0-9]+)?' --include='*.md' docs packages | grep -v node_modules
```

That returns **19 occurrences covering 10 distinct targets**. Each target was opened and compared
against what the surrounding prose claims is there:

| Target cited | Cited from | Prose claims it is | What is actually at that line | Verdict |
| --- | --- | --- | --- | --- |
| `ring-selector.ts:79` | `docs/arachnode-ring-handoff.md:47` | `RingSelector.determineRing()` | a constructor parameter list; `determineRing` is at line 95 | **wrong** (16 off) |
| `libp2p-node-base.ts:982-988` | `docs/arachnode-ring-handoff.md:51` | the `untrackBlock` release on the cohort-churn path | `coordinatorRepoFactory({…})` wiring; the `untrackBlock` calls are at 1242 and 1284 | **wrong** (~260 off) |
| `collection.ts:502` | `docs/architecture.md:67` | `randomBytes(16)` generating an `ActionId` | a doc comment about pending-action mapping; `randomBytes(16)` is at line 905 | **wrong** (403 off) |
| `kv-raw-storage.ts:47-56` | `packages/db-p2p/docs/storage.md:39` | the "single choke point" comment about value writes | constructor tail plus the head of `getMetadata`; the quoted comment is at line 63 | **wrong** |
| `cohort-topic.md:242` | `docs/matchmaking.md:434` | "per-topic counters reset on rotation" | simulator scale-sweep results; the claim is at line 378 under `## Topic traffic signal` | **wrong** (136 off) |
| `file-storage.ts:52` | `packages/db-p2p-storage-fs/README.md:111` | the `proper-lockfile` TODO | an unrelated explanatory comment; the TODO is at line 59 | **wrong** (7 off) |
| `file-storage.ts:466` | `packages/db-p2p/docs/storage.md:249` | `class FileRawStorage` | a comment about re-declared methods; the class is at 470 | near-miss (4 off) |
| `transactor-source.ts:36` | `docs/correctness.md:46`, `docs/internals.md:555` | `randomBytes(32)` | the comment line immediately above it; the call is at 37 | near-miss (1 off) |
| `dispute/types.ts:124` | `docs/correctness.md` ×5, `docs/right-is-right.md` ×1 | `disputeEnabled: false` | exactly that | accurate |
| `dispute-service.ts:137` | `docs/correctness.md` ×2, `docs/right-is-right.md` ×1 | `async initiateDispute(…)` | exactly that | accurate |

**Six of ten distinct targets point at the wrong code right now.** Two more are off by a few lines
(they land on a comment adjacent to the thing being cited — harmless today, wrong after the next
edit). Only two are exact.

Three facts worth carrying into the design:

- **The prior repair did not hold.** The backlog ticket this came from recorded that
  `ring-selector.ts:79` and `file-storage.ts:52` were "repaired in place" during an earlier review.
  They are stale again (or were never repaired). Re-verify every citation from scratch; do not trust
  any prior claim that a given one is correct.
- **Doc-to-doc citations rot too, and hide it better.** `docs/matchmaking.md:434` reads
  `[cohort-topic.md:242](cohort-topic.md#topic-traffic-signal)` — the *link* resolves fine to the
  right section, but the *visible text* names a line number that is 136 lines off. Any check must
  look at citation text, not only at link targets.
- **`packages/db-p2p-storage-fs/README.md` is one file, not two.** A recursive grep on Windows
  reports both `README.md` and `readme.md`; `git ls-files` confirms a single tracked `README.md`.
  Do not "fix" a duplicate that is not there.

## What we want

Three things, in this order:

### 1. Settle the convention

Decide what a citation into source should look like, and write the decision down where doc authors
and agents will meet it — `AGENTS.md` is the file this project's contributors and agents actually
read (its **General** section already carries "also maintain the docs"); there is no separate docs
style guide.

The strong candidate is **file plus symbol name** — ``resolveClusterPolicy` in
`packages/db-p2p/src/cluster/cluster-policy.ts`` — because a symbol survives edits above it, is
greppable, and degrades to "search for this name" rather than to "silently wrong". Note that
`docs/correctness.md` *already* uses this style for most of its references; the line-number ones are
the minority, which makes conversion mostly a matter of finishing a job already half done.

Open questions the plan should answer, not defer:

- What about a citation whose target has no symbol — a comment, a magic constant, a TODO? Three of
  the stale ones above are exactly this. Options: cite the enclosing symbol instead, quote a short
  distinctive fragment of the line, or allow a line number in this case and accept that it will rot.
- Do line **ranges** (`:47-56`, used to point at part of a method) survive the convention, or do they
  become "the method name plus a prose description of which part"?
- Doc-to-doc references: mandate section anchors (`file.md#section`), which is what the one existing
  doc-to-doc citation already links to correctly.

### 2. Convert what exists

All 19 occurrences, using the audit table above as the starting map — but re-derive each target
rather than trusting the table's line numbers, which will themselves be stale by the time the work
runs. **Convert the whole set, not a subset**: a document carrying two citation conventions is worse
than one carrying either, which is why an earlier review deliberately left the mixed set alone.

### 3. Add the check

A script that fails when a citation is broken, runnable locally and in CI. Design constraints:

- **Hook point.** `scripts/release-preflight.mjs` is the precedent for a root-level Node script (89
  lines, plain `.mjs`, no build step). The root `package.json` has `lint`, `build`, `typecheck`,
  `test`, `test:integration`, and a `check` that chains them. A new `lint:docs` folded into `check`
  is the obvious shape; whether it also belongs in `lint` is a plan decision.
- **What it must catch.** At minimum: a cited file that does not exist. That alone would not have
  caught a single one of the six failures above — every stale citation names a file that still
  exists. So the check earns its keep only if it verifies the *content*, which is exactly what the
  symbol convention makes possible: for a "symbol in file" citation, assert the symbol appears in
  the file. Cheap (a search for the name), no parser required, and it fails loudly on the
  rename-and-move case that broke these six.
- **Catch regressions.** Fail on any *new* line-number citation, so the convention enforces itself
  instead of relying on reviewers remembering it. Decide how a deliberate exception is expressed —
  an allowlist file, or a marker in the prose — if the convention keeps line numbers for any case.
- **Failure message.** Name the document, the line, the citation, and what was found instead. A
  failure that only says "broken citation" costs the next person the same audit that produced the
  table above.

## Scope

- In scope: citations *from prose documents into source code*, and from prose documents into other
  prose documents.
- Out of scope: line references inside source-code comments. They live next to the code they cite
  and move with it under review. Include them only if the same check covers them for free.
- Out of scope: the accuracy of what the documents *say*. This ticket is about pointers landing where
  they claim to, not about whether the surrounding prose describes the system correctly.

## Done when

- The convention is written down in `AGENTS.md`.
- The enumeration command above returns nothing that the convention does not explicitly permit.
- The check runs from the repository root, fails on a deliberately-broken citation, and passes on the
  converted tree.
