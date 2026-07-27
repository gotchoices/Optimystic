---
description: Nodes built before the recent peer-metadata fix and nodes built after it can no longer introduce themselves to each other, so during a staged upgrade the two halves of a network quietly stop picking each other for any work. Decide whether that needs a coordinated all-at-once upgrade, a release note, or a temporary bridge.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/docs/cluster.md, docs/releasing.md
difficulty: medium
---

## What happens

libp2p peers introduce themselves over a small handshake protocol called `identify`. Which
handshake a node speaks is decided by an exact string. Optimystic's string was malformed for
several releases — it had a doubled slash near the front — and that was corrected in commit
`849fd94`.

Correcting it changed the string. Two nodes only complete the handshake if their strings match
exactly, so:

- an **old** node (built before `849fd94`) and a **new** node (built after) can still open a
  network connection to each other, but the handshake never completes,
- so neither one ever learns which services the other offers,
- and Optimystic's peer-selection logic decides *which peers are eligible to do work* purely from
  that service list. A peer whose list is empty is treated as "not confirmed to serve this network"
  and is skipped — for choosing a write coordinator and for assembling the group of peers that
  stores a block.

Net effect: during a staged rollout, old nodes and new nodes see each other as connected but
unusable. Each half tries to operate on its own. Nothing logs an error that names the cause — the
symptom is peers being silently passed over, or a node falling back to coordinating writes by
itself.

The exact strings, for reference:

| | handshake protocol string |
| --- | --- |
| before `849fd94` | `//optimystic/<network>/id/1.0.0` (note the doubled slash) |
| after `849fd94` | `/optimystic/<network>/id/1.0.0` |

Everything else on the wire is unchanged — the strings for the cluster, repo, sync and
block-transfer protocols were correct all along and were deliberately left alone.

## Why this is filed rather than fixed

Fixing the malformed string was clearly right; the string had to change. What is missing is a
decision about the consequence, and that is a human call, not a code change someone should just
make. The plausible answers are quite different from each other:

- **Do nothing but write it down.** If no long-lived multi-node deployment exists yet (the project
  is at `v0.16.2`), the answer may simply be "upgrade everything at once", recorded somewhere an
  operator will see it. There is currently no changelog file in the repository at all, so there is
  no obvious place for that note — `docs/releasing.md` may be it.
- **Ship a transition release** that speaks *both* handshake strings for one version, so a mixed
  network keeps working while the rollout proceeds, then drop the old one. This is a real code
  change and carries its own cost — it means deliberately re-registering a string that was just
  declared malformed.
- **Make the failure legible instead of silent.** Independently of the above: when a connected peer
  is skipped because its service list is empty, nothing distinguishes "we haven't finished the
  handshake yet" from "this peer will never complete the handshake with us". A log line or a metric
  that names the second case would turn a mystifying outage into an obvious one, and would help with
  any future protocol-string change too.

## Where to look

- `packages/db-p2p/src/libp2p-node-base.ts` — the `identify` / `identifyPush` registrations, with a
  comment explaining why their prefix is spelled differently from every other service's.
- `packages/db-p2p/src/libp2p-key-network.ts` — `membershipOf` and `filterByMembership`, the logic
  that drops peers whose service list is empty.
- `packages/db-p2p/docs/cluster.md`, section "Network-Membership Scoping" — describes that
  behaviour, framed around a *different* cause (peers belonging to a genuinely different network).
  It does not mention that a version mismatch produces the same symptom; whichever option is chosen,
  this paragraph should probably say so.
