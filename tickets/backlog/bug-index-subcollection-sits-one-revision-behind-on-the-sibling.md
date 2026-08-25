----
description: When two machines each insert a row under the same secondary-index key, each machine's copy of the index sub-collection ends up at a different revision and each finds only its own row through the index — while both machines' copies of the main table collection agree and a full scan on either machine sees both rows. The index tree is refreshed immediately before the read and the refresh does not close the gap.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the live-arm refresh ~845; logIndexSeek ~989; openIndexTree ~2443)
  - packages/db-core/src/collection/collection.ts (updateInternal ~246 — the log fetch that is expected to advance the revision)
  - packages/db-core/src/logger.ts (no peerId parameter — see "What this measurement cannot tell you")
  - packages/db-p2p/src/logger.ts (the peerId-suffix mechanism this diagnosis needs, and its own NOTE inviting exactly this use)
difficulty: hard
severity: silent-wrong-answer
likelihood: deterministic-in-the-reporting-repo
repro: measured downstream, not yet reproduced here
----

# An index sub-collection sits one revision behind on the sibling, and a live refresh does not close it

Measured in the `sereus` repo on 2026-08-25 with the three traces this repo landed for exactly this
purpose (`commit:collections`, `index:tree-open`, `index:seek`). This is the **eighth** report on
this symptom and the first one carrying read-side revisions, so please read the numbers before
reaching for any of the seven hypotheses already eliminated.

Scenario: `strand-formation-concurrent-redemption` — two machines concurrently insert into
`FormationUsage` (primary key a per-redemption nonce) under one shared `FormationUsageByToken`
index key, then each machine reads back `where Token = ?`. Both inserts commit. Each machine's
read returns only the row it wrote itself, forever, with no error.

## What the trace shows

Both machines resolve the **same** index collection id — `index:tree-open` prints
`table=FormationUsage index=FormationUsageByToken uri=tree://default/FormationUsage/index/FormationUsageByToken
collection=default/FormationUsage/index/FormationUsageByToken` and nothing else. So this is not two
differently-named trees.

At the failing read, `index:seek` on the two machines (attribution below):

| | case 1 | case 2 |
| --- | --- | --- |
| node A, index `rev=` | **3** | **4** |
| node B, index `rev=` | **2** | **3** |
| node A, `main_rev=` | 2 | 4 |
| node B, `main_rev=` | 2 | 4 |
| `matched=`, both nodes | 1 | 1 |
| `arm=` | live | live |
| `seek=` | identical on both nodes | identical on both nodes |

Read that against `docs/debugging.md`'s own decision table:

- **The main table collection agrees across the two machines** (`main_rev=` equal) while **the index
  sub-collection differs by exactly one revision**. Same instant, same process, same two nodes.
  That is the whole finding in one line: whatever advances the main collection on a non-writing
  machine is not advancing the index sub-collection.
- **`arm=live`, so `update()` ran on both trees immediately before the descent** (module.ts ~845
  awaits `mainTree.update()` and `indexTarget.tree.update()` in the same block). The gap survives
  it. Node A emitted ~100 of these lines over a 30 s poll at 250 ms and `rev=` never moved once.
- **`matched=1`, not 0.** The descent is not blind and the tree is not empty — it finds exactly the
  one entry that machine wrote. This retires the framing every previous report used ("the index
  root stays at its schema-init empty state", "every index descent honestly finds nothing").
- **`seek=` is byte-identical on both machines**, so key framing is not involved.

The four `commit:collections` lines for this table in the run, in order:

```
count=2 default/FormationUsage=staged default/FormationUsage/index/FormationUsageByToken=staged revs=default/FormationUsage:none,default/FormationUsage/index/FormationUsageByToken:1
count=2 default/FormationUsage=staged default/FormationUsage/index/FormationUsageByToken=staged revs=default/FormationUsage:1,default/FormationUsage/index/FormationUsageByToken:2
count=2 default/FormationUsage=staged default/FormationUsage/index/FormationUsageByToken=staged revs=default/FormationUsage:2,default/FormationUsage/index/FormationUsageByToken:3
count=2 default/FormationUsage=staged default/FormationUsage/index/FormationUsageByToken=staged revs=default/FormationUsage:2,default/FormationUsage/index/FormationUsageByToken:2
```

Every write carries the index collection, staged — the claim that the index was absent from the
write transaction was already refuted on 2026-08-25 and this confirms it again. Note the **fourth**
line: it bases on index revision 2, which the second line had already consumed.

## What this measurement cannot tell you, and the one thing to add

**`index:seek`, `index:tree-open` and `commit:collections` carry no node identity.** They are logged
through `db-core`'s `createLogger`, which has no `peerId` parameter, and both machines run in one
process in every integration test. The A/B attribution in the table above is **positional, not from
the log**: the scenario polls node A for 30 s (hence the ~100 consecutive identical lines) and then
reads node A and node B once each in its failure handler, so the trailing pair is node B. That is
sound for the read side and it is *not* available for the four commit lines above.

So the decisive question is still open:

- **Is there one lineage that node B failed to follow** (B stale, A current because A wrote last), or
- **are there two independent lineages under one collection id**, each counting its own revisions —
  in which case the fourth commit basing on revision 2 after the second commit already landed
  revision 3 is that second lineage, not a conflict.

Those two have the same read-side fingerprint and different fixes, and nothing printed today
separates them.

**The ask: thread a peer id through `db-core`'s `createLogger` for these three lines**, the way
`db-p2p`'s already does. `packages/db-p2p/src/logger.ts` carries the mechanism and a NOTE that says
in as many words: *"only a few call sites pass a peer id today … Thread a peer id through any of
them if a future diagnosis needs per-node attribution from that subsystem — the mechanism is already
here."* This is that diagnosis. With attribution on `commit:collections`, the lineage question is
answerable from a single run of the reporting repo's scenario, which is the only place the defect
reproduces.

## Ruled out downstream, so you need not ask again

- **The write-through raw-storage cache is not involved.** The reporting repo wraps storage in
  `CachedRawStorage`, but its `wrapStorageWithCache` returns `MemoryRawStorage` **unwrapped** on this
  repo's own guidance, and the integration harness uses `MemoryRawStorage` throughout. The cache is
  not in the failing path at all.
- **The corroboration floor is not involved** — that repo declares `assumedClusterSize: 2` in both
  cluster policies and has since 2026-08-02.
- **Not transport, not write concurrency, not cluster-size configuration, not composite text primary
  keys, and not an untested shared index key** — all seven previous reproduction attempts here
  covered those, which is precisely why the remaining explanation had to be found on the read side.
