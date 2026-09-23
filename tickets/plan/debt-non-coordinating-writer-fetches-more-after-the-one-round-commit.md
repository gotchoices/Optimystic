description: After the one-round tail-and-blocks commit landed, sereus's relay measurement saw the party whose inserts are not coordinated locally make slightly more /repo fetches per insert (1–4 before, 3–6 after), while the other party's fell. Possibly that party now fetches the log tail itself because it no longer holds it from a separate tail round. Not a correctness problem; each extra fetch is a round trip over a relay.
files:
  - packages/db-core/src/transactor/network-transactor.ts (`commit` one-round path, `commitInOneRound`)
  - packages/db-core/src/collection/collection.ts (post-commit refresh / tail reads)
  - packages/db-p2p/src/repo/coordinator-repo.ts (get path that turns into /repo fetches)
repro: measured
severity: performance
likelihood: common
tradeoffs: Cutting a fetch may mean caching the tail the writer just sent, which has to stay correct when the commit was refused or torn.
----
# The non-coordinating writer fetches more after the one-round commit

## Observed (sereus, relay re-measure, optimystic `cadcb919` vs `012573a2`)

Two single-node parties over a loopback relay, A's link through a counting proxy, 10 inserts each:

- A inserts: 9 /cluster + 1–3 /repo → 4 /cluster + 0–2 /repo.
- B inserts: 9 /cluster + 1–4 /repo → 4 /cluster + **3–6 /repo**.

Everything else improved (insert latency with 150 ms each way roughly halved; TornActionError on concurrent storage-joiner pairs 5/12 → 0/12). Sereus's guess: with the tail merged into the one commit round, B fetches the tail itself afterwards.

## To do

Count, on a two-node mesh, the `/repo` gets each side makes around one insert before and after `f8dab0ca` (the one-round commit), identify which block ids the extra gets are for and who asks, and decide whether the writer can reuse what it just committed instead of re-reading it. Add a delivery-count assertion for gets alongside the existing /cluster count test if a cut is made.
