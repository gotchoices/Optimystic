description: Fixed peer-to-peer write forwarding ("pend") so it routes by a real block id instead of a structural field name, ensuring writes on a large multi-group network reach a group that can actually handle them.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey pend branch + doc comment + runtime import)
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations pend branch — fixed in review)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — the canonical derivation)
  - packages/db-p2p/test/redirect.spec.ts (reworked pend fixtures + large-mesh pend regression)
----

# Complete: `pend` redirect key now derives a block id, not a structural field name

## What shipped

`RepoService.deriveBlockKey` derived the redirect routing key for a `pend` op as
`Object.keys(operation.pend.transforms)[0]`. Since `PendRequest.transforms` is a `Transforms`
(`{ inserts?, updates?, deletes? }`), that first key was a **structural field name**
(`'inserts'`/`'updates'`/`'deletes'`), not a block id — so `checkRedirect` hashed a constant and routed
every pend redirect to a fixed, wrong cluster on a large mesh. (Latent: all prior tests ran in a small
mesh where `checkRedirect` short-circuits to `null`.)

The implement stage replaced the pend branch with the canonical
`blockIdsForTransforms(operation.pend.transforms)[0]` (a runtime value import), updated the doc comment,
reworked the two pend test fixtures to the real `Transforms` shape, and added a large-mesh regression
mirroring the `commit` one.

## Review findings

### What was checked
- **The diff itself** (`service.ts` pend branch, doc comment, import; `redirect.spec.ts` fixtures +
  large-mesh regression) — read with fresh eyes against the real types.
- **Type correctness**: confirmed `PendRequest.transforms: Transforms`
  (`network/struct.ts:11-14,29`), that `blockIdsForTransforms` is exported from `@optimystic/db-core`
  (`db-core/index.ts` → `transform/index.js` → `helpers.js`), and that it is a runtime value (the
  separate non-`type` import is correct).
- **Caller guard**: `service.ts:218` guards `blockKey !== undefined ? checkRedirect(...) : null`, so an
  empty-transforms pend (derives `undefined`) is handled locally with no redirect — correct, not an
  error path.
- **Downstream consistency**: pend coordination derives affected blocks the same way everywhere
  (`cluster-repo.ts` `validatePendOperations:638`, `getAffectedBlockIds:1079`), so anchoring the
  redirect key on `blockIdsForTransforms(...)[0]` matches where the op is actually verified — same
  rationale as the `commit` → `blockIds[0]` fix.
- **Sibling instances of the same root cause**: grepped for `Object.keys(...transforms)[0]` across the
  repo. Found two more — see below.
- **Build + tests**: `db-core` and `db-p2p` build clean; `redirect.spec.ts` 20 passing; full `db-p2p`
  suite **734 passing, 27 pending, 0 failing** (re-run green after the inline fix). The logged
  `cohort-topic cold-start … parent registration … failed` line is expected error-logging inside a
  *passing* anti-DoS coldstart spec. The known-flaky `reactivity / mesh — slow-subscriber isolation`
  test did not fire; no `.pre-existing-error.md` needed.

### Minor — fixed inline this pass
- **`packages/db-p2p/src/repo/client.ts:108` — same bug, live.** `RepoClient.extractKeyFromOperations`
  (called on redirect hops at `client.ts:93` to record a coordinator-affinity hint) derived the pend
  key as `Object.keys(op.pend.transforms)[0]` — the identical structural-field-name mistake, and
  reachable. Fixed to `blockIdsForTransforms(op.pend.transforms)[0]` with a runtime import and a comment
  cross-referencing `RepoService.deriveBlockKey`. Rebuilt + full suite re-run green.
  - *Coverage note:* `extractKeyFromOperations` is private and has no direct unit test (none existed);
    the fix rests on typecheck + full-suite green. A direct test would require exercising the redirect-hop
    path or exposing the method — not added here.

### Major — filed as a new ticket
- **`packages/db-p2p/src/cluster/client.ts:53-66` — `recordCoordinatorForRecordIfSupported` reads the
  wrong message shape.** It inspects `record.message.pend` / `record.message.commit`, but
  `message` is a `RepoMessage` shaped `{ operations: [...] }` — those properties never exist (masked by
  an `any` cast), so the function records nothing and the cluster coordinator-affinity hint is dead
  code. Its pend branch also carries the same `Object.keys(transforms)[0]` bug behind the dead shape.
  This is broader than a one-liner (wrong shape + structural-key fix + an encoding-coherence question
  spanning all op types + missing test coverage), so it is filed as
  `tickets/fix/cluster-client-coordinator-hint-reads-wrong-message-shape.md` rather than patched here.

### Noted, not acted on (out of scope, documented in the new ticket)
- **Key-encoding coherence**: the coordinator-hint writers (`extractKeyFromOperations`,
  `cluster/client.ts`) use raw `utf8(id)`, while `network-transactor.ts` records/looks up coordinators
  via `blockIdToBytes = sha256(utf8(id))`. Whether a hint written under one encoding is ever read under
  the same one is a pre-existing question that affects get/cancel/commit equally and is independent of
  this ticket's block-id-vs-structural-field fix. Captured as the open question in the new fix ticket.

### Empty / not-applicable categories
- **No `.pre-existing-error.md` written** — no unrelated failures surfaced; the suite is fully green.
- **No multi-block-pend correctness concern**: `[0]` anchors on one touched block, which is intentional
  and consistent with how `commit` anchors on `blockIds[0]` and how `cluster-repo` coordinates — not a
  defect.
- **Docs**: the only prose touching this behavior is the `deriveBlockKey` doc comment, which the
  implement stage updated correctly (`pend → blockIdsForTransforms(transforms)[0]`). No other doc
  references the pend redirect key. Verified, nothing stale.
