description: A new setting lets an application tighten the block-repair safety check as its group of machines grows, without also making the system stricter about accepting writes; the reviewed pass also removed a size floor that had silently stopped single-machine nodes from remembering a block was fresh.
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-commit-freshness.spec.ts, packages/db-p2p/test/mesh-reconcile-quorum.spec.ts, packages/db-p2p/docs/cluster.md, docs/transactions.md, packages/reference-peer/src/cli.ts
----

# Complete: declare the repair yardstick on its own; apply a changed size by rebuilding

## What shipped

`clusterPolicy.repairCorroborationClusterSize` declares the **repair corroboration floor's yardstick
alone**. Before it, the only way to raise that yardstick was `clusterPolicy.assumedClusterSize`,
which also raises the membership admission gate's low-confidence write floor — so a deployment that
wanted repair tightened had to accept a floor that can refuse legitimate writes. The downstream
consumer pinned `assumedClusterSize: 2` at every group size for exactly that reason, and therefore
got no repair tightening at all.

Resolution chain, now one exported function (`resolveRepairCorroborationClusterSize` in
`cluster/cluster-policy.ts`) called by **both** composition paths:

```
repairCorroborationClusterSize =
    asDeclaredSize(clusterPolicy.repairCorroborationClusterSize)
    ?? asDeclaredSize(clusterPolicy.assumedClusterSize)
    ?? clusterSize
```

A declared value that is not a positive finite integer falls **through** to the next term rather than
being clamped — clamping to 2 would be the unsafe direction, since 2 is the one size whose floor
relaxes to a single corroborator. `assumedClusterSize` itself stays a raw pass-through for the
admission gate (`cluster-repo.admissionFloor` floors it there).

No runtime setter, by design; the accepted-tradeoff `NOTE:` recording that decision and its revisit
condition lives at `resolveClusterPolicy`. Also shipped: the `--repair-corroboration-cluster-size`
reference-peer flag, the widened `repair-fault-tolerance` startup advisory, corrected in-code prose
at four sites, and doc updates across `packages/db-p2p/docs/cluster.md`, `docs/optimystic.md`,
`docs/internals.md`, `docs/architecture.md` and `docs/transactions.md`.

## Review findings

Read the implement diff (`5f0a11e7`) before the handoff summary, then swept the resolution site, both
composition paths, every consumer of the resolved number, the reference-peer flag, and every doc the
change touched or should have touched.

### Major — a behaviour regression the implement pass shipped (fixed in this pass, not filed)

- **The `Math.max(minAbsoluteClusterSize, …)` floor on the resolved yardstick was not the no-op it
  was documented as.** The implement commit added it and reasoned about a single consumer, the repair
  floor, where it genuinely is inert (`quorumSize` takes `max(1, min(CORROBORATION_FLOOR, capacity))`
  and `corroboratorCapacity` maxes against visible peers, so 1 and 2 give identical results at every
  peer count). But the number has a **second** consumer the handoff's own "confirm nothing else reads
  it" check missed: `CoordinatorRepo.commitQuorumRulesOutRivals` uses it as the full-cohort
  denominator a local commit must beat to arm the lazy read-repair freshness window. Flooring a
  genuine `clusterSize: 1` up to 2 turns `1 > 1/2` into `1 > 2/2` — a solo node's own commit stops
  arming the window, so every written block pays a cohort consult per read-repair window. One machine
  is a documented supported topology (`docs/architecture.md`), so this is a real cost, not a corner.
  **Found by extending the shared chain to the second composition path**, which made the existing
  `a solo commit on a genuine cohort of one DOES arm the window` case fail; it had been passing only
  because it hand-wires `CoordinatorRepo` and so bypassed `resolveClusterPolicy` entirely.
  Fixed by removing the floor (nothing else wanted it), with the arithmetic and the trap recorded on
  `resolveRepairCorroborationClusterSize`. Not filed as a ticket: the fix is three lines and the
  regression is unreleased.

### Minor — fixed in this pass

- **Two composition paths restated the same chain.** `resolveClusterPolicy` applied `asDeclaredSize`;
  `CoordinatorRepo`'s constructor applied a hand-matched `cfg?.x ?? policy.assumedClusterSize ??
  policy.clusterSize`, which agrees only for well-formed input — `??` keeps a `0` or a `NaN` where the
  sanitized chain discards it, and a hand-wired coordinator handed `repairCorroborationClusterSize: 0`
  would fall back to observed peers, exactly the shrunken-view relaxation the design exists to
  prevent. Climbed the ladder rather than patching the instance: extracted the chain into one
  exported function both paths now call, so the agreement is structural. The spec that previously
  *restated* the coordinator's chain inline (a soft spot the handoff flagged itself) now calls the
  shared function and covers degenerate inputs.
- **A typo'd declaration was quieter than declaring nothing.** `cohortUndeclared` used a raw
  `=== undefined` while the resolution used the sanitized notion, so `repairCorroborationClusterSize:
  2.5` counted as "declared" for the advisory (suppressing the undeclared arm) while resolving to the
  strict `clusterSize` (which has margin, suppressing the no-margin arm too) — total silence for the
  operator most in need of the advice. The two notions of "declared" now agree, and the message names
  the discarded values so the reader can see their number never took effect.
- **"A value above `clusterSize` is accepted and harmless" was wrong**, in the field's TSDoc, in
  `cluster.md`, and in a spec title. It never raises the corroboration requirement, but it *is* the
  same freshness-window denominator above, so overstating it costs cohort consults on the read path.
  All three now say what it actually costs.
- **`docs/transactions.md` was left half-updated.** Only the reconcile bullet was touched; the
  corroboration-floor bullet directly above it and the commit-freshness paragraph above that still
  described the old `assumedClusterSize -> clusterSize` chain, still listed only two escape hatches
  for a two-node deployment, and — worst — still told host applications to derive
  `clusterPolicy.assumedClusterSize` from their membership records, which is the exact recommendation
  this ticket exists to replace (`architecture.md` and `internals.md` were updated; this one was not).
  All four corrected, including the rebuild contract.

### Test gaps closed

The implementer's specs were unit-level against `resolveClusterPolicy` only. Added:

- **An end-to-end mesh arm** (`mesh-reconcile-quorum.spec.ts`): a two-node mesh at
  `clusterSize: 10` that declares only `repairCorroborationClusterSize: 2` and repairs. This is the
  downstream shape, and it proves the number reaches the real repair path rather than only the
  resolver — the handoff listed it as having no coverage at all.
- **A composition-root arm** in `coordinator-repo-commit-freshness.spec.ts`, feeding a real
  `resolveClusterPolicy` result into the freshness gate. Every existing case there hand-wires the
  repo, which is why the regression above was invisible.
- **Degenerate-input arms** on the two-path agreement case, and two advisory cases for the
  discarded-declaration wording.

### Verified, nothing found

- **The reference-peer flag, actually run.** The handoff's highest-value open item ("nobody has run
  the binary"). Confirmed on the built CLI: the option appears in `service --help` with its help
  text, `--repair-corroboration-cluster-size 2.5` and `… abc` both reject with
  `must be a positive integer`, and `service --offline --repair-corroboration-cluster-size 4` boots
  and echoes `Repair corroboration cluster size set to 4`. The flag still has no *spec* — that is the
  tracked pre-existing gap `backlog/debt-reference-peer-cli-flags-untestable`, and the ticket said not
  to fix it here.
- `asDeclaredSize`'s `value as number` cast: `Number.isInteger(undefined)` is `false`, so the cast is
  reached only for numbers. Sound.
- Every consumer of `repairCorroborationClusterSize` re-swept by grep, not by trust:
  `corroboratorCapacity` on both restoration paths, the advisory, `commitQuorumRulesOutRivals` (the
  one the handoff missed — see above), and `mesh-harness`. Nothing else reads it.
- The `ClusterConsensusConfig` block in `cluster.md` was deliberately not given the new field, which
  is correct — that is a different interface, and the field lives on `ClusterPolicyOptions`. The
  surrounding prose says so explicitly.
- `assertClusterSizeCoupling` correctly untouched: nodes may legitimately disagree on the repair
  yardstick.
- The rebuild-cost claims in `cluster.md` / `optimystic.md` were spot-checked against
  `recoverTransactions`, `lastSeenCommitMs` and the responsibility cache. They hold. They remain
  code-reading claims, as the handoff said; none was contradicted.

### Tripwires (recorded, deliberately not ticketed)

- A genuine solo node's `repair-fault-tolerance` advisory reads "0 cohort peer(s) and needs 1" and
  advises running four machines — honest arithmetic, but advice aimed at a deployment that wanted a
  cohort. Noise rather than wrong, and one line per node construction. Parked as a `NOTE:` at the
  `availablePeers` site, which also warns the next reader **not** to fix the wording with a floor on
  the yardstick (that is what caused the regression above).

### Declined / out of scope

- Any runtime setter: settled, with an accepted-tradeoff `NOTE:` at `resolveClusterPolicy` carrying
  its revisit condition. Not re-litigated.
- Deriving a yardstick from network observation:
  `backlog/feat-admission-floor-from-observed-cohort-high-water-mark`.
- The downstream (Sereus-side) derivation: that repository's work, and it depends on this shipping.

## Validation

All from the repository root unless noted; all green, no pre-existing failures surfaced.

```
yarn lint                                          # clean
yarn lint:docs                                     # 45 documents, 75 anchored citations — all resolve
yarn workspaces foreach -At ... run build          # all packages
yarn typecheck                                     # clean
yarn test                                          # full fan-out: 0 failing (db-p2p 2622 passing, 49 pending)
```

Plus the reference-peer binary run by hand, as above.
