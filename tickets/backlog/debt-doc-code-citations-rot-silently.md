description: Our written documentation points at specific line numbers in the source code, and those pointers quietly go wrong every time someone edits the code. A reader following one lands on unrelated code and has no way to tell it is wrong. We should stop hand-maintaining them and let a check catch the bad ones.
files: docs/correctness.md, docs/right-is-right.md, docs/arachnode-ring-handoff.md, packages/db-p2p-storage-fs/readme.md, packages/db-p2p/docs/cluster.md
difficulty: medium
tradeoffs: A checker is real machinery (a parser, a build/CI step, and a decision about what counts as a valid citation) to solve a problem that a reader can usually work around by grepping for the nearby symbol name — a maintainer could reasonably say "just stop writing line numbers" and rely on review discipline instead.

# Documentation citations of the form `file.ts:123` go stale silently

## The problem

Several prose documents cite source code by file *and line number* — for example
"`(dispute-service.ts:137)`". Nothing verifies these. When the cited file is edited above the cited
line, the citation still *looks* valid but now points at unrelated code. A reader has no signal that
it drifted; they read whatever is at that line and draw a wrong conclusion.

This is not hypothetical. A sweep during review of `bug-docs-out-of-date-with-code` found **7 such
citations across the documentation, of which 3 were already pointing at the wrong code**:

| Citation | What the doc claims is there | What is actually there |
| --- | --- | --- |
| `cluster-coordinator.ts:312-332` (cited from two documents) | the code that flags a commit as disputed | the start of a different method; the disputed-flag code had moved ~65 lines later |
| `ring-selector.ts:79` | a value computed from an instantaneous statistics snapshot | a constructor parameter list |
| `file-storage.ts:52` | a TODO comment about integration | an unrelated explanatory comment |

The three stale ones were repaired in place during that review (the two `cluster-coordinator` sites
by replacing the line number with a file-plus-symbol reference). The remaining four happened to still
be accurate — but only by luck, and they will rot the same way.

## What we want

Stop relying on humans to notice. Two complementary directions, either or both:

- **A guard.** Something that reads the documentation, finds citations of the form
  `<file>:<line>` or `<file>:<start>-<end>`, and fails when the file does not exist. A stronger
  version would also require the citation to name a symbol that actually appears near the cited line,
  which is what makes drift (as opposed to deletion) detectable. It should be runnable locally and in
  CI, and its failure message should say which document, which citation, and what it found instead.
- **A convention.** Prefer citing **file plus symbol name** (`resolveClusterPolicy` in
  `packages/db-p2p/src/cluster/cluster-policy.ts`) over file plus line number. A symbol reference
  survives edits above it and is greppable, so it degrades to "search for this name" rather than to
  "silently wrong". Whichever convention is chosen should be written down where doc authors will see
  it.

A reasonable outcome is: adopt the symbol convention, convert the existing line-number citations to
it, and keep a lightweight check that fails on any *new* line-number citation — which makes the
convention self-enforcing instead of a rule people forget.

## Scope note

This is about citations *from prose documents into source code*. Line references inside source code
comments are a separate (and less severe) case — they live next to the code they cite and move with
it under review — and are not part of this ticket unless the same check happens to cover them for
free.
