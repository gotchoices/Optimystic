description: A node that is able to re-check a write no longer skips the check silently — it now takes a named, logged decision when handed a write it cannot check, and turns a crashing checker into a signed refusal instead of a lost vote. Reviewed, with the duplicated decision folded into one shared place.
files:
  - packages/db-p2p/src/pend-validation.ts (NEW — the one fail-closed decision both tiers run)
  - packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations calls the shared helper; recordPriority optional-chain fix; const re-export)
  - packages/db-p2p/src/storage/storage-repo.ts (pend() calls the shared helper; const re-export; two-tier drift NOTE)
  - packages/db-core/src/cluster/structs.ts (UnvalidatablePendPolicy named type)
  - packages/db-core/src/network/struct.ts (PendRequest.validation pair)
  - packages/db-p2p/src/cluster/cluster-policy.ts (knob pass-through)
  - packages/db-p2p/test/pend-validation.spec.ts (NEW — 8 unit cases over the shared decision)
  - packages/db-p2p/test/cluster-repo.spec.ts, test/storage-repo.spec.ts, test/mesh-client-signature-enforcement.spec.ts
  - docs/internals.md, docs/transactions.md, packages/db-core/docs/transactor.md
----

# Complete: pend validation fails closed

## What shipped

`PendRequest` carries the re-check payload as ONE optional pair, `validation: { transaction,
operationsHash }`, produced only by the multi-collection path
(`TransactionCoordinator.pendCollection`). The two independently optional fields it replaces let a
sender omit half the payload and talk a validating receiver out of validating.

A receiver that holds a checker and meets a pend with no pair — the single-collection
`Collection.sync` shape, which has nothing to re-execute — now takes an explicit, logged policy
decision: `unvalidatablePendPolicy: 'accept'` (default, historical behaviour) or `'reject'`, which
refuses with the stable prefix `pend-not-validatable`. A checker that THROWS is caught and becomes a
signed reject reasoned `validator-fault: <message>`, where before the throw escaped the member's
promise handler and cost it its vote entirely — indistinguishable from an unreachable peer.

Both validating tiers (a `ClusterMember` casting its promise vote, a `StorageRepo` applying a pend)
run the same decision, now as one function.

## Review findings

**Structure — duplicated fail-closed decision (major by the architecture ladder; fixed in this
pass).** The implementation stated an invariant it held only by copy-paste: "both tiers refuse with
the same prefix". The policy branch and the throwing-checker catch existed twice, ~35 lines each,
with `'validator-fault: '` as a bare string literal in both while its sibling
`pend-not-validatable` had a named constant. Rather than file a drift ticket, the invariant was
made structural: new `packages/db-p2p/src/pend-validation.ts` holds `checkPendValidation` plus
both prefix constants (`PEND_NOT_VALIDATABLE`, `VALIDATOR_FAULT`), and each tier now calls it with
its own checker and its own log sink. Both tiers re-export the constants, so no import moved for
callers. Behaviour is unchanged arm for arm (verified against the pre-existing tier tests, all of
which still pass untouched).

**Correctness — a malformed `validation` pair could throw out of the vote path (fixed in this
pass).** `recordPriority` read `op.pend.validation?.transaction.priority`: the second hop was not
optional. `validation` arrives off the wire inside a signed message whose hash binds its bytes, not
its shape, so a peer can sign `validation: {}` and every member accepts the hash — then
`undefined.priority` throws a TypeError out of `resolveRace`/`findConflict`, costing that member its
vote. That is precisely the failure this ticket exists to remove, reintroduced by the reshape (the
old `pend.transaction?.priority` was safe, and `clampPriority` is deliberately hardened against
missing/Byzantine values). Now `?.transaction?.priority`, with a regression test that signs a
malformed pair and asserts a deterministic race outcome instead of a throw.

**Accuracy — a comment claimed a mechanism the code does not have (fixed in this pass).** The
implementer's tripwire said `'validator-fault:'` "matches neither CoordinatorRepo classifier".
Neither classifier matches on reason text at all — both confirm retryability against LOCAL storage
state and deliberately never parse the prose. The rewritten NOTE (now in `pend-validation.ts`,
one copy) says what actually happens: a validator-fault reject is returned as retryable only when
local state independently shows a stale revision or a rival pending, and reaches the writer as a
throw otherwise.

**Types — the policy union was written out four times.** `'accept' | 'reject'` appeared in
`ClusterConsensusConfig`, `ClusterPolicyOptions`, `StorageRepoOptions`, and the `ClusterMember`
field. Now one exported `UnvalidatablePendPolicy` in db-core, referenced by all four.

**Test coverage — the implementer's tests were a floor, as they said.** Their mesh, storage, and
unit cases are sound and were left as-is. Added: a `pend-validation.spec.ts` stating the whole truth
table once (no checker under both policies — the policy must be inert for a storage-only node, which
nothing covered; both policy arms including their log events; verdict pass-through; a rejection's own
reason not relabelled as a fault; async AND synchronous checker throws), plus the malformed-pair race
regression and a storage-tier "policy set but no hook configured" case. Suite counts: db-core 1459
passing; db-p2p 2409 passing / 49 pending (was 2399/49) / 0 failing; quereus-plugin 683 passing / 13
pending. `yarn lint`, `yarn build`, `yarn typecheck` all clean. No pre-existing failures surfaced.

**Docs — the change had touched one of the three files it should have.**
`db-core/docs/transactor.md` was updated by the implementer. `docs/internals.md` (the invariants
reference, which documents every other pend-vote refusal shape) said nothing about the two new
refusals — added a bullet covering both, the policy, and the "no composition root supplies a checker
today" caveat. `docs/transactions.md` still showed the design-era `PendRequest` with top-level
`transaction`/`operationsHash` — added a "Shipped shape" note pointing at the real field and the
policy, without rewriting the historical design sketch around it.

**Gaps accepted, with reasons — not silently.**
- *Mixed-policy mesh cohort* (some members 'reject', some 'accept'): agreed duplicative. The
  per-node absorption arithmetic is already proven for signature enforcement in the same spec, and
  the policy rides the identical vote path with the identical vote shape.
- *Reservation cleanup after a validator-fault reject*: no longer a gap by construction. Both
  refusal shapes now return through the exact same `{ valid: false, reason }` exit as a content
  rejection, which `does not retain a transaction it rejected itself` already covers.
- *Wire compatibility*: `validation` reshapes a field inside the hashed, signed message, so a
  mixed-version cohort disagrees. Left as-is deliberately — AGENTS.md says backwards compatibility
  is not yet a constraint for this project, and nothing in production supplies a checker at all.
- *`recordPriority` covered only via stub transactions carrying `.priority`*: adequate — that is the
  single field the function reads, and the malformed-shape case is now covered too.

**Tripwires recorded (conditional; NOT tickets).**
- `pend-validation.ts`, on `checkPendValidation`: a transient checker fault (database busy, dropped
  connection) now yields a terminal reject where a redelivery might have produced an approve. If
  transient faults show up in practice, give `CoordinatorRepo`'s classifier an arm keyed on the
  `validator-fault` prefix rather than reverting to a silent pass or a lost vote.
- `storage-repo.ts`, on `StorageRepoOptions.unvalidatablePendPolicy`: the two tiers' knobs are
  configured independently, so a node set to 'accept' at the cluster tier and 'reject' at storage
  would vote approve on a pend its own storage then refuses at apply. Harmless while no composition
  root supplies a checker; when one does, resolve both from a single operator field.

**No new tickets filed.** Every finding was either fixed here or is conditional on a deployment that
does not exist yet. The one standing prerequisite for any of this to matter in production is already
on the board: backlog `feat-no-deployment-validates-transactions-at-pend` (nothing constructs a
validator, so `StorageRepo` is built with no options and `ClusterMember` with no validator — the
policy knob and both refusal paths are reachable only from tests and embedders until that lands).
