description: Fixed several places in the design docs where they disagreed with each other (and with the code) about how many machines must confirm a write, the smallest supported group size, and whether Optimystic targets one shared network or lets anyone build their own — this is a docs-only change, no code touched.
files:
  - docs/correctness.md (Theorem 6 rewritten ~line 197-224; §2 "Commit durability reporting" cohort disambiguation ~line 64; §7.5 K=3 fix ~line 516; §8 item 10 reworded ~line 554)
  - packages/db-p2p/docs/cluster.md (top-of-file cohort terminology note ~line 5; Phase 2 clarifying paragraph ~line 268-270)
  - packages/db-p2p/docs/repo.md (Phase 1/2 pseudocode replaced with pointers ~line 178-187; new "Responsibility K and the redirect-skip check" section ~line 313-326; "Distributed Consensus Algorithm" section rewritten ~line 328-334)
  - docs/architecture.md (new "substrate, not a network" paragraph in the intro, ~line 5)
  - docs/optimystic.md (matching one-line pointer in the intro, ~line 5)
  - docs/cohort-topic.md (disambiguation added to its own "Cohort" definition, ~line 44)
difficulty: easy
prereq:
----

# What changed

Ticket `docs-one-durability-bar-one-size-floor` found the same three facts stated inconsistently
across five docs. All fixes are docs-only — verified against the current code before writing, no
source files touched.

## Fact 1 — the bar for acknowledging a write

The write path actually has **three distinct checkpoints**, not one, and the docs previously
conflated them:

1. **Promise-phase super-majority** (`⌈superMajorityThreshold·K⌉`, default 0.75) — blocking, throws
   on shortfall. This is the practically-binding constraint.
2. **Commit-phase signature majority** (`⌊simpleMajorityThreshold·K⌋+1`, default 0.51, equivalent to
   a strict majority for integer K) — non-blocking, does not throw on shortfall.
3. **The acknowledgement gate** — a strict majority of the cohort must report, *after each member's
   own storage reconcile*, that it durably holds the revision. This is the one that actually decides
   what the coordinator tells the writer. A shortfall returns a retryable conflict, never a false
   success.
4. **n=1 (`commitSolo`)** skips all of the above — a distinct code path, not a degenerate case of the
   general gate.

`docs/correctness.md` Theorem 6 was rewritten to state this three-checkpoint pipeline plus a
size-consequence table (n=1..4), and now **points to** — rather than restates — the existing
"Commit durability reporting" definition in §2, which was already accurate. `cluster.md`'s Phase 2
section and `repo.md`'s Phase 1/2 pseudocode (which was stale — it showed a plain majority for the
*promise* phase, contradicting both the real super-majority check and Theorem 6) got clarifying
pointers back to Theorem 6 and to `cluster.md`'s own Phase 1/2 headings.

`repo.md`'s "Distributed Consensus Algorithm" section — which falsely claimed "atomicity across
distributed operations" and "rollback mechanisms for partial failures" — was replaced with a short
paragraph pointing at `cluster.md` for the 2PC mechanics and explicitly stating **no cross-collection
undo** (Theorem 3 is authoritative), rather than silently dropping the false rollback claim.

## Fact 2 — the smallest supported group size

Already correct in `architecture.md`, `optimystic.md`, and `cluster.md` (lines 944-954 /
1086-1089, both left untouched as instructed). The one holdout was `correctness.md` §7.5, which said
"K=3 is minimum" — contradicts the settled decision (ticket `small-cohort-arming-rule`). Reworded to
point at `architecture.md`'s "Supported deployment sizes" section instead of asserting a floor.

## Fact 3 — substrate vs. one network

No doc stated plainly that Optimystic is a substrate for building independent networks of any size,
rather than being built around one particular well-known network. Added one paragraph to
`architecture.md`'s intro and a matching one-line pointer to `optimystic.md`'s intro. Nothing existed
to contradict here — this closes a gap by omission, not a contradiction.

## Fact 4 — smaller items found in the same pass

- **4a.** `correctness.md` §8 guarantee item 10 claimed integrity was "unconditionally verifiable",
  contradicting Theorem 15 (conditional on multi-peer comparison under honest majority). Reworded to
  match Theorem 15's actual, conditional guarantee.
- **4b.** Covered by the Fact 1 `repo.md` rewrite above — the "no cross-collection undo" language is
  explicit so a future reader doesn't wonder why the rollback claim disappeared.
- **4c.** "Cohort" means two different things in this codebase: a block's small cluster/replica-set
  (`cluster.md`, `correctness.md`) vs. the ~16-peer FRET topic-forwarding group (`cohort-topic.md`).
  Added a one-line disambiguation at each doc — **judgment call for the reviewer**: for `cluster.md` I
  used a top-of-file blockquote ("Terminology.") rather than an inline parenthetical at the literal
  first occurrence of the word (which is a throwaway phrase, "the cohort did not answer", a bad anchor
  for a definition). For `correctness.md` and `cohort-topic.md` I followed the ticket's literal
  instruction and inserted inline parentheticals at the specific sites named. If the reviewer prefers
  all three sites use the same style, that's a one-line style tweak, not a substance change.
- **4d.** `responsibilityK` had no documentation at all. Added a new section to `repo.md` (verified
  against `libp2p-node-base.ts:243-253`, `repo/service.ts:244`, `cluster/service.ts:177`): what it is,
  its default (1, effectively a no-op at that default since `smallMesh` only fires for an empty
  cluster), and what raising it does.

# Note on the ticket's `files:` list

The ticket listed `packages/db-p2p/docs/cohort-topic.md`, but that file does not exist — the real path
is `docs/cohort-topic.md` (confirmed via `Glob`). Edited the file that actually exists; flagging in
case the stale path was itself worth a tripwire, but this is a one-off ticket-authoring slip, not a
codebase issue.

# Verification performed

- `grep -rn "75%" docs/ packages/*/docs/` — every remaining hit describes the *promise-phase*
  super-majority (Theorem 2 partition safety, Theorem 10 Byzantine tolerance, `cluster.md`'s attack
  mitigation section, `repo.md`'s new Phase 1 pointer, `partition-healing.md`). None describe it as
  "the bar for reported success."
- `grep -rn "K=3" docs/ packages/*/docs/` — no matches (the only prior occurrence, `correctness.md:502`,
  is fixed).
- Checked every new cross-reference anchor (`#theorem-6-durability`,
  `#supported-deployment-sizes--one-machine-and-two-are-ordinary-not-degenerate`,
  `#phase-1-promise-collection-super-majority-required`,
  `#phase-2-commit-execution-simple-majority-required`) against the actual heading text with `grep -n
  "^###"` in the target files, and against an identical anchor already used elsewhere in the repo
  (e.g. `optimystic.md:275`, `quereus-plugin-crypto/docs/crypto.md:290`) to confirm slug format.
- Confirmed the untouched sections (`architecture.md` Supported deployment sizes,  `optimystic.md`
  Deployment Sizes, `cluster.md` lines ~944-954 / ~1086-1089) are byte-identical before/after aside
  from the expected line-number shift from earlier edits in the same file.
- Re-read Theorem 6 end-to-end after editing: it is now strictly shorter than before per line of new
  information and points at, rather than duplicates, the §2 "Commit durability reporting" mechanism.

# What the reviewer should double-check

- No markdown linter exists in this repo (noted in the ticket itself) — anchor correctness above was
  verified by hand-matching generated GitHub-style slugs; if any target heading text changes later,
  these links break silently. This is the same tradeoff the ticket itself accepted for pre-existing
  cross-references.
- This is a prose/judgment task with no automated test coverage possible — "correctness" here means
  "matches the code as verified by reading it, and matches itself across docs," not something a test
  suite checks. I re-verified every code claim (thresholds, defaults, `commitSolo`, `responsibilityK`)
  against the actual source at the line numbers cited in the ticket before writing.
- The Fact 4c style inconsistency noted above (blockquote vs. inline parenthetical) is the one place
  I deviated from the ticket's literal wording, for readability reasons stated above — worth a quick
  read to confirm it's an acceptable call.

## Review findings

Read the implement diff (7514e2a6) first, then verified its code claims against source.

**Checked and confirmed accurate:** promise-phase `Math.ceil(peerCount * superMajorityThreshold)` (`cluster-repo.ts:990`) and the n=1..4 table arithmetic; commit-round strict-majority check (`commit-proof.ts:224`); `commitSolo` dispatch (`coordinator-repo.ts:2505`); `responsibilityK ?? 1` and `smallMesh = … < responsibilityK` on both repo (`repo/service.ts:244`) and cluster (`cluster/service.ts:177`) paths; every new anchor (`#theorem-6-durability`, architecture.md supported-sizes slug, cluster.md phase headings) matches its heading; Theorem 2/3/7/14/15 references point at the right theorems. Grepped docs and package docs for leftover stale claims ("unconditionally verifiable", "rollback mechanisms", "K=3 is", "return success to the client") — none remain.

**Minor, fixed inline (docs/correctness.md Theorem 6):**
- Node-crash sentence claimed a `full`/`majority` acknowledgement "names a surviving quorum" — overclaims, since a crash can remove members of that majority. Reworded to what actually holds: a strict majority held the revision durably at answer time, so the revision survives any crash leaving one holder, and the drain restores the rest.
- "Promise super-majority is always ≥ the acknowledgement strict majority" is only true for thresholds above one half; qualified it (threshold is configurable via `clusterPolicy.superMajorityThreshold`).
- The n=1 paragraph omitted that `commitSolo` is also taken when the cohort never resolved (the `unrouted` case); added.

**Style judgment call (cluster.md top-of-file blockquote vs inline parentheticals):** accepted — the first literal occurrence in cluster.md is a poor anchor for a definition; no change.

**Major findings:** none — docs-only change, no code site involved.

**Tripwires:** none new. The implementer's note that hand-verified anchors break silently if headings are renamed is an existing, accepted condition (no markdown link checker in the repo); not re-parked.

**Tests/lint:** not run — no source files changed by either implement or review; nothing for the suite to exercise.
