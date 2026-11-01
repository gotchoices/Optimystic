description: When one write spans several collections (a table and its indexes) that are agreed in separate rounds of signatures, a node kept only one signature set per write, so a table's change notification could go out signed by the index's round and be refused. Each round's signatures are now kept under the collection it committed, so each notification carries its own.
architecture: docs/internals.md#cohort-topic-origination-bridge-networked-reactivity
files: packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/testing/reactivity-mesh-harness.ts, packages/db-p2p/test/cohort-topic/change-bridge.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/test/cluster-invalidation.spec.ts, docs/internals.md, docs/cohort-topic.md, tickets/backlog/feat-a-network-watch-wake-sees-the-whole-commit.md
repro: static
----
# Keep a commit certificate per (action, collection tail)

## What landed

`CommitCertStore` (`packages/db-p2p/src/cluster/commit-cert.ts`) is keyed by `(actionId, tailId)` instead of by action id alone. Before, when one action committed a table and an index as two consensus records (the per-collection fallback when `commitMany` answers `undefined`, or a tail-then-sweep commit) and a member applied them back to back or concurrently, the later record's `put` overwrote the earlier one's certificate, so the table's `CollectionChangeEvent` could originate a notification signed by the index record's cohort — refused by a subscriber judging the table tail's root group.

- `put(actionId, cert, tailIds, now?)` writes one entry per tail; `[]` writes nothing (a sweep record, whose events never originate); `undefined` writes an action-wide entry (an invalidation's cert, which names no tail).
- `get(actionId, tailId, now?)` returns the per-tail entry, else the action-wide entry. Commit records never write action-wide entries, so the fallback cannot cross collections.
- `committedTailIds(commits)` — the tails a record commits, by the same test `selfAppliedTail` applies to the event (`blockIds` includes `tailId`).
- `CommitCertificateSink` (also `NodeOptions.onCommitCertificate`) gains a third argument, `tailIds`; `ClusterMember.applyConsensusCommits` passes `committedTailIds(commits)`, the invalidation capture passes `undefined`. The extractor reads `store.get(event.actionId, event.tailId)`.
- Docs: `docs/internals.md` (§ Change Notification and § Cohort-Topic Origination Bridge, new bullet "One cert per collection tail, not per action"), two asides in `docs/cohort-topic.md`, the `emitCollectionChanges` doc comment, and the backlog `feat-a-network-watch-wake-sees-the-whole-commit` arm that named this as a prerequisite.

The implement commit is `ticket(implement): bug-a-commit-cert-is-looked-up-by-action-alone`.

## Review findings

Read the implement diff first, then the handoff.

**Checked, correct:**
- Every source of a `CollectionChangeEvent` against the new key. Commit-path events carry `CommitRequest.tailId` (required on the type) and the blocks that landed; read-driven promotions and replica landings carry no tail and never pass `selfAppliedTail`, so they never reach the extractor. A sweep (non-tail blocks, or the old tail's `nextId` rewrite on a rollover, whose request's `tailId` is the new tail) yields no tails in `committedTailIds` and its event fails `selfAppliedTail` — the two tests are the same predicate over the two shapes, so every event that can originate finds its record's cert.
- A batch record (several collections, one record, one cert) stores the cert under each tail, so each collection's event resolves the same, correct cert.
- The tail-then-sweep fallback after a thrown one-round commit re-sends the tail as a second record under the same action; it re-puts under the same `(action, tail)`, with a cert from the same tail cohort — no cross-collection hazard.
- Map key `JSON.stringify([actionId, tailId ?? null])`: no separator ambiguity even though action ids are not format-checked; `null` cannot collide with a string tail.
- TTL, cap and insertion-order eviction unchanged in behaviour; `dropExpired` stays O(entries) per put (pre-existing); a batch now costs N entries for N collections against the 4096 cap — negligible at 60 s TTL.
- Composed sink in `createLibp2pNodeBase` forwards `tailIds` to both the store and the caller's sink, store first (unchanged ordering rationale).
- Invalidation path: action-wide entry, with the implementer's `NOTE:` that an invalidation event must carry a tail among its `blockIds` to originate once the dispute subsystem is wired. That is genuinely conditional (dormant subsystem), so a tripwire is the right home.
- Docs: every file the change touches, plus `docs/reactivity.md` and `docs/right-is-right.md` (which describe the invalidation cert keyed by `invalidationActionId` — still true, it is the action-wide entry). No stale "keyed by action alone" claims remain.

**Tests:** the new store/extractor test is the reproduction (the old store returned the index cert for both events) and pins the action-wide fallback's real branching; kept. The updated sink assertions in `cluster-consensus-divergence.spec.ts` and `cluster-invalidation.spec.ts` pin the new third argument's contract at the producer; kept. No test cut, none added.

**Found and fixed (minor):** `reactivity-mesh-harness.ts` keeps its own `certByAction` map keyed by action alone, bypassing the production store. Sound today (every harness commit has its own action id and one collection) but it would hide this class of bug if the harness ever commits one action across collections — parked as a `NOTE:` tripwire on the field.

**Major / filed:** none. The fix is at the one site (the store's key), and the shared predicate between `committedTailIds` and `selfAppliedTail` is cross-referenced; their input shapes differ (`CommitRequest[]` vs `CollectionChangeEvent`), so sharing code would not simplify anything.

**Not reproduced end to end:** the race itself (two records of one action interleaving on one member) is exercised only at the store/extractor layer, as the ticket specified; `repro: static` stands.

**Validation run:** `yarn workspace @optimystic/db-p2p build`, `tsc --noEmit` in `packages/db-p2p`, full `yarn test` in `packages/db-p2p` (3529 passing, 74 pending), `yarn lint:docs` (green), eslint on the touched sources (clean). Rebuilt db-p2p after the harness comment edit.
