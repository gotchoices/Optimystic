description: The simulator's cold-start-storm sanity check was red by design — its convenience entry point ran at a subscriber count where expected, documented overload behavior tripped a failing claim; this lowers the default to a calm rate and rewords the claim to what is actually guaranteed, so the check passes out of the box while the overload case stays explicitly tested.
files: packages/substrate-simulator/src/scenarios.ts, packages/substrate-simulator/test/scenarios.spec.ts, docs/cohort-topic.md
----

# Review: cold-start-storm default + `root-not-overloaded` claim semantics

## What the implement stage changed (Human Decision: **Both** — lower the default *and* tighten the claim)

`ColdStartStormScenario` (`packages/substrate-simulator/src/scenarios.ts`) previously defaulted to
`subscribers = 10_000`, while its `root-not-overloaded` claim asserted the **cumulative** tier-0
acceptance `≤ cap_promote (64)`. At 10,000 / 5 s (~2,000/s) the cumulative tier-0 acceptance reaches
**122 (~2× cap_promote)** — the documented gossip-lag overshoot — so the default-arg path
(`runAllScenarios()`, the public convenience entry) returned a **red `root-not-overloaded` claim out
of the box**. The claim was also semantically loose: it said "tier-0 accepts ≤ cap_promote" but
measured cumulative acceptance, which is bounded by `cap_promote` only at moderate arrival rates.

Both halves of the decision were applied:

- **Lowered the default** `subscribers` `10_000 → 3_000`. At 3,000 / 5 s the cumulative tier-0
  acceptance is exactly `cap_promote = 64`, so `runAllScenarios()` is green out of the box. The
  high-rate storm is now an explicit opt-in via `subscribers`.
- **Tightened the claim wording** to the honest, actually-bounded quantity. New `arrivalsPerRound`
  field = `⌈subscribers · GOSSIP_ROUND_MS / burstWindowMs⌉` (the "one round of arrivals" from the
  doc's `peakOvershoot < arrivalsPerRound` overshoot bound). The claim now reads:
  `cumulative tier-0 acceptance ≤ cap_promote + one round of arrivals (64 + R = bound)` and is
  evaluated against `rootDirect <= capPromote + arrivalsPerRound`. The class/`validate` doc comments
  explain that `rootDirect` is cumulative, not an instantaneous ceiling.
- **Doc sync** (`docs/cohort-topic.md` §Anti-flood): the "One caveat, surfaced honestly" paragraph was
  rewritten from an unresolved red-by-design caveat into the **resolution** — the claim is now the
  cumulative `≤ cap + one round` bound, the default is the moderate regime (green), and the storm
  regime (122) is an explicit opt-in. The 122 figure is **kept**. The §Simulator-scenarios summary
  line was updated from "root stays ≤ cap_promote" to the new cumulative-`+ one round` wording.

## Measured / pinned behavior (verified by the implement run)

- moderate (3,000 / 5 s): `coldstart.acceptedTier0 == 64` (== cap), `distinct == 3000`.
- storm (10,000 / 5 s): `coldstart.acceptedTier0 == 122` (~2× cap, > cap), `distinct == 10000`,
  within `cap + arrivalsPerRound = 64 + 2000 = 2064`.

`scenarios.spec.ts` now pins **both regimes** (replacing the single 3,000-only test) so the behavior
stays visible rather than silently passing the loosened bound:
- moderate test: `expectAllPass` + `acceptedTier0 <= 64`.
- storm test: `expectAllPass` + `acceptedTier0 > 64` (overshoot is real) + `acceptedTier0 <= 64 + 2000`.

## Validation performed

- `node_modules/.bin/tsc --noEmit` → exit 0 (clean). **Note:** `npx tsc` resolves a *newer global*
  TypeScript that errors `TS5101 downlevelIteration deprecated` on the existing `tsconfig.json` — that
  is a pre-existing tooling/config quirk, **not** caused by this ticket. Use the local
  `node_modules/.bin/tsc` (5.9.3), which the package `build`/`test` scripts use.
- Full package suite: `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts"`
  → **258 passing**, exit 0.

## What a reviewer should scrutinize

- **Is the loosened bound too loose to be meaningful?** `cap + arrivalsPerRound` for the storm is
  `2064`, but the observed overshoot is `122` — the claim passes the storm by a wide margin. This is
  deliberate: `cap + one round of arrivals` is the *documented analytical* admission-buffer bound
  (cohort-topic.md §Promotion: `peakOvershoot < arrivalsPerRound`; mirrored by
  `boundary-reference.ts`, which sizes the buffer at "cap_promote + one round"). The storm **test**
  carries the meaningful, tight assertion (`> cap` proves the overshoot is real; `≤ cap + one round`
  proves it is bounded), so the regime behavior is not hidden. If the reviewer prefers the *claim
  itself* to be tighter, an alternative is a regime-aware claim (≤ cap at moderate rates, ≤ cap +
  overshoot at storm rates) — heavier, and the scenario would need to know its own regime.
- **Exact-value pinning vs robustness.** The storm test asserts a *range* (`> 64`, `≤ 2064`) rather
  than hard-pinning `122`, to avoid brittleness against unrelated model tweaks. The exact `122` is
  recorded in the doc and was confirmed by a one-off probe. If the reviewer wants `122` pinned as a
  regression sentinel, that is a one-line tightening (`expect(accepted).to.equal(122)`); the tradeoff
  is brittleness. Both numbers are deterministic (seeded), so an exact pin would not flake.
- **Shared claim-id `root-not-overloaded`.** The string `root-not-overloaded` is also used by
  `VotingQuorumScenario` (a genuine instantaneous `rootDirect ≤ cap`, unchanged) and by
  `boundary-reference.ts` / `boundary.spec.ts` (a different driver, margin vs `cap_promote`,
  unaffected). Only the cold-start-storm claim's wording/predicate changed. Confirm no consumer keys
  off the cold-start claim's *expected-string* text.
- **No other consumers affected (checked):** the db-p2p `cohort-topic-scale-antiflood.spec.ts`
  `capPromote: 10_000` is a real-engine config, not the simulator default; the README `10_000` is a
  generic `generatePeers` example. Neither references the cold-start subscriber default.

## Known gaps / out of scope

- The gossip-lag overshoot **mechanism** is correct and intended (cohort-topic.md §Promotion); this
  ticket only touched the scenario *default* and *claim semantics*, not the model. Untouched.
- The storm test runs 10,000 walks (~226 ms observed; 60 s timeout). Not a performance concern, but
  it is heavier than the other cold-start cases.
- Concurrent unrelated board move present in the tree (`dmax-confidence-clamp-semantics.md`
  backlog→implement) — left untouched per "never sanitize the working tree"; not part of this ticket.
