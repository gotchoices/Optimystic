description: Doc-only correction of architecture.md overstatement — reactivity/matchmaking/cohort-topic reframed design-only + new Doc Sync Status table. Reviewed and accepted.
prereq:
files: docs/architecture.md
effort: low
----

## Summary

`docs/architecture.md` §"Cohort Topics, Reactivity, and Matchmaking" previously asserted "Two applications run on the substrate today:". That claim was false — the networked cohort-topic substrate, reactivity push-tree, and matchmaking directory are design-only. The implement pass:

1. Replaced the overstatement with explicit design-only / zero-implementation framing plus a simulator-phase note and forward links to the three specs.
2. Reframed the reactivity and matchmaking bullets as *designed* behavior.
3. Added a paragraph clarifying the only thing in code is the single-node, in-process `IBlockChangeNotifier` primitive, with the networked push-tree built on top of it.
4. Added an `### Implementation / Doc Sync Status` table (cohort-topic / reactivity / matchmaking × simulator / mock-tier e2e / real-libp2p e2e), all `pending`.

## Review findings

**Diff reviewed first** (`git show 41fdf9b`), then the handoff. Doc-only change to `docs/architecture.md` (20 lines); no source touched.

### Claim accuracy — checked, PASS
- **Design-only claim re-verified independently** (the implementer flagged this as relied-on-not-re-checked). Re-ran the wire-type grep: `git grep -E "RegisterV1|PromotionNoticeV1|CohortGossipV1|MembershipCertV1|NotificationV1|SubscribeAppPayloadV1|ProviderAppPayloadV1|QueryReplyV1|RouteAndMaybeAct" packages/` → **zero matches** (exit 1). The "zero implementation today" claim holds as of this SHA.
- **Local-primitive paragraph file paths/symbols all verified against the codebase**:
  - `CollectionChangeEvent` + `IBlockChangeNotifier` defined in `packages/db-core/src/transactor/change-notifier.ts` ✓
  - emitted on commit completion in `packages/db-p2p/src/storage/storage-repo.ts` (`changeListeners`, `onCollectionChange`, fires one `CollectionChangeEvent` per collection) ✓
  - `network-transactor.ts` forwards to optional `localChangeNotifier`, else a logged no-op (`network-transactor.ts:34/52/66/76-80`) ✓

### Forward links — checked, PASS
`docs/cohort-topic.md`, `docs/reactivity.md`, `docs/matchmaking.md` all exist.

### Residual overstatement — checked, PASS
Grepped for "run on the substrate today" → gone. The one remaining "fan out through" (L241) is now inside "are **designed to** fan out through…" — correctly hedged, not a present-tense claim. L239 "Two applications are designed to run on the substrate:" is acceptable framing.

### Markdown / table — checked, PASS
Doc Sync Status table is well-formed (4-column header + separator + 3 rows), all nine cells `pending`. Renders valid.

### Lint / tests — N/A, with reason
Doc-only change; no code, build inputs, or test files touched. `yarn build` / test suites are unaffected by a `.md` edit, so none were run. This is the correct disposition for a prose-only diff, not a skipped step.

### Findings
- **Major:** none.
- **Minor (fixed inline):** none required — the implementation matched the ticket spec exactly and all claims verified.

## Done when (met)
- Overstatement removed ✓
- Doc Sync Status table present, all-`pending` ✓
- Doc-only, no build/test impact ✓
- All factual claims independently re-verified against the codebase at HEAD ✓
