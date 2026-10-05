description: A node that does not hold a block, and sees itself as the only machine responsible for it, used to answer "this block was never created" even when the reader's own log said the block exists, so the read failed hard. It now answers "I could not find out", so the read is retried on another machine and, failing that, ends in a typed, retryable error.
prereq:
architecture: docs/internals.md#consensus-execution
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`AbsenceVerdict` gains `'unasked'`; module function `unavailableReasonFor`; `fetchBlockFromCluster`'s empty-cohort and solo-self exits return `'unasked'`; `readRepairBlock` maps through it — since extended by `absenceFlagFor` in the sibling ticket `a-joiner-builds-its-own-catalog-while-its-cohort-view-is-self-only`)
  - packages/db-core/src/network/struct.ts (`BlockUnavailableReason` gains `'named-by-log'`)
  - packages/db-core/src/transactor/network-transactor.ts (comment only: `unavailableRank` puts `'named-by-log'` at rank 2 with `'claimed-elsewhere'`)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts (unit and mesh specs for #27; the mesh fixture's steered `findCoordinator` steps aside when the steered peer is excluded)
  - docs/internals.md, docs/transactions.md, packages/quereus-plugin-optimystic/README.md
----

# A self-only view no longer rules out a block the asker's log names

GitHub issue #27. A joiner's catalog refresh walked a log entry naming a block, raised a floor for it, and read it with that floor on the request (`BlockGets.floors`). Its own `CoordinatorRepo` had a self-only cohort view, took the solo-self exit of `fetchBlockFromCluster`, and answered an unflagged (authoritative) absent, which `NetworkTransactor.get` takes as final — so the read ended in `Missing block`.

## What landed

- `fetchBlockFromCluster` tells "nobody was asked" (`'unasked'`: empty cohort, or only this node) apart from "every member answered it holds nothing" (`'confirmed'`). The no-`clusterLatestCallback` exit stays `'confirmed'`.
- `unavailableReasonFor(absence, floor)` maps verdict to `unavailable` reason. `'unasked'` with no floor stays an authoritative absent (one-machine `createOrOpen` probe stays one round); with a floor it is flagged `'named-by-log'`, earning the transactor's second-chance round with this node excluded, and ending in `BlockUnavailableError('named-by-log')` when no machine holds it.
- Accepted cost, recorded in the `NOTE:` on `unavailableReasonFor`: a floored read of an inserted block whose log entry landed but whose blocks did not (backlog `bug-a-refused-write-can-leave-its-log-entry-behind`) on a one-machine deployment now throws the typed error instead of `Missing block`.

Commit: `ticket(implement): a-joiner-reads-a-missing-block-from-a-self-only-cohort-view`.

## Review findings

Read the implement diff first, then the current tree (the sibling ticket `a-joiner-builds-its-own-catalog-while-its-cohort-view-is-self-only` landed after it and wraps `unavailableReasonFor` in `CoordinatorRepo.absenceFlagFor`; the two compose correctly — a floor still wins with `'named-by-log'`, otherwise an unheard bootstrap peer yields `'cohort-unreachable'`).

- **Correctness / edge cases** — checked: a pending-only insert held locally under a floor is not flagged (`flagUnconfirmedAbsence` tests `entry.block`); a present block below its floor is unaffected (floor only triggers a consult there); the consult-throws arm still flags `'peers-unreachable'`; the no-callback exit stays authoritative; `unavailableRank` ranks `'named-by-log'` at 2 via its default branch, which is correct and named in the comment, so no explicit arm was added. Floors raised for deleted block ids: only reachable by a reader still holding a path into a block a rival deleted, on a node that never held it and sees itself alone; that read ended in an error before too, now a typed one. No action.
- **Docs** — internals.md absence table and paragraphs, transactions.md (§ Lazy read-repair window, the reason list under Unavailable reads, the self-coordination sentence) all reflect the change and the sibling's. **Found and fixed:** `packages/quereus-plugin-optimystic/README.md` § Error Handling enumerated the `BlockUnavailableError` reasons and omitted `'named-by-log'`; added it. docs/debugging.md does not enumerate reasons — nothing to change.
- **Tests** — the unit spec pins the one new branch (floor vs. no floor on a self-only view; `probeAlone` asserts the unflagged case). The mesh spec composes already-tested pieces but is the only in-repo evidence that the retry reaches a second machine, runs in milliseconds, and was kept. No tests added or cut. `coordinator-repo-absence-write-bypass.spec.ts`: 13 passing. `yarn lint:docs`: clean.
- **Hygiene / type safety** — `unavailableReasonFor` is an exhaustive switch over a union, replacing a nested ternary; comments state why, not what. Nothing to change.
- **Known gap, unchanged (not a ticket)** — the issue's end-to-end scenario was not re-run (needs sibling sereus packages), and the real `Libp2pKeyPeerNetwork.findCoordinator` fallback filters by `filterByMembership`, so a joiner whose founder is still unidentified retries against itself and ends in the typed `BlockUnavailableError('named-by-log')` rather than reading the block. That is the retryable outcome the ticket requires; the sibling ticket's bootstrap-contact wait addresses the founder-not-yet-identified window.
- **Pre-existing failure** — the intermittent `test/reactivity/mesh-tail-rotation.spec.ts` failure reported by the implementer was already triaged (`tess: triage pre-existing test failure`); not re-reported.
