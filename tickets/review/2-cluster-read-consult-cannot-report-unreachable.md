----
description: When a machine looks for a piece of data it does not have locally, it asks the other machines that should have a copy. Their silence used to be treated as them saying "that data does not exist"; now the asking machine reports "I could not find out" instead, so callers retry elsewhere rather than inventing a fresh empty collection over data that really exists.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts
repro: verified
----

# Cluster read consult now reports silence as silence — review handoff

## What was wrong (now verified, was `repro: static`)

`CoordinatorRepo.get` consults the cohort for any block missing locally, then reports either an
**authoritative absent** (`{ state: {} }`, final — `NetworkTransactor` never retries it, and
`Collection.createOrOpen` takes it as licence to create a fresh empty collection) or
**`unavailable: 'peers-unreachable'`** ("my answer is a guess" — re-enables retry against another
peer). Before this change, two collapses made a slow or unreachable peer indistinguishable from a
peer answering "I hold nothing":

- the libp2p `ClusterLatestCallback` caught every transport error and returned `undefined` — the
  same value it returns when the peer genuinely holds nothing;
- the per-peer 1-second timeout in `queryClusterForLatest` *resolved* `undefined` instead of
  rejecting, so a slow peer looked identical to an absent claim.

Result: in a two-node cohort, one slow/dead peer and the reader confidently reported a block
absent that the silent peer alone held. The measurement the ticket asked for was taken: the new
tests were run against the pre-fix `coordinator-repo.ts` (temporary file swap, restored after) and
all four silence scenarios reported an unflagged authoritative absent; with the fix they flag
`peers-unreachable`. The must-stay-authoritative scenarios pass in both worlds.

## Design decisions (the ticket asked these to be recorded)

**Where the three-way state lives — the smaller option.** `ClusterLatestCallback`'s signature is
unchanged (`Promise<ActionRev | undefined>`); its *contract* is now three-way and documented on the
type: resolve an `ActionRev` = claim, resolve `undefined` = the peer answered "I hold nothing"
(absent claim), REJECT = the peer could not be asked (silence). The libp2p implementation no longer
swallows transport errors (`sync/service.ts` answers `success:false` for a genuinely missing block,
so a responding peer without data still resolves `undefined`). The consult's per-peer race switched
from `withTimeout` (resolve-undefined, now deleted) to `withDeadline` (reject), so a timeout is
silence too. `queryClusterForLatest` correlates `Promise.allSettled` rejections back to peer ids by
index and returns `silent: string[]` on `ClusterLatestQuery`; `fetchBlockFromCluster` reduces that
to `{ cohortSilent: boolean }` for `get`.

**Threshold — any silence, fail-closed.** One silent non-self cohort peer flags the consult. The
silent peer could be the sole holder, so any weaker rule re-opens the defect. Cost: while a peer is
actually unreachable, every read of a locally-missing block in its cohort earns a transactor-level
retry against another coordinator (and, retries exhausted, a thrown `BlockUnavailableError` instead
of an invented empty collection). On a large cohort a single flapping peer makes every
missing-block read retryable; acceptable because the flag clears the moment the peer answers, and
correctness beats the round-trip.

**A restored block needs no flag.** If the remaining responders corroborate a revision and the
acquisition lands it, the read serves a real answer — silence elsewhere in the cohort is moot. The
flag applies only to a block STILL missing after the consult, only when it was missing before it
(a merely-stale block keeps its authoritative local answer), and never over storage's sharper
`unmaterializable` flag.

**Self is not a cohort peer for silence purposes.** The callback's self short-circuit reads local
storage; a local read error is not "a peer was unreachable", and self was already excluded from
claims. A self rejection is simply ignored.

**Mesh harness.** New `MeshFailureConfig.silentPeers`: the harness's `ClusterLatestCallback`
rejects for those peers (mirroring a dial failure), and `makeReconcileBlock` skips them as a byte
source so a test cannot accidentally converge *through* a peer it silenced. Distinct from the
existing `failingPeers`, which fails cluster (write) updates.

**Wire/consumer compatibility.** `unavailable: 'peers-unreachable'` is an existing field with
existing consumers — only its frequency changes. Checked `NetworkTransactor.get`: flagged entries
are retried against other peers and ranked below authoritative answers (block > absent > flagged);
nothing treats the flag as fatal where it previously saw an absent.

## Validation

- New unit specs in `test/coordinator-repo-unavailable.spec.ts` ("silent cohort peers" block):
  rejecting peer → flagged; sole peer hanging past the 1s deadline → flagged (the two-node field
  topology); quorum met past one silent peer → block served unflagged; stale block + silent peer →
  authoritative local answer kept; and a contract-boundary pin: a callback that swallows dial
  failures into `undefined` (the pre-fix shape) still yields an authoritative absent.
- New mesh-harness specs in `test/coordinator-repo-integration.spec.ts`: sole-holder-silent
  (the exact field defect), nobody-holds-it-but-peer-silent, and the healthy all-answered probe
  staying a one-round-trip authoritative absent.
- Full db-p2p suite: **1487 passing / 44 pending / 0 failing** (baseline 1479 + 8 new).
- `yarn test:integration` from root: db-p2p 30 passing / 2 pending; quereus plugin 339 passing /
  8 pending; 0 failing. Root `yarn build` clean.
- The stale NOTE at the old coordinator-repo.ts:368-372 (which documented exactly this gap) is
  replaced by the new flagging logic and its comment.

## Known gaps / what review should probe

- **Adjacent pre-existing gap, deliberately untouched:** a consult where the whole cohort answers,
  a revision IS corroborated, but the acquisition then fails (content quorum unmet, archive fetch
  errors) still reports an unflagged authoritative absent — nobody was silent, yet the reader has
  just learned the block exists. Marked with a greppable `NOTE:` at the flag site in
  `coordinator-repo.ts`. Static reading only, not reproduced; reviewer should judge whether it
  warrants its own ticket (no open ticket covers it — checked the board).
- The 1s per-peer deadline is inherited, not revisited. A WAN peer that legitimately needs >1s now
  counts as silent, which flags the read rather than mis-reporting it — safe direction, but it
  turns slow-but-honest cohorts into permanent retry traffic. Worth a thought, not a blocker.
- The deadline test sleeps ~1s of real time (no clock seam in the consult path); flagged in-test
  with an explicit `this.timeout(5000)`.
- Sereus re-measurement (the embedding application where the failure was observed) still needs
  both this and the sibling `collection-forgets-revision-on-absent-header` — that sibling has
  landed (see its review/complete ticket), so re-measuring is now unblocked but not yet done.
- `plan/stale-failure-carries-coordinator-revision` remains a third, independent improvement to
  the same diagnosis chain; nothing here depends on it.
