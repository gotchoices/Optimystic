description: A collection's conflict-merge hook could rewrite a pending change, but the rewrite was thrown away and the un-merged original kept instead — now fixed so the rewrite actually replaces the original and takes effect.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts, packages/db-core/docs/collections.md
----
## Summary of the fix (as implemented)

`filterConflict` is the conflict-merge hook on a `Collection`. For each local pending action
that may conflict with a remote one, it returns: the **same** instance (keep), a **new**
instance (apply this replacement instead), or `undefined` (discard). The replacement path was
broken:

1. `doFilterConflict` pushed the replacement onto `this.pending` past the range `map()` walked,
   then the mapped result overwrote `this.pending` — so the replacement was lost.
2. It returned `true` on the replacement path, so the *original* was also kept — the opposite of
   the contract.
3. Subtler: a replacement could occur with no real block conflict, leaving `anyConflicts` false,
   so `replayActions()` never ran and the tracker's staged block transforms still reflected the
   **original** action — the committed log said `merged` but the committed blocks were `local`.

The implementation (commit `2bd7c40`) rewrote `doFilterConflict` to return
`Action<TAction> | undefined`, changed `updateInternal`'s per-entry map to keep the effective
action (original / replacement / dropped) in place, and added a `mutated` flag that forces a
replay whenever filtering changed the pending set — closing gaps 1–3 and the old discard-orphan
wart. Docs (`collections.md`) updated to match.

## Review findings

Adversarial pass over commit `2bd7c40` (implement stage). Read the diff first, then the
surrounding `updateInternal` / `replayActions` / `doFilterConflict` code, the transactor test
harness, and every doc the change touched.

### Correctness — verified sound
- Traced the `mutated` logic across all cases (replace, discard, replace+discard mix, multi-entry
  re-filtering). Length-differs catches every drop; identity-mismatch catches every replace;
  when lengths are equal the map is 1:1 so index alignment holds. No false negatives.
- Confirmed a replacement produced against remote entry N is correctly re-offered to the hook for
  entry N+1 and left unchanged when it no longer matches — no double-rewrite, no drop.
- `doFilterConflict` return type now matches the `filterConflict` field signature
  (`Action<TAction> | undefined`); the only call site and the doc snippet were both updated.
  Grep confirmed no other caller relied on the old boolean.

### Test coverage — one real gap, fixed inline (minor)
- The implementer flagged that the four existing conflict tests assert only via `selectLog`
  (log-level), not block-level effects. **Confirmed this is a genuine hole and that it hides the
  load-bearing part of the fix:** the existing "returns a rewritten action" test passes *even if
  the `mutated`-forced replay is removed*, because the map assigns the replacement into `pending`
  directly — the log gets `merged` regardless of replay. The bug the replay actually guards is
  block-level divergence (tracker keeps the original's block transform while pending says merged).
- **Fixed inline:** added `should commit the replacement block effects, not the original` to
  `test/collection.spec.ts`. It uses a handler that embeds the action's value into the inserted
  block, then inspects `transactor.getCommittedActions()` to assert the committed block content
  carries `merged` and never `local`. **Proven to be a real guard:** temporarily removing
  `mutated ||` from the replay trigger makes exactly this new test fail (committed block carries
  `local`, never `merged`) while the old log-only test still passes. Restored `mutated`; suite green.

### Docs — accurate, verified
- `docs/collections.md` update-process snippet matches the new map + `mutated` logic; the
  `filterConflict` type and the three-way (undefined / original / modified) contract are both
  documented correctly. No stale boolean semantics remain.

### Tripwire — no action (recorded, not filed)
- `mutated` compares by reference identity (`after[i] !== before[i]`), matching the documented
  "same instance = keep, new instance = replace" contract. A hook that always allocates a
  fresh-but-equal instance would force a replay every update. Conditional, not a defect —
  already parked as a `NOTE:` at the site (`collection.ts`, the `mutated` line) by the implementer.
  Left as-is.

### Out-of-scope defect surfaced — filed as backlog
- Running a **single** db-core spec file in isolation crashes at load with
  `Cannot access 'collectionTypes' before initialization` — a barrel-file circular-import / TDZ
  hazard between `diary.ts` (module-eval `registerCollectionType` call) and
  `collection-type-registry.ts` (module-scope `const collectionTypes`). Pre-existing, unrelated to
  this change, and dodged by the full-suite glob (different load order). Deterministic on the
  single-file path, so a real latent defect, not a tripwire — filed as
  `backlog/debt-db-core-single-spec-import-cycle`. Did **not** write `.pre-existing-error.md`: the
  full glob the runner uses passes cleanly, so nothing blocked this ticket.

## Validation performed (review)

From `packages/db-core/`:
- Full suite: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min`
  → **1069 passing, 0 failing** (was 1068; +1 = the new block-effects test).
- Typecheck: `node_modules/.bin/tsc --noEmit` → exit 0, clean. (No ESLint config or lint script
  exists in this repo; tsc is the type gate. Prettier is a dev dep but not CI-enforced.)
- Guard proof: with `mutated ||` removed from the replay trigger, the suite dropped to
  1068 passing / **1 failing** — precisely the new test — then restored to green.
