description: Clarify the d_max confidence-clamp semantics in cohort-topic.md (and the simulator's computeDMax). The low-confidence clamp is implemented as an unconditional *assignment* to ⌊d_max_cap/2⌋ (=30), which can INFLATE d_max for small/low-confidence populations rather than capping it — contradicting the doc's stated intent ("to avoid pathological deep probes"). Decide whether the clamp is a literal set-to-30 or an upper bound min(formula, 30), then align doc + simulator + production.
prereq:
files:
  - docs/cohort-topic.md
  - packages/substrate-simulator/src/size-model.ts
  - packages/substrate-simulator/test/fret-model.spec.ts
----

# d_max confidence-clamp: literal assignment vs. upper bound

`cohort-topic.md` §Maximum useful depth states:

> `d_max = max(0, ⌊log_F(n_est)⌋ − 1)`. If `n_est` confidence falls below `confidence_min`
> (default 0.3), participants clamp to `d_max = ⌊d_max_cap / 2⌋` **to avoid pathological deep probes**.

The simulator's `computeDMax` (size-model.ts) implements this literally:

```ts
if (confidence < cfg.confidenceMin) {
  return Math.floor(cfg.dMaxCap / 2);   // == 30, unconditionally
}
```

## The concern

The stated motivation is to **avoid** pathological *deep* probes — i.e. the clamp is meant to
protect against an over-estimated `n_est` (large, low-confidence sample) pushing `d_max` very
deep. But an unconditional assignment to 30 does the opposite at the **low** end:

- A single-peer population (FRET reports `confidence = 0.2 < 0.3`) yields `d_max = 30`, even
  though the formula would give `0`. The review test `fret-model.spec.ts` currently *codifies*
  this (`expect(model.size.dMax(...)).to.equal(30)`).
- Any small-but-low-confidence network is pushed to `d_max = 30` — the very "pathological deep
  probe" the clamp claims to prevent.

If the word "clamp" was intended as an **upper bound**, the correct form is:

```ts
const formula = Math.max(0, Math.floor(Math.log(nEst) / Math.log(F)) - 1);
return confidence < confidenceMin ? Math.min(formula, Math.floor(dMaxCap / 2)) : formula;
```

…which leaves small networks at their (small) formula value and only caps over-deep ones.

## Decision needed (human sign-off)

This is a **production design** question, not a simulator-only one — FRET-consuming participants
compute `d_max` from the same doc. Whichever reading is correct, three artifacts must agree:

1. `docs/cohort-topic.md` — restate the clamp unambiguously (set-to vs. cap-at).
2. `packages/substrate-simulator/src/size-model.ts::computeDMax` — match the doc.
3. `packages/substrate-simulator/test/fret-model.spec.ts` — the single-peer clamp assertion and
   the `computeDMax(100000, <low>, cfg)` assertions encode the literal reading; update if the
   semantics change.

The simulator wrapper faithfully implements the doc as written today, so this is parked for a
design call rather than fixed inline. No production code path consumes the simulator, so there is
no live regression — only a latent ambiguity to resolve before the formula is wired into FRET.
