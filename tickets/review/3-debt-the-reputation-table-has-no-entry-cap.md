description: The list a machine keeps of how other machines have behaved is now capped at a fixed number of entries, so a stranger can no longer grow it without limit by sending messages that name made-up machines.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.getOrCreateRecord`, `evictOne`, `pickEvictionVictim`, `refuseNewRecord`; the `NOTE:`s on the `peers` map and on the victim scan)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig.maxPeers`)
  - packages/db-p2p/test/peer-reputation.spec.ts (the one new test)
  - docs/architecture.md (`Reputation & equivocation` — one sentence added)
----
# Review handoff: the reputation table has an entry cap

## What changed

`PeerReputationService` keeps one record per other machine it has formed an opinion about. The names come off the wire (a bad-signature report names whichever machine the signature is attributed to, and anyone can mint a keypair), and nothing ever removed a record. It is now capped.

- `ReputationConfig.maxPeers` (optional, default 1024) in `types.ts`, read in the constructor.
- `getOrCreateRecord` is still the only place a record is created and is now the only place the cap is enforced. It returns `PeerRecord | undefined`; `reportPeer` and `recordSuccess` return early on `undefined`, so no caller changed shape.
- When the table is full and a new name needs a record, `pickEvictionVictim` chooses one record to forget, in this order: never a record whose current score is at or above the ban threshold; otherwise the lowest current score; ties go to the least recently touched (`max(lastPenalty, lastSuccess)`). It uses the existing `computeScore` and adds no stored field. Map iteration is insertion order and the comparisons are strict, so a full tie also falls to the oldest entry.
- If every record is banned there is no victim: the new name is not recorded, the report is dropped, and `refuseNewRecord` logs one `peer-reputation` line with the cap and a running count. Same pattern as `refuseSelfReport`: counted, never acted on.
- The old `NOTE:` on the `peers` map (which named this ticket) is replaced by a description of the cap plus the two accepted limits (only bans are protected; a table full of ban-weight records refuses genuine new offenders until those decay). The third accepted limit, the per-creation scan cost, is a tripwire `NOTE:` at `pickEvictionVictim`, where its site is.
- `docs/architecture.md` § Reputation & equivocation gained one sentence. `yarn lint:docs` passes.

Not touched, as the ticket asked: `refuseSelfReport` / the `isSelf` guard in `recordSuccess` (own identifier still never occupies a slot), the writers in `cluster-repo.ts` and `traffic-validation.ts`, and the open residual about unauthenticated peers reaching the signature check.

## Test

One test added in `packages/db-p2p/test/peer-reputation.spec.ts`: "bounds the table without ever forgetting a banned peer, and refuses new names once every record is banned". With `maxPeers: 4` it checks that:

- a banned record survives a spray of 20 fresh names;
- the table never exceeds the cap at any step;
- the success-only record (score 0, the lowest) is the one forgotten;
- once every remaining record is banned, a new name is refused, the size stays at the cap and the offender is still banned.

It uses the default half-life on purpose. The ticket suggested a short one, but a short half-life would let the first ban decay mid-test and flake the "survives the spray" half; the ms-scale test runs far inside a 30-minute half-life. Not tested, by design: the default value, config plumbing, and the recency tie-break (it would need a controllable clock, and the service has none; see the existing `NOTE:` in the file).

## Verification run

- `yarn test` in `packages/db-p2p`: 3114 passing, 63 pending (pending were already skipped/env-gated), 0 failing.
- `tsc --noEmit` in `packages/db-p2p`: clean.
- `yarn lint:docs` from the root: all resolve.

## Known gaps and things for the reviewer to look at

- Not run: `yarn check` from the root, and the integration specs (`test:integration`); nothing in this change touches those paths beyond `PeerReputationService`'s public behaviour, which is unchanged when the table is under the cap.
- The cap is not validated. `maxPeers: 0` (or negative) makes the table refuse every new name, since `size >= 0` is always true and there is never a victim. That reads as "keep no records" and I left it rather than clamping; say if you would rather clamp to at least 1.
- Refusal logs one line per refused report. The logger is the debug-gated `createLogger('peer-reputation')`, so it is silent unless enabled, but under an active spray of an all-banned table it would be chatty. The ticket asked for one line with a running count, so I followed it.
- A `resetPeer` still has no caller in `packages/*/src`; the cap makes that harmless rather than fixing it, and nothing here changes it.
- The eviction victim is chosen with `computeScore`, which calls `Date.now()` per record, so the scores in one scan use slightly different clocks. The differences are microseconds against a 30-minute half-life, so this cannot reorder anything that matters; noting it for completeness.
