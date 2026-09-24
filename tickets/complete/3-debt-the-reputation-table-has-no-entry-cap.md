description: The list a machine keeps of how other machines have behaved is now capped at a fixed number of entries, so a stranger can no longer grow it without limit by sending messages that name made-up machines.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.getOrCreateRecord`, `evictOne`, `pickEvictionVictim`, `refuseNewRecord`)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig.maxPeers`)
  - packages/db-p2p/test/peer-reputation.spec.ts
  - docs/architecture.md, docs/internals.md, docs/debugging.md
----
# Complete: the reputation table has an entry cap

## What landed

`PeerReputationService` keeps one record per other machine it has formed an opinion about. The names come off the wire — `ClusterMember.validateSignatures` reports against the peer ids of an inbound consensus record, before any membership check and before the opt-in per-stream authorization gate — and anyone can mint a keypair, so a stranger could grow the table one record per message. It is now capped.

- `ReputationConfig.maxPeers` (optional, default 1024), read in the constructor.
- `getOrCreateRecord` is the only place a record is created and so the only place the cap is enforced. It returns `PeerRecord | undefined`; `reportPeer` and `recordSuccess` return early on `undefined`, so no caller changed shape.
- At the cap, `pickEvictionVictim` chooses one record to forget: never a record at or above the ban threshold; otherwise the lowest current score; ties to the least recently touched. It reuses `computeScore` and stores no new field.
- If every record is banned there is no victim: the new name is not recorded, the report is dropped, and `refuseNewRecord` logs one `peer-reputation` line with the cap and a running count — counted, never acted on, the same shape as `refuseSelfReport`.
- Documented in `docs/architecture.md` § Reputation & equivocation, `docs/internals.md` § Equivocation Detection, and the `peer-reputation` logger row in `docs/debugging.md`.

Untouched, as the ticket asked: `refuseSelfReport` / the `isSelf` guard, the writers in `cluster-repo.ts` and `traffic-validation.ts`, and the open residual about unauthenticated peers reaching the signature check.

## Review findings

**Read first, then the handoff.** The implement diff (`6afb0ffa`) was read before the handoff summary, and the cap was traced from each of the twelve `reportPeer` call sites back to what an attacker can actually drive.

**Correctness of the cap — checked, nothing found.** The size invariant holds by construction (a full table evicts exactly one record before inserting, so it never exceeds the cap); an existing record short-circuits ahead of the cap, so reporting an already-tracked peer never evicts; the self-report guard still runs before record creation on both entry points. Verified by running the code as well as reading it: interleaved `reportPeer` / `recordSuccess` across 50 fresh names against a cap of 3 never breached it.

**The accepted limits were checked against the code rather than taken on the handoff's word, and both are accurate.** Limit (a): the attacker-drivable reports are `InvalidSignature` (50), `Equivocation` (100) and matchmaking `ProtocolViolation` (30), all above the deprioritize threshold of 20, so a spray displaces genuinely lower-scoring records and leaves the higher-scoring ones — the intended direction. Limit (b) claims the table releases once the bans decay; confirmed by running a two-entry service at a 30 ms half-life, which refused a third name while both records were banned and admitted it four half-lives later. Neither limit is a latent defect: a forgotten name scores 0, which is what an unseen machine already scores, so forgetting costs recall and never correctness.

**Docs were treated as out of date until read, and two files were stale.** Neither was in the implement diff.

- `docs/debugging.md` — the `peer-reputation` logger row enumerates the kinds of line that namespace emits (reports, resets, `refused self-report`). The change added a third kind and the row did not mention it, so an operator meeting `refused new record` in a log had nowhere to look it up. Fixed: the row now names the line, the condition that produces it, and the fields it carries.
- `docs/internals.md` § Equivocation Detection — this is the detailed reputation description (the architecture.md sentence is the summary), and it still read as though the table were unbounded. Fixed: a paragraph covering the cap, the eviction rule, why bans are protected, what happens when there is no victim, and both accepted limits.

**Minor findings, fixed in this pass.**

- The tripwire `NOTE:` at `pickEvictionVictim` named the wrong trigger. It framed the per-creation scan as a concern only if the cap were raised into the tens of thousands, but the scan is driven by a *stranger* — one inbound message naming an unseen id is one creation — and its cost also scales with `maxPenaltiesPerPeer`, not just with the cap. Rewritten to state the actual bound (`maxPeers` × `maxPenaltiesPerPeer` decay computations, 1024 × 100 at the defaults), to note that the same message already paid for a signature verification, and to say plainly that neither side has been profiled. No magnitude is claimed that was not measured or read off the defaults.
- `ReputationConfig.maxPeers` now documents that `0` is not clamped and means "track nothing".

**The implementer's open question — should a cap of `0` be clamped to at least 1? Answered: no, and documented instead.** Confirmed by running it: a cap of `0` creates no record and scores every identifier 0. That is a coherent reading ("keep no records"), and clamping would silently override an explicit operator value. Nothing else in `ReputationConfig` is validated either — a ban threshold of `0` and a `maxPenaltiesPerPeer` of `0` are both quietly degenerate in the same way — so validating this one field alone would be arbitrary rather than principled. The reading is now stated at the field so it cannot be reached by accident.

**Tests — reviewed as code, kept as-is, nothing added.** The one new test exercises the cap through the public API only (no mock of anything the repository owns), and covers the four branches that matter: the size bound, the never-evict-a-ban rule, lowest-score-first eviction, and the refusal when every record is banned. It is one test for one behaviour and it pays for itself — it is the only guard on the eviction rule. Nothing in it restates the implementation or verifies a mock, so nothing was cut. No test was added either: no defect was found that needed reproducing, and the remaining contracts are covered by construction (a forgotten name scores 0 through the existing `getScore` miss path) or need a controllable clock the service does not have (the recency tie-break — the existing `NOTE:` already says so). The decay-release and zero-cap behaviours were verified by running a throwaway probe rather than by adding permanent tests: both are restatements of `computeScore` and of a documented config reading, not branching logic a future edit could silently break.

**Nothing was filed, and nothing needed a new tripwire.** No finding reached the filing bar: the two design limits are recorded at the `peers` map with their revisit condition (an authenticated membership layer), and the scan cost is a tripwire already sited at `pickEvictionVictim` — sharpened here rather than duplicated as a ticket. The two doc gaps and the zero-cap question were minor and are fixed inline. The class-level question — "is every wire-keyed collection in `db-p2p` bounded at its ingress?" — was considered for a boundary-invariant ticket and rejected: the convention is already carried at each such site (the address caps in `packages/db-p2p/src/peer-address-book.ts`, the engine registry in `packages/db-p2p/src/cohort-topic/host.ts`, the retention cap in `packages/db-p2p/src/cluster/commit-cert.ts`, the seen-ledger cap in `packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts`), and no mechanical check can distinguish an attacker-keyed map from an ordinary one, so a ticket would be a search rather than a fix.

**Pre-existing, untouched, and not caused here.** `IPeerReputation.recordSuccess` has no production caller anywhere under `packages/*/src` — the only `recordSuccess` hits are unrelated methods on `PartitionDetector` and `RestorationCoordinator`. Nor does `resetPeer`, which the implement handoff already noted. Both predate this change and neither is made worse by it; the cap is correct for them either way. Not filed: an unused method on a service's public interface is a design question, not a defect.

## Verification

- `yarn workspace @optimystic/db-p2p test`: 3114 passing, 63 pending (pre-existing skips / env gates), 0 failing — both before and after the review's edits.
- `npx tsc --noEmit -p packages/db-p2p/tsconfig.json`: clean.
- `npx eslint packages/db-p2p/src/reputation packages/db-p2p/test/peer-reputation.spec.ts`: clean.
- `yarn lint:docs`: 47 documents, 178 anchored citations, 679 file mentions, 394 links — all resolve.
- Not run, as in the implement stage: `yarn check` from the root and `yarn test:integration`. The review's own edits are comments and prose only; the change's behaviour is confined to `PeerReputationService`, which is unchanged below the cap.
