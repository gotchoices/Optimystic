description: When a node cannot find a piece of data, it reports one vague "couldn't check with the other machines" answer for three very different situations — including one where another machine has plainly said the data does exist. Give each situation its own name so the caller can tell them apart and react correctly.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, docs/internals.md
difficulty: hard
repro: verified
----

# Give a locally-missing block's absence a named verdict instead of one boolean

Supersedes fix ticket `isolated-read-cannot-confirm-a-never-written-block` and both of its arms.
Both arms resolve at the **same code site** — `CoordinatorRepo.get`'s missing-block flagging
decision (`coordinator-repo.ts:406-408`) and the `{ inconclusive: boolean }` value that feeds it
(`fetchBlockFromCluster`, `coordinator-repo.ts:575`) — so they land as one change.

## What is wrong

When a read finds a block missing in local storage, `CoordinatorRepo` asks the block's cohort
whether anyone holds it. That consult can end in several genuinely different states, but
`fetchBlockFromCluster` collapses them into a single boolean, `inconclusive`, and `get` maps that
boolean onto a single flag value, `unavailable: 'peers-unreachable'`. Two consequences, both
measured:

**Arm one — a node that reached nobody looks the same as a node that reached almost everybody.**
A node with zero connections reads a block it does not hold. Its cohort has two members: itself and
one peer it cannot dial. Self answers "I hold nothing", the peer is silent, so the consult is
inconclusive and the entry comes back `peers-unreachable`. `NetworkTransactor.get` reads that flag
as "ask a different coordinator", finds none, re-picks the same isolated node, gets the same
answer, and throws. The read can never succeed from local data — it needs a connection first — but
nothing in the answer says so. `'peers-unreachable'` means "retry elsewhere"; on an isolated node
there is no elsewhere.

**Arm two — an absence a peer has flatly contradicted is served as authoritative.** A block is
missing locally, one cohort peer answers with a revision (the block exists, at rev 2), the other
answers "I hold nothing", and nobody is silent. The corroboration quorum needs two votes and gets
one, so it declines — correctly, a lone unverifiable claim must never drive restoration. But
`fetchBlockFromCluster` then reports `inconclusive: false`, and `get` only consults the claim
(`claimedAheadRev`) on the *present*-block path. So the missing entry goes back **unflagged**: a
plain, authoritative "this block does not exist", handed to a reader that a peer has just told the
block does exist. That is the same lie the `coordinator-serves-stale-data-as-if-confirmed` work
removed for present blocks; the missing mirror was left untouched.

Note the two arms pull in opposite directions at the same site — arm one wants an absence believed
more readily, arm two wants it believed less. That is why they must be settled together, and why
the fix is a *representation* change rather than a threshold tweak.

## Reproduced

Verified in this repo with a scratch spec against `CoordinatorRepo` directly (deleted after the
run — its content is the basis of the new specs below). Both arms behaved exactly as described:

- Arm one: cohort `{self, peerA}`, `self` resolves `undefined`, `peerA`'s consult rejects, block
  missing → `unavailable === 'peers-unreachable'`, no block.
- Arm two: cohort `{self, peerA, peerB}`, `peerA` claims `{actionId: 'remote-action', rev: 2}`,
  `self` and `peerB` resolve `undefined`, nobody silent → `{ state: {} }` with **neither**
  `unavailable` nor `unconfirmedAheadRev` set.

Arm two's numbers, traced: non-self peers = 2, so `corroboratorCapacity(2, repairCorroborationClusterSize=3)`
= 3, and `quorumSize(claims=1, 0.51, 3)` = `max(min(2,3), floor(0.51 × 1))` = 2. One claim against a
requirement of two → `selectQuorumRev` declines → `uncorroboratedRev = 2`, `silent = []` →
`inconclusive: false`, `claimedAheadRev: 2` — a value `get` discards on the missing path.

## The shape of the fix

Replace the boolean with a verdict that names the evidence, and give each verdict its own
`BlockUnavailableReason`. Nothing about the fail-closed rule is reverted: an absence the
coordinator could not confirm is still never served as authoritative. What changes is that the
answer says *which kind* of unconfirmed it is, so the layers above can act differently.

### New type in `packages/db-core/src/network/struct.ts`

Extend `BlockUnavailableReason` with two values. All existing consumers test the field with
`!== undefined` only — there is no exhaustive `switch` over it anywhere in `db-core`, `db-p2p`, or
`db-quereus` (verified by grep), and the repo wire path passes `GetBlockResult` through without a
value whitelist — so this is purely additive.

```ts
export type BlockUnavailableReason =
	/** Records for this block exist here but it cannot be reconstructed locally … */
	| 'unmaterializable'
	/** Nothing is held locally; PART of the cohort answered and part could not be asked.
	 *  A silent peer could be the sole holder, so the absence is a guess — but other
	 *  coordinators are reachable, so asking one of them can still settle it. */
	| 'peers-unreachable'
	/** Nothing is held locally and NO cohort member outside this node could be asked at
	 *  all. Distinct from `peers-unreachable` in exactly the way that matters to a
	 *  caller: there is no better-connected coordinator to re-ask, so the answer will not
	 *  improve until this node's connectivity does. The local view is all there is. */
	| 'cohort-unreachable'
	/** Nothing is held locally, but a cohort peer positively CLAIMED a revision of this
	 *  block, and this node could neither corroborate that claim to a quorum nor acquire
	 *  the content. The block is known to exist somewhere; reporting it absent would be a
	 *  lie regardless of whether anyone was silent. */
	| 'claimed-elsewhere';
```

**Why `unavailable` and not `unconfirmedAheadRev` for the claimed case** (the design question the
fix ticket left open): the two markers are kept disjoint by meaning in `struct.ts` —
`unconfirmedAheadRev` says "the content I served is real, it may just be behind", `unavailable`
says "I could not find out whether this block EXISTS". A claimed-elsewhere entry has no content at
all, so it is an existence doubt. Two mechanical confirmations of the same call:
`flagUnconfirmedCurrency` bails on `typeof servedRev !== 'number'`, so it would no-op on a blockless
entry anyway; and `NetworkTransactor`'s merge ranking (`network-transactor.ts:244-246`) scores a
blockless entry carrying `unconfirmedAheadRev` at **1**, *below* a bare absent at **2** — so an
honest doubtful answer would lose the merge to a confident wrong one.

### New verdict inside `CoordinatorRepo`

```ts
/**
 * What one repair pass established about a block that is still MISSING locally after it.
 * Ordered by how firmly the block is ruled out; `get` consults it only on the missing path.
 */
type AbsenceVerdict =
	/** Nobody to ask (empty cohort, or solo-self), or every non-self cohort member answered
	 *  "I hold nothing". As confirmed as an absence gets — stays authoritative, which is what
	 *  keeps the routine new-collection probe at one round trip. */
	| 'confirmed'
	/** Some of the cohort answered, some could not be asked (or the consult threw outright). */
	| 'unconfirmed'
	/** No cohort member outside this node could be asked at all. */
	| 'isolated'
	/** A peer claimed a revision this pass did not converge onto — quorum declined it, or a
	 *  quorum corroborated it and acquisition failed. */
	| 'claimed';
```

`fetchBlockFromCluster` returns `{ absence: AbsenceVerdict; claimedAheadRev?: number }`; the
`inconclusive` field goes away. `get` maps, on the missing path only:

| verdict | flag |
| --- | --- |
| `confirmed` | none — authoritative absent (unchanged) |
| `unconfirmed` | `unavailable: 'peers-unreachable'` (unchanged) |
| `isolated` | `unavailable: 'cohort-unreachable'` |
| `claimed` | `unavailable: 'claimed-elsewhere'` |

Precedence when several apply: `claimed` > `isolated` > `unconfirmed` > `confirmed`. A peer
positively saying "it exists" is the sharpest fact available, so it outranks silence.

Deriving the verdict needs one fact `queryClusterForLatest` computes but does not return: how many
non-self peers **answered** (with a claim or with "I hold nothing"). It already computes
`peerIds.filter(id => id !== selfId).length` for the corroborator capacity at
`coordinator-repo.ts:846` — return that count (or the answered count directly) alongside `silent`,
and `answered = nonSelfCount - silent.length`.

Branch by branch in `fetchBlockFromCluster`:

- no `clusterLatestCallback`, empty cohort, solo-self short-circuit → `'confirmed'`
- no quorum corroborated:
  - `uncorroboratedRev !== undefined` → `'claimed'`
  - else `silent.length > 0` → `answered === 0 ? 'isolated' : 'unconfirmed'`
  - else → `'confirmed'`
- quorum corroborated and `corroborated.rev <= baselineRev` (the `local-current` early return) →
  same silence-based mapping as above. Only reachable when this node holds a revision, so the
  verdict is never actually consumed; compute it consistently rather than hard-coding.
- quorum corroborated and restoration ran → `rev === undefined` (convergence failed) → `'claimed'`;
  otherwise the silence-based mapping.

The `catch` arm of `get` (the consult **threw**, e.g. `findCluster` rejected) stays
`'unconfirmed'` → `'peers-unreachable'`. A cohort lookup that fails is a routing failure, not a
statement about how many cohort members this node could reach, and the existing spec pins it.

`claimedAheadRev` keeps its present meaning and its present use on the **present**-block path
(`recordAheadClaim` / `flagUnconfirmedCurrency`) — untouched.

## What this does and does not resolve

**Arm two is fully fixed**: an absence a peer has contradicted now carries a doubt marker, so
`NetworkTransactor` retries another coordinator and, failing that, throws
`BlockUnavailableError(blockId, 'claimed-elsewhere')` instead of returning a confident "does not
exist". This accepts the same availability tradeoff the present-block path already accepted and
documented at `coordinator-repo.ts:859-866`: one claim is enough to raise doubt, and a claim is a
bare assertion, so a single lying cohort peer can deny reads of a block by claiming a revision
nobody else holds. That lever already exists on the present path; extending it to the missing path
keeps the two halves consistent, and the same liar can already force the same outcome by staying
silent. A secondary, benign effect: a read that races the commit broadcast of a *brand-new* block
(one peer has it, the rest do not yet) now throws rather than reporting absent. That is a truthful
answer to a genuinely indeterminate question, and it clears as soon as a second peer has the block.

**Arm one is fixed as far as this layer honestly can go.** The read still fails — but it now fails
with `'cohort-unreachable'`, which says something `'peers-unreachable'` did not: *there is no
better-connected coordinator to re-ask; this node's own view is all the information that exists.*
That is the fact a caller needs in order to apply its own isolation policy.

The repo layer deliberately does **not** decide that an isolated node may believe its own emptiness.
There is no evidence-based rule that could justify it, and it is not a small risk:

- The ticket's "give absence the same threshold writes use" idea does not help the measured case —
  a two-member cohort with one answer is 0.5 of the cohort, under any super-majority bar.
- A node that reached nobody has *zero* information about the cohort. Serving its emptiness as
  authoritative is exactly the failure the fail-closed rule was added to prevent
  (`complete/2-cluster-read-consult-cannot-report-unreachable`): a freshly-rebooted or partitioned
  node would report every never-locally-seen block as absent. In the consuming product's case the
  block in question is a revocation tombstone table — reading it as "empty" would admit a revoked
  member.

So "is my own view good enough for *this* read, right now?" is a per-read policy question, and it
belongs to the caller that knows the answer. `BlockUnavailableError` already carries `reason`
verbatim out of `TransactorSource.tryGet`, `Collection.bootstrapContext`, and
`NetworkTransactor.get`, so a consumer can discriminate on it today with no further plumbing. The
consuming repo's boot path can catch `reason === 'cohort-unreachable'` on its start-up read and
proceed with an empty view under its own risk model — a decision it is entitled to make and this
layer is not. **State this explicitly in the review handoff** so it is not mistaken for an
oversight; the isolated boot does not start working merely because this ticket lands.

The alternative considered and rejected: plumbing the "the key network picked a degraded self
because we are isolated" bit from `Libp2pKeyPeerNetwork.findCoordinator` down into
`CoordinatorRepo.get`. It runs the decision backwards through the read path (coordinator selection
happens in `NetworkTransactor`, before the repo is dialled), it needs a new field on
`MessageOptions` that means "trust me, I am isolated", and it arrives at the same place —
believing an isolated node's emptiness — with more machinery and a weaker audit trail. Asking the
consult itself "did I reach anyone?" is the same question answered from first-hand evidence.

## Existing specs whose expectations change

Both are correctness-preserving refinements (a sharper reason for the same state), and every
consumer tests `unavailable !== undefined` rather than the value, so no behavior downstream
changes. Update the assertion **and** the explanatory comment in each:

- `coordinator-repo-unavailable.spec.ts:336` — "flags a locally-missing block peers-unreachable
  when the sole cohort peer never answers (per-peer deadline)". Cohort is `{self, peerA}` and
  `peerA` hangs, so no non-self peer answered → now `'cohort-unreachable'`. Rename the spec.
- `coordinator-repo-unavailable.spec.ts:649` — "flags a locally-missing block peers-unreachable
  when the cohort corroborates a revision this node cannot acquire". Nobody is silent and the
  cohort positively attested the block → now `'claimed-elsewhere'`. Rename the spec.

Unchanged and must stay unchanged (guard against over-reach):

- `:199` consult throws → `'peers-unreachable'`.
- `:268` whole cohort answers "holds nothing" → **no flag**. This is the new-collection probe;
  breaking it makes creating any collection impossible.
- `:313` cohort `{self, peerA, peerB}`, `peerA` rejects, `peerB` answers → `'peers-unreachable'`
  (one peer did answer, so this is not isolation).
- `:286` storage's `'unmaterializable'` is never overwritten.
- `:297` `skipClusterFetch` reads are never flagged.
- `:406` a callback that swallows a dial failure into `undefined` still yields an authoritative
  absent — the contract boundary.
- The whole `stale-present blocks` describe — the present-block path is untouched by this ticket.

## TODO

Phase 1 — representation

- Add `'cohort-unreachable'` and `'claimed-elsewhere'` to `BlockUnavailableReason` in
  `packages/db-core/src/network/struct.ts`, with doc comments that spell out how each differs from
  `'peers-unreachable'` (the names are close; the comment is what keeps them apart).
- Add the `AbsenceVerdict` union to `coordinator-repo.ts` with the doc comment above.
- Return the non-self peer count (or the answered count) from `queryClusterForLatest` — reuse the
  filter already at `coordinator-repo.ts:846` rather than recomputing it.
- Change `fetchBlockFromCluster`'s return type from `{ inconclusive: boolean; claimedAheadRev?: number }`
  to `{ absence: AbsenceVerdict; claimedAheadRev?: number }` and set the verdict on every return
  path per the branch list above. Update the method's doc comment — it currently documents
  `inconclusive` at length.

Phase 2 — the flagging decision

- Give `flagUnconfirmedAbsence` a `reason: BlockUnavailableReason` parameter (it hard-codes
  `'peers-unreachable'` at `:456` and `:458`). Keep its existing no-op guards exactly as they are —
  the `entry.block !== undefined` test and the `state.latest` test both carry load, documented at
  `:437-452`.
- In `get`, replace `if (isMissing && inconclusive)` with the verdict→reason mapping; leave the
  `!isMissing` branch alone.
- In `get`'s `catch` arm, keep the missing case at `'peers-unreachable'`.

Phase 3 — tests

- Add to `coordinator-repo-unavailable.spec.ts`, in a new describe for this ticket:
  - missing block, cohort `{self, peerA, peerB}`, `peerA` claims `{rev: 2}`, `self`/`peerB` resolve
    `undefined`, nobody silent → `unavailable === 'claimed-elsewhere'`, and
    `'unconfirmedAheadRev' in entry === false` (the two markers stay disjoint).
  - same but `peerB` also rejects → still `'claimed-elsewhere'` (a claim outranks silence).
  - missing block, cohort `{self, peerA}`, `peerA` rejects → `'cohort-unreachable'`.
  - missing block, cohort `{self, peerA, peerB}`, both remotes reject → `'cohort-unreachable'`
    (isolation is about how many were reached, not how large the cohort is).
  - missing block, cohort `{self, peerA, peerB}`, `peerA` rejects and `peerB` answers "holds
    nothing" → `'peers-unreachable'`, pinning that partial reach is NOT isolation. (Overlaps `:313`
    on purpose — that spec asserts the flag exists, this one asserts which of the three it is.)
- Update the two specs named above.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p.log` and
  `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core.log` (stream, do not silently
  redirect), plus `yarn typecheck`.

Phase 4 — docs and tripwires

- Update `docs/internals.md:524-527` — it currently says `CoordinatorRepo.get` flags
  `'peers-unreachable'` for all three inconclusive shapes. Replace with the verdict table, and add
  the sentence about why an isolated node's absence still is not authoritative.
- Add a `NOTE:` at `NetworkTransactor.get`'s second-chance retry (`network-transactor.ts:171-183`):
  a `'cohort-unreachable'` entry earns the retry like any other flagged entry, and on a genuinely
  isolated node that retry re-picks the same node and repeats the same futile consult (the
  `findCoordinator:all-excluded` path). Fine today — it is one extra bounded consult on an already
  failing read. If isolated-node read latency ever matters, skip the retry for that reason rather
  than widening `isAuthoritative`.
- Add a `NOTE:` at the `catch` arm in `CoordinatorRepo.get` recording that a consult that *throws*
  is reported `'peers-unreachable'` even on an isolated node, because a failed cohort lookup says
  nothing about how many members were reachable. If `findCluster` on an isolated node turns out to
  throw routinely rather than returning a stale cohort view, revisit — that would put the isolated
  case back under the vaguer reason.
