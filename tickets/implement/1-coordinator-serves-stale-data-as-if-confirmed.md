description: When a node can't check whether its copy of a shared table is current, it hands out the copy anyway as if it were confirmed. The node reading it has no way to tell, so it keeps working from out-of-date data forever and nothing ever reports a problem.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-core/test/network-transactor.spec.ts
difficulty: hard
repro: verified
----

# A coordinator serves stale content as if it were confirmed

Promoted from `fix/collection-view-forks-silently-when-repair-cannot-reach-quorum`. That
ticket's field evidence (three peers, one frozen collection view, five captured failing
boots in the Sereus repo) is not repeated here; what follows is the mechanism reproduced
locally in this repo, and the fix.

## What was reproduced here

Two scratch mocha files (written, run, deleted — the exact source is inlined below, since
it is what the new specs should become).

### Arm 1 — `CoordinatorRepo.get` discards an inconclusive verdict for a PRESENT block

Cohort of three: self (`B`) holds rev 1; `A` answers rev 2; `C`'s consult rejects.
One claim, corroborator capacity 2, `CORROBORATION_FLOOR` 2 → `selectQuorumRev` declines.
Observed log, character-for-character the field signature:

```
cluster-tx:read-repair-triggered { blockId: 'default/CadrePeer', mode: 'paranoid', localRev: 1 }
cluster-fetch:peers-silent       { blockId: 'default/CadrePeer', silent: 1, consulted: 3 }
cluster-fetch:no-quorum          { blockId: 'default/CadrePeer', responders: 1, required: 2, repairCorroborationClusterSize: 3 }
cluster-tx:read-repair-noop      { blockId: 'default/CadrePeer' }
```

and the entry actually returned:

```json
{"block":{...},"state":{"latest":{"actionId":"old-action","rev":1}}}
```

No `unavailable`. `NetworkTransactor.get`'s `isAuthoritative` accepts it, never retries,
and the reader has no way to learn that a reachable peer just claimed rev 2.

The cause is one line of control flow: `coordinator-repo.ts:378` consumes the
`inconclusive` verdict only under `if (isMissing && inconclusive)`. The stale-but-present
case falls through unflagged. Worse, `queryClusterForLatest` (line 728) throws the raw
`claims` away entirely on the `no-quorum` path, so the higher revision `A` reported is not
even visible to the caller.

### Arm 2 — a flagged block still wins the merge, so flagging alone changes nothing

Even with Arm 1 fixed, `NetworkTransactor.get`'s `rankOf`
(`network-transactor.ts:230`) scores **any** entry with `block != null` as 2. The flagged
stale block from the first coordinator and the confirmed fresh block from the retry
coordinator therefore tie, and only a strictly-greater rank replaces the incumbent — so
first-arrival (the stale one) wins. Reproduced: the retry round *did* run
(`findCoordinatorCalls === 2`) and the merged entry was still

```json
{"block":{...,"v":"old"},"state":{"latest":{"actionId":"old-action","rev":1}},"unavailable":"peers-unreachable"}
```

### Why this freezes a whole collection view

`Collection.updateInternal` is the only thing that can unstick a lagging collection, and
it re-reads with a **fresh** `TransactorSource` whose `actionContext` is `undefined` — an
unpinned "give me latest" read. That read goes: header → `bootstrapContext` → the
collection's committed **tail block** → the node's own coordinator → stale local answer,
served authoritatively. `getActionContext` then finds nothing new, `advanceContext` has
nothing to adopt, and the collection's revision never moves. Every subsequent read through
`this.source` is pinned to that frozen revision (`transactor-source.ts:40`) and is
*correct given the pin* — which is why the field probe found that pinning the coordinator
to a healthy peer changed nothing. The unpinned tail read is the one seam where the truth
could have arrived, and it is exactly the read this defect corrupts.

## The shape of the fix

Three arms, one seam: **an answer's confidence has to survive from the coordinator that
formed it, through the merge, to the reader that acts on it.**

### 1. Represent "present, but possibly behind" as its own fact

`GetBlockResult.unavailable` cannot carry this. Its documented meaning is *"why a repo
could not establish whether a block EXISTS"* (`struct.ts:151`), and every consumer keys
off `block == null` alongside it (`getStatus`, `TransactorSource.tryGet`,
`Collection.bootstrapContext`). Overloading it would make a block-carrying entry mean two
different things at the same site.

Add a separate optional field to `GetBlockResult`, e.g.

```ts
/** Set when this repo served committed content it could NOT confirm is current: its
 *  freshness consult came back inconclusive AND a cohort peer claimed a strictly higher
 *  revision than the one served. Carries that claimed revision — the claim is
 *  UNCORROBORATED (it failed the read-repair quorum) so it is evidence of doubt, never a
 *  revision to adopt. Distinct from `unavailable`, which is about EXISTENCE: the content
 *  here is real, it may just be behind. */
unconfirmedAheadRev?: number;
```

Name is not load-bearing; the three properties are: separate from `unavailable`, optional
(absent = confirmed, so every existing producer keeps its meaning), and carrying the
claimed revision rather than a bare boolean. It crosses the wire for free — the repo
service JSON-serializes the whole result (`repo/service.ts:283`).

### 2. Set it in `CoordinatorRepo`, narrowly

`queryClusterForLatest` must surface the highest *uncorroborated* claim alongside what it
already returns, `fetchBlockFromCluster` must pass it up, and `get` must stamp it on the
entry when **all** of these hold:

- the block is present locally (`!isMissing`) — the missing case is already handled by
  `flagUnconfirmedAbsence`;
- the repair pass did not converge (the local revision did not advance);
- some cohort peer claimed a revision strictly greater than the local one;
- **and the caller asked for a view that should contain that revision**: either
  `blockGets.context` is undefined (an unpinned "latest" read) or
  `blockGets.context.rev >= claimedRev`. A read pinned *below* the claim is being served
  correctly and must not be stamped — this is what keeps the collection's own
  context-pinned data reads quiet while the unpinned tail read speaks up.

Deliberately narrow. Note what it does **not** cover: a cohort that is merely silent and
claims nothing. That case has an existing pin —
`coordinator-repo-unavailable.spec.ts:376`, *"keeps a merely-STALE block authoritative
even when a cohort peer is silent"* — and it stays green under this rule, because there is
no higher claim. Verify that; if it goes red, the rule has been widened past this ticket.

`ActionContext.rev` and a block's `state.latest.rev` are compared directly above. They do
share one per-collection counter today (`bootstrapContext` seeds the context straight from
the tail block's `latest.rev`; `syncInternal` commits every block of an action at
`context.rev + 1`). Confirm that before relying on it — if it does not hold, fall back to
stamping only on the unpinned (`context === undefined`) read, which is the case that
matters.

### 3. Rank a confirmed answer above an unconfirmed one, and retry on it

In `NetworkTransactor.get`:

- `rankOf` gains a level so a block-carrying entry with no doubt marker outranks a
  block-carrying entry with one — roughly: confirmed block 3, unconfirmed block 2,
  authoritative absent 1, `unavailable` absent 0. Content still beats absence.
- `isAuthoritative` must treat the new marker as not-answered, exactly as it treats
  `unavailable`, so the entry earns its second-chance round against a different
  coordinator.

### 4. Refuse to serve a doubted answer on an unpinned read

Once the retry round is done, if the surviving merged entry *still* carries the marker,
every reachable coordinator has said it may be behind. That is the state the fix ticket
demands not be silent. `TransactorSource.tryGet` should throw rather than return the
block — reuse `BlockUnavailableError` with a new `BlockUnavailableReason`, or add a
sibling error; either way it must not be a `StaleFailure`, so `Collection.sync` surfaces
it instead of absorbing it into its retry loop.

`Collection.bootstrapContext` reads the tail through `transactor.get` directly rather than
through `TransactorSource` and already hand-rolls its own `unavailable` check
(`collection.ts:653`) — it needs the same treatment, or the tail read stays silent.

Guard this on the read being unpinned. A pinned read view legitimately asks for an older
revision and must keep working; per arm 2 above the coordinator should not be stamping
those anyway, so this is belt-and-braces.

**Tradeoff to state plainly in the code:** this converts a silent wrong answer into a loud
failure for a node that can reach no coordinator able to confirm the block. That is the
point of the ticket, but it is a real behaviour change — a node in a partition that used
to read (stale) data now raises. The alternative is what the field failure did.

## What is NOT the fix

- **Do not relax `CORROBORATION_FLOOR` or `corroboratorCapacity`.** The two-corroborator
  rule is deliberate and its rationale is written out at
  `packages/db-p2p/src/cluster/quorum-restore.ts:66-89`: cohort views are unauthenticated,
  so talking the requirement down to one voter is precisely the attack it exists to
  prevent. The node in this failure is *supposed* to be unable to corroborate. The bug is
  that it does not say so.
- **Do not try to make the repair converge.** It cannot: the corroborator `B` is missing is
  `C`, and `C` is unreachable precisely because the record being repaired is `C`'s address.
  The dependency is circular by construction. Reading through to `A` on every read is
  degraded-but-correct and is the right outcome.

## Reproducer source

Drop these in as the starting point for the new specs (they are the scratch files that were
run to produce the output above, minus the `console.log`s). Both currently fail.

`packages/db-p2p/test/` — new case alongside the existing unavailable-vs-absent specs,
whose helpers (`makePeerId`, `makeClusterPeers`, `makeKeyNetwork`, `makeClusterClient`,
`writeStubs`, `makePresentStorageRepo`) it reuses verbatim:

```ts
it('flags a stale-present block when a reachable peer claims a higher revision it cannot corroborate', async () => {
  const peerB = await makePeerId();  // self — the forked node
  const peerA = await makePeerId();  // reachable, holds the newer revision
  const peerC = await makePeerId();  // unreachable — its address is the record being repaired
  const cluster = makeClusterPeers([peerB, peerA, peerC]);

  const callback: ClusterLatestCallback = async (peerId) => {
    if (peerId.equals(peerB)) return { actionId: 'old-action', rev: 1 };
    if (peerId.equals(peerA)) return { actionId: 'new-action', rev: 2 };
    throw new Error('dial failed');
  };

  const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
  const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, peerB, callback, { readRepairMode: 'paranoid' });

  const result = await repo.get({ blockIds: [blockId] });

  expect(result[blockId]?.block?.header.id, 'the local content is still served').to.equal(blockId);
  expect(result[blockId]?.unconfirmedAheadRev, 'but marked as possibly behind rev 2').to.equal(2);
});
```

`packages/db-core/test/network-transactor.spec.ts` — new case reusing that file's
`CountingKeyNetwork` and `makeGetOnlyRepo`:

```ts
it('prefers a confirmed block over another peer\'s unconfirmed one', async () => {
  const peerA = 'peer-A', peerB = 'peer-B'
  const net = new CountingKeyNetwork([peerA, peerB])
  const blockId = 'forked-block' as BlockId
  const staleBlock = { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId }, v: 'old' }
  const freshBlock = { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId }, v: 'new' }

  const staleRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
    const res: GetBlockResults = {}
    for (const bid of blockIds) res[bid] = { block: staleBlock, state: { latest: { actionId: 'old-action', rev: 1 } }, unconfirmedAheadRev: 2 }
    return res
  })
  const freshRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
    const res: GetBlockResults = {}
    for (const bid of blockIds) res[bid] = { block: freshBlock, state: { latest: { actionId: 'new-action', rev: 2 } } }
    return res
  })

  const networkTransactor = new NetworkTransactor({
    timeoutMs: 1000, abortOrCancelTimeoutMs: 500, keyNetwork: net,
    getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? staleRepo : freshRepo),
  })

  const result = await networkTransactor.get({ blockIds: [blockId] })

  expect(net.findCoordinatorCalls, 'the marker earned a retry round').to.equal(2)
  expect(result[blockId]!.state.latest!.rev, 'the confirmed answer wins the merge').to.equal(2)
  expect(result[blockId]!.unconfirmedAheadRev).to.equal(undefined)
})
```

## End-to-end check

`packages/db-p2p/test/two-node-convergence.integration.spec.ts` and the mesh harness's
`silentPeers` knob are the closest existing end-to-end shapes. A three-peer case where one
peer can reach only one of its two corroborators, asserting the lagging peer's collection
revision advances (or its read raises) rather than freezing, is the honest end-to-end proof
and belongs with this change if it can be built on the existing harness. The original field
reproducer lives in the Sereus repo
(`packages/integration-tests`, `src/scenarios/control-cohort-three-node-isolation.integration.ts`,
race — run it at least five times); it is out of this repo's reach and should not gate this
ticket.

## TODO

- [ ] Add `unconfirmedAheadRev` (name negotiable) to `GetBlockResult` in
      `packages/db-core/src/network/struct.ts`, documented as *confidence about currency*
      and explicitly contrasted with `unavailable` (*existence*).
- [ ] Return the highest uncorroborated claim from `CoordinatorRepo.queryClusterForLatest`
      on the `no-quorum` path and thread it through `fetchBlockFromCluster` to `get`.
- [ ] Stamp the marker in `CoordinatorRepo.get` under the four conditions above; confirm
      the existing pin at `coordinator-repo-unavailable.spec.ts:376` stays green.
- [ ] Verify the `ActionContext.rev` vs block `state.latest.rev` comparability assumption;
      if it does not hold, narrow the stamp to unpinned reads only and say so in a comment.
- [ ] Extend `rankOf` and `isAuthoritative` in `NetworkTransactor.get` so a confirmed
      answer outranks an unconfirmed one and an unconfirmed one earns the retry round.
- [ ] Throw from `TransactorSource.tryGet` when an unpinned read's surviving entry still
      carries the marker; give it a `BlockUnavailableReason` (or sibling error) that is not
      a `StaleFailure`.
- [ ] Give `Collection.bootstrapContext` the same check — it reads the tail through
      `transactor.get` directly and would otherwise stay silent.
- [ ] Add both specs above; add the three-peer convergence case if the existing harness
      supports it, and say so in the handoff either way.
- [ ] Record the behaviour-change tradeoff (a partitioned node that used to read stale data
      now raises) as a `NOTE:` at the `TransactorSource.tryGet` throw site.
- [ ] Update `docs/internals.md` where it describes the read path's authoritative/absent
      contract, so the three-valued answer (confirmed / unconfirmed / unavailable) is
      documented in one place.
- [ ] `yarn build && yarn typecheck && yarn test` from root; `yarn test:integration` if the
      new end-to-end case lands there.
