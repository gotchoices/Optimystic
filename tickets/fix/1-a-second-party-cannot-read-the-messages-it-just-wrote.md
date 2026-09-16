description: On two real phones joined into one shared strand over a relay, the joining party could not read any message — not even one it had written itself moments earlier — while the membership rows travelling the same path worked fine. Find out why one collection resolves and the other does not.
prereq:
files:
  - packages/db-p2p/test/two-phones-over-relay.integration.spec.ts (the closest existing scenario: two phone-shaped peers over a circuit relay; it writes and replicates, so it is the place to start reproducing)
  - packages/db-p2p/test/util/two-machine-lifecycle.ts (shared helpers for two-machine phases, reads, writes and locality checks)
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet` — where `unavailable` becomes `BlockUnavailableError`)
  - packages/db-core/src/collection/collection.ts (`updateInternal` — the refresh a live read performs first)
  - packages/db-p2p/src/libp2p-key-network.ts (`findCluster` — how a node decides which peers are responsible for a block; the asymmetry between two collections has to come from here or from what is passed to it)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy` — the sizes and the repair yardstick a formed strand ends up with)
  - tickets/backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds.md (the related design question; read it before concluding this is the same thing — it is not obviously the same)
difficulty: medium
----

# What was seen, and on what

Reported 2026-09-16 by the session driving the **sereus React Native reference app on a physical
Android phone**, at the end of that night's scenario run. Two parties formed one shared strand across
a **circuit relay**. The joining party's reads failed with:

```
Block default/Message is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
```

**It could not read back a message it had just written itself.** Membership rows crossed the same
path, between the same two peers, over the same relay, without trouble.

That session filed `fix/cross-party-strand-messages-do-not-converge` in the sereus repository and
raised the question of whether the cohort resolution for a formed strand is an optimystic-side
problem. This ticket exists to answer that.

# Why this is not simply the isolated-read design question

`backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds` covers a
node **cut off** from its cohort, where a live read's refresh cannot complete. This is different in
two ways that matter:

- **The parties were connected.** Membership rows moved between them at the same time, so the
  transport was working. A cohort that is unreachable while another collection's cohort is reachable
  is not a connectivity story.
- **The unreadable block was written by the reader itself.** A node that cannot see its own write is
  the shape of `#20` (the settled-absence memo, fixed in `39ef5d4b`) rather than the shape of a
  partition — though the memo is gone, so if this is the same family it is a different mechanism.

Both are worth holding in mind, and neither should be assumed.

# What to establish, in order

1. **Reproduce it here.** Two peers over a real circuit relay, forming a shared collection set, one
   joining after the other — `two-phones-over-relay.integration.spec.ts` is the nearest shape.
   The distinguishing element is **two different collections in one strand**, one of which
   (membership) resolves and one of which (messages) does not. Reproduce that asymmetry before
   theorising about it; if it will not reproduce over sockets, say so and try the mesh with a relayed
   or restricted topology, and record what the difference implies.
2. **Compare the two collections' cohorts directly.** For the same block ids the phone used, log what
   `findCluster` returns for the membership collection and for the message collection, on both
   parties. The answer to this ticket is almost certainly in that comparison: same peers, different
   peers, or an empty set.
3. **Then ask why**, with the difference in hand. Candidates worth checking rather than guessing:
   whether the joining party's routing view contains the other party at the time of the message read;
   whether the message collection's id is derived differently (so the two collections address
   different parts of the key space, and only one lands on a peer that is actually present); whether
   a relayed peer is excluded from a responsible set that a directly-dialled peer would join; and
   whether the writer's own node is in the cohort for what it wrote.

# Boundaries

- **A finding is a finding.** If the behaviour turns out to be correct given the deployment's shape —
  for example if a two-party strand genuinely cannot satisfy the message collection's durability
  requirement — then say so plainly, record the arithmetic, and hand back a documentation ticket plus
  whatever the application should do instead. Do not weaken a rule to make the scenario pass.
- **Do not fix this by making reads serve stale local data.** That is the design question owned by
  the backlog ticket above, and it has a security dimension recorded there (an unreplicated
  revocation reading as "not revoked").
- **The evidence is downstream and second-hand.** The stack above is from a device log in another
  repository. Treat it as a lead, not as a specification, and correct this ticket if a local
  reproduction shows something different.
- **One failure mode can masquerade as this one in older device logs.** `RepoClient`'s remote block
  RPC calls `AbortSignal.any` (`repo/client.ts:91`), which Hermes does not provide, so on any RN
  build without the host app's polyfill a read carrying a caller signal fails *before* cohort
  resolution is attempted — see `implement/2-a-library-call-that-does-not-exist-on-phones`. That is a
  different defect with a different signature (`TypeError: AbortSignal.any is not a function`, not
  `cohort-unreachable`). Check which one a given trace actually shows before attributing it here. The
  report this ticket is built on shows `cohort-unreachable`, so it is not that — but an older log
  might be.
- **Two machines is the node count here**, which is the count the maintainer cares most about and
  also the one with an open design question next door (`backlog/more-design/6.5-partition-healing`,
  where the CRDT sync layer is recorded as the intended fix for the lone-survivor asymmetry). This
  ticket is not that question: both parties were present.

# TODO

- Reproduce the asymmetry (one collection readable, one not) between two relayed parties.
- Log and compare `findCluster` for both collections on both parties; report the comparison.
- Diagnose from that, and either fix it or file the implement ticket the diagnosis implies.
- Report to the sereus session whichever way it lands, since their ticket is waiting on this answer.
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/db-p2p test`.

# Sequencing note (garden tender, 2026-09-16 17:4x): run this BEFORE the cohort-assembly chain

`plan/self-in-cohort-only-when-nearest` has just become three implement tickets
(`1-cohort-assembly-self-only-when-nearest`, `2-writer-and-harness-route-to-the-cohort`,
`3-coordinator-refuses-blocks-it-is-not-responsible-for`) that change exactly the thing this ticket
suspects: how `findCluster` / `findCoordinator` decide who is in a block's cohort, whether self is
included, and whether the harness ranks the way production does.

That makes ordering matter. The device report is against the **current** cohort rule. If the chain
lands first and this no longer reproduces, nobody can tell whether the chain fixed it or merely changed
its shape. So this ticket runs first, and its diagnosis should say explicitly whether the asymmetry
comes from cohort assembly (in which case name which of the three tickets addresses it, or add an arm to
one) or from somewhere else.

A note on the earlier deferral: this was held for a quiet machine because a real-relay reproduction's
*timing* is untrustworthy under load. But the ticket's first diagnostic step — comparing `findCluster`
for the two collections on both parties — is a membership question, not a timing one, and is
deterministic. Do that step first; treat any timing-dependent observation from the relay run as
provisional if other runners were active, and say so.
