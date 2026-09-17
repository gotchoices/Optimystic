----
description: Machines in a running cluster are supposed to independently re-check every transaction they are asked to vote on, but nothing in the shipping code ever gives them the checker — so in practice they vote on whatever they are sent without re-checking it.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts:240-241, 812, 1303 (NodeOptions.validator — declared, plumbed, never supplied)
  - packages/db-p2p/src/cluster/cluster-repo.ts:1129-1200 (validatePendOperations — returns success when no validator is configured)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (createQuereusValidator — built, exported, called only by tests)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:233 (createLibp2pNode call — passes no validator)
  - packages/reference-peer/src/cli.ts:377 (createLibp2pNode call — passes no validator)
  - packages/db-core/src/transaction/validator.ts (TransactionValidator — the checks that go unrun)
difficulty: hard
tradeoffs: Turning re-validation on is a behaviour change with a real chance of rejecting traffic that works today (schema-hash skew across versions, operations-hash format skew, stale reads that the current path tolerates), so a maintainer could reasonably keep the current permissive posture until there is an operational reason to close it.
----

# No deployment wires a transaction validator, so cluster members re-validate nothing

## What is going on

When a cluster member receives a PEND it is meant to independently re-execute the transaction and
check it before signing an approve: the engine is known, the schema hash matches, the read
dependencies are still current, the operations hash matches, and — if enforcement is on — the client
signature verifies. That work lives in `TransactionValidator` (`packages/db-core`), and a
Quereus-flavoured one is built by `createQuereusValidator` in the plugin.

Nothing in shipping code ever hands one to a node. `NodeOptions.validator` exists and is plumbed
through `libp2p-node-base.ts` into `clusterMember({ … validator })`, but a search for a caller finds
none: `grep -rn "validator:" packages/*/src` returns exactly two hits, both being that same
`validator: options.validator` pass-through. `createQuereusValidator` is invoked only from tests. The
two composition roots that actually build nodes — the plugin's collection factory and the reference
peer CLI — both call `createLibp2pNode` without it.

`ClusterMember.validatePendOperations` documents that it "returns success if no validator is
configured (backwards compatibility)". So in every deployment today, that whole step is a no-op: a
member approves what the coordinator sent it, without re-deriving anything.

## Why it matters

Two separate consequences, worth naming apart:

- **Byzantine resistance.** Independent re-validation is what makes a coordinator's claim about a
  transaction checkable by the peers voting on it. Without it, super-majority approval attests that
  the peers received the record, not that they agreed with its contents.
- **A shipped feature that cannot be turned on.** Client transaction signature enforcement
  (`QuereusValidatorOptions.requireClientSignature`) was built for phased rollout: land signing,
  observe clients signing, then flip enforcement. The flip is unreachable, because the object the
  flag configures is never constructed in production. Any work that adds "just a config flag" for it
  is building a switch on a disconnected wire.

## What "done" would look like

A deployment can opt a node into re-validating pends, and the plugin's Quereus validator is what a
Quereus-backed deployment gets. Concretely that means at least:

- A composition root (the plugin's collection factory for the SQL case, the reference peer CLI for
  the standalone case) constructs a validator and passes it as `NodeOptions.validator`.
- Whatever configuration surface those roots expose gains the switches that decide it — including
  `requireClientSignature`, which then becomes meaningful.
- The Quereus case has an ordering problem to solve that the plain case does not: the validator needs
  a `Database` and a `TransactionCoordinator`, and today the node is built before those exist. Either
  the node accepts a late-bound validator, or node construction moves after the database is up.

## Risks a maintainer should weigh before promoting this

Turning on a check that has never run in the field is where the cost sits, not in the wiring:

- **Schema-hash skew.** A member whose local schema differs at all rejects with `Schema mismatch`.
  Today that difference is invisible.
- **Operations-hash format skew.** The validator already has a version-skew branch precisely because
  mixed-version clusters are expected; those rejections start happening for real.
- **Read-dependency (stale-read) rejections.** `blockStateProvider` checks turn optimistic-concurrency
  losses into member-level rejects, changing which failures are retryable.
- **Re-execution cost on the promise path.** Every member re-runs every transaction — a real
  throughput change, unmeasured here.

That is why this is a feature ticket and not a bug ticket: the current posture may well be a
deliberate staging decision. But it is not *recorded* as one anywhere, and the signature-enforcement
work was planned on the assumption that flipping a flag was all that stood between it and production.

## How this surfaced

Found while planning `implement/5-mesh-harness-signature-enforcement`, which needed to answer
"how would a deployment turn signature enforcement on?" and found that it cannot. That ticket leaves
a `NOTE:` at `QuereusValidatorOptions.requireClientSignature` pointing here.

## Related — two holes in the seam this ticket would switch on

Reviewing `mesh-harness-signature-enforcement` turned up two ways
`ClusterMember.validatePendOperations` skips the check rather than enforcing it, on a member that
*does* have a validator: a sender that omits `operationsHash` (or `transaction`) falls through the
presence guard unchecked, and a validator that throws escapes as an error rather than becoming a
signed reject vote — so a cohort of failing validators degrades toward not-validating, not toward
refusing. Filed separately as `debt-pend-validation-is-skipped-instead-of-failing-closed`, because
they are worth closing *before* this wiring lands: with them open, turning validation on only partly
turns it on.

## Gardening correction (2026-09-01): the "filed separately" ticket was never filed

The last paragraph says the two fail-open holes in `ClusterMember.validatePendOperations` were
"filed separately as `debt-pend-validation-is-skipped-instead-of-failing-closed`". **That slug exists
nowhere** — not in any stage folder, not in `tickets/.pruned-tickets.jsonl`, and not under any
sequence prefix. It was never created, so if this ticket is promoted as written, the work it says is
already tracked would be silently dropped.

Rather than file a second ticket for the same code site, treat those holes as **arm 0 of this
ticket** — they resolve at the same method, and the paragraph above is right that they must close
*before* the wiring lands, because with them open, turning validation on only partly turns it on:

- **A sender that omits `operationsHash` (or `transaction`) falls through the presence guard
  unchecked.** A member with a validator configured skips the check rather than refusing, so a
  coordinator can opt every member out of re-validation by omitting a field.
- **A validator that throws escapes as an error rather than becoming a signed reject vote.** A cohort
  whose validators are all failing therefore degrades toward *not validating*, not toward refusing —
  the opposite of fail-closed.

Both are at `packages/db-p2p/src/cluster/cluster-repo.ts:1129-1200`, already in this ticket's `files:`
list. Close them first, then do the wiring; or split them out into their own `debt-` ticket at
promotion time and chain this one behind it with `prereq:`. Either is fine — what is not fine is
promoting this while believing they are covered elsewhere.

## Arm: the writer's "finish a half-saved write" re-send carries no transaction to re-check (review, 2026-09-16)

Ticket `a-write-whose-log-entry-landed-alone-is-reported-saved` added a recovery step: when a write's history record was stored but its data blocks were not, the writer re-sends the same blocks at the same revision (`Collection.completeOwnEntry` in `packages/db-core/src/collection/collection.ts`). That re-send goes through `TransactorSource.transact`, which sends a plain pend. For a multi-collection transaction the original pend carried the `validation` pair (the transaction and its operations hash, built only in `TransactionCoordinator.pendCollection`); the re-send does not, because the pair is not retained with the failed attempt (`InFlightAttempt`).

Nothing changes today, because no member holds a checker. The moment this ticket wires one:

- under `unvalidatablePendPolicy: 'accept'` (the default), the finishing blocks of a transaction are approved without the re-check every other block of that transaction got;
- under `'reject'`, the re-send is refused as `pend-not-validatable`, so a half-saved multi-collection write can never be finished in a fail-closed deployment. It fails loudly (`TornActionError`, reason `completion-refused`), never silently.

Retaining the pair and re-sending it is not obviously the fix. A member re-executes the transaction against its current state, and by the time of the re-send a sibling collection of the same transaction may already be saved — so the re-execution no longer starts from the state the transaction was staged against and may legitimately produce different operations. Whoever wires validators needs to decide what a member should check for a re-send of blocks whose history record it can already read (for instance, that the re-sent blocks are exactly the ones that record names, under that action id). A `NOTE:` at the re-send site points here.
