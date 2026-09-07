----
description: A group of machines sharing data can legitimately be just one machine, or two, and growing from one to two is the ordinary thing a user does — not an exotic setup. Several safety rules were written assuming small groups were only a development convenience, and one of them now needs a different answer.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (the `cluster-fetch:local-current` arm of `fetchBlockFromCluster` — the accepted-tradeoff NOTE whose revisit condition has now tripped)
  - packages/db-p2p/src/cluster/quorum-restore.ts (`corroboratorCapacity`, `CORROBORATION_FLOOR`, `selectQuorumRev`)
  - packages/db-p2p/src/cluster/certified-claims.ts (the verifiable second source of truth that already exists — read this before designing a new one)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`resolveClusterPolicy` — where `assumedClusterSize` is resolved and defaulted)
  - docs/transactions.md, docs/internals.md, docs/architecture.md, docs/optimystic.md, packages/db-p2p/docs/cluster.md (all updated with the decision; the behaviour they describe is unchanged)
difficulty: hard
----

# Small cadres are a supported topology, and the trust rule for a cohort of two needs revisiting

## The decision, made 2026-09-06

`blocked/two-machine-groups-supported-or-not` asked whether a two-machine group is a supported
production topology or a development convenience. **It is supported.** The maintainer's answer, in
substance:

> A cadre can be any size, and cadres join up with other members' cadres, which may also be any
> size. The normal path is that a user starts with **one** machine — often an app on a phone — and
> then wants a second as a *backup*: a pod in the cloud, or a desktop or Linux box in the basement
> for an advanced user. Alternatively the user goes straight from one phone to inviting a partner's
> cadre, which may itself be just another phone (relayed, since two phones cannot dial each other
> directly).

Three things follow that the code did not previously assume:

1. **One and two are ordinary sizes**, not degenerate ones. A cohort of one is where every cadre
   *starts*; a cohort of two is the first thing a careful user does next.
2. **The 1 to 2 transition is a user action, not an operator action.** "Add a backup" is a product
   feature. Nobody adding a phone-plus-cloud-pod backup is going to hand-edit a cluster-size setting.
3. **Small does not mean local or trusted.** The second machine may be a rented pod, or a partner's
   phone reached over a relay. A two-machine cadre spans a real network with real adversaries.

## What this changes

### The accepted tradeoff at `cluster-fetch:local-current` has tripped its own revisit condition

`CoordinatorRepo.fetchBlockFromCluster` carries this NOTE at the arm that accepts "you are already
current" from the cohort:

> in a cohort of two, that sole peer is the only corroborator, so a lying one can park the reader
> here — corroborating the revision it already holds — and re-arm the lazy window on every pass,
> hiding a real divergence. Bounded by `readRepairWindowMs` (10s default) and no worse than the peer
> simply staying silent. **If two-member cohorts become a supported production topology rather than
> a dev convenience, stop re-arming the window on a corroboration that came from a single voter.**

That condition is now met. The NOTE has been updated at the site to say so and to point here; the
behaviour is deliberately unchanged pending this ticket.

### But the naive remedy collides with a second, already-filed defect

`plan/2-bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read` (moved here from `backlog/`
alongside this ticket) is the mirror image: an *undeclared* two-machine cadre can never satisfy its
own corroboration floor, so it consults its partner on **every read, forever**, and its fix is to
arm the window when the failure is provably permanent.

Take both remedies naively and a two-machine cadre gets a network round trip on every single read
whatever it does:

| two-machine cadre | corroboration outcome | naive rule | result |
| --- | --- | --- | --- |
| `assumedClusterSize: 2` declared | floor relaxes to 1, the partner's answer corroborates | "do not arm on a single voter" | re-consults every read |
| undeclared (the default) | floor stays 2, can never be met | "arm when provably permanent" | armed — but only because the check is hopeless |

So the declared, *correctly configured* cadre ends up worse off than the misconfigured one. **These
two tickets must be designed together**, which is why the second now sits behind this one rather
than in the backlog.

## The option that is mostly already built, and should be costed first

The blocked ticket listed three candidate second sources of truth: a signed commit receipt the
reader can verify on its own, a third witness that stores nothing, or an operator-accepted "trust my
partner" switch. **The first of those largely exists.** Certified claims shipped
(`4-certified-claim-selection`, `4.1`, `4.2`, `2-single-signer-proof-outweighs-corroboration`): a
claim carrying a `BlockCommitProof` the reader verifies itself needs no second peer at any cohort
size where nothing multi-peer contests it, and `docs/transactions.md` documents the weighting in
full.

That is exactly the property a cohort of two needs — corroboration that does not require trusting
the only other machine, because the reader checks the signatures. So the real question is narrower
than the blocked ticket framed it:

- **For certified claims, is a cohort of two already safe?** If the partner's answer carries a proof
  the reader verified, "single voter" is not the right description of it — and re-arming the window
  on it may be perfectly sound. Establish this first; it may retire most of the concern.
- **What remains is the uncertified path** — a proof-less or legacy claim from the only other peer.
  That is the case the NOTE describes, and the one that actually needs a rule.
- **And the local-current arm specifically**, which is not a claim adoption at all: the cohort said
  "you are not behind". Decide whether *that* deserves the same treatment, since a lying partner
  saying "you are fine" is the cheapest possible attack and the arm is what makes it stick.

## The configuration problem the decision creates

Today a two-machine cadre must declare `clusterPolicy.assumedClusterSize: 2` (or an honest
`clusterSize: 2`) before its members can repair each other; undeclared, the floor defaults to the
replication factor and repair can never succeed. That was a defensible ask when two machines meant a
developer's laptop pair. It is not defensible when the second machine arrives because a user tapped
"add a backup".

**Why it is declared rather than observed**, and this must not be lost: the observed cohort view
comes from unauthenticated peer routing, so a partition — or an attacker with routing influence —
could shrink what a node sees and thereby *talk the safety floor down*. That is the whole reason
`corroboratorCapacity` takes a declared size.

`backlog/feat-admission-floor-from-observed-cohort-high-water-mark` proposes learning the reference
size from the largest cohort ever observed instead. Its own `tradeoffs:` line says the design is not
settled — nobody has an answer for a deployment that legitimately shrinks and can never meet its own
high-water mark again — and a cadre that *starts at one and grows* is the friendliest possible case
for a high-water mark, while a cadre whose partner is decommissioned is exactly the unfriendly one.
Read that ticket before proposing anything here; do not solve it twice.

## Scope

**In scope:** the trust rule for corroboration and window-arming at cohort sizes 1 and 2, jointly
with the sibling ticket; and a recommendation (not necessarily an implementation) on how a
two-machine cadre should come by its size reference without an operator.

**Out of scope:** changing the replication factor, the admission gate, or anything about cadres
joining other cadres — the joining case produces a *larger* cohort and is already the well-covered
path. Also out of scope: reopening whether the size reference may be taken from the unauthenticated
view. It may not; that is settled and the reason is above.

## Edge cases & interactions

- **Cohort of one.** Already handled and recently fixed (`complete/1-solo-node-read-repair-never-settles`
  arms the window on the solo exit). Whatever rule this ticket produces must not un-fix it: a solo
  cadre must not go back to consulting on every read. Note the asymmetry that fix's own NOTE records
  — a self-only cohort is *also* what `findCluster` returns while genuine peers are still
  mid-identify, so arming there is justified by "re-asking sooner cannot learn anything", not by
  "there are no rivals".
- **Growing 1 to 2 while blocks exist.** Blocks written while alone have one holder. `sole-holder`
  and the cohort-growth push (`replicate-owned-blocks-when-the-cohort-grows`) both bear on this;
  confirm the new rule does not strand founding data differently from today.
- **Shrinking 2 to 1** (partner decommissioned or lost). The high-water-mark question above, and the
  case most likely to produce a permanently unrepairable cadre.
- **Two phones over a relay**, per the decision: both peers dial-only, neither directly reachable,
  every message through a third party that is not a cohort member. Confirm nothing in the new rule
  assumes the partner is reachable on demand.
- **A partner that lies.** The threat the NOTE names. State plainly what the chosen rule does and
  does not protect against at size two, because a user adding a rented cloud pod is trusting an
  operator they have never met.

## TODO

- Establish whether a *certified* claim from the sole partner already satisfies the concern, and say
  so explicitly either way — this may collapse most of the ticket.
- Design the arming rule for cohorts of two jointly with
  `2-bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read`, and check the joint outcome against
  the table above so the declared cadre is not left worse off than the undeclared one.
- Decide the `local-current` arm separately from claim adoption; they are different acts.
- Recommend how a two-machine cadre obtains its size reference without an operator, or state that it
  must remain configured and why — and if the latter, file the product-facing consequence rather
  than leaving it in a doc footnote.
- Emit implement ticket(s) with the adversarial surface above pinned as tests, including the
  relay-only two-phone shape.

## Two downstream reports that bear on this, found 2026-09-06

Neither is an Optimystic defect. Both constrain what "supported" has to mean in practice, and the
first is the product-facing consequence this ticket's TODO asks someone to file — already filed,
downstream, and open since July.

**A consumer cannot currently configure a small cohort at all.**
[gotchoices/sereus#2](https://github.com/gotchoices/sereus/issues/2): `CadreNode` builds its
libp2p options with `clusterSize: 3` as a literal, with no override on `CadreNodeConfig`, and
constructs `clusterPolicy` inline **omitting `allowUnvalidatedSmallCluster`** — so the escape hatch
this library provides for small cohorts cannot be reached through that consumer at all. The
recommendation this ticket produces is inert until that seam exists: telling a two-machine cadre to
declare `assumedClusterSize: 2` is advice its host cannot follow. Worth saying so explicitly in
whatever comes out of here, and worth checking whether any of our own docs now recommend a setting
that our largest consumer cannot pass through.

Note the shape, because it argues for the recommendation being *a default*, not *a setting*: a
hardcoded 3 is what a downstream author writes when the docs imply three is the real minimum. This
ticket's decision says otherwise.

**The relayed two-phone pairing does not currently work on React Native, for an unrelated reason.**
[gotchoices/sereus#11](https://github.com/gotchoices/sereus/issues/11): RN declares
`WebSocket.bufferedAmount` but never assigns it, so `@libp2p/websockets` reads `undefined`,
concludes it can never send more, and waits for a `'drain'` whose own check (`bufferedAmount === 0`)
is equally false forever. Every WebSocket write parks until the socket closes. A phone cannot
listen, so no relay reservation is ever obtained and the node is never dialable.

That is a polyfill gap, not a design problem — it has been added to this repo's own RN checklist
(`packages/db-p2p/readme.md`) since our checklist is canonical for `@optimystic/db-p2p/rn` and did
not carry it. But it means the *two phones over a relay* case in the adversarial surface above
cannot be tested end-to-end on RN today. Design for it; do not expect to validate it there yet.
