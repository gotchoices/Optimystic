description: When a machine saves data without also stating what that data should look like, it keeps no proof the save really happened, and other machines then refuse to accept a copy of it — so the data quietly stops spreading. One of our own integration tests is in exactly that state and currently fails.
files: packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, docs/correctness.md
difficulty: medium
----

# A commit that declares no content digest for a block yields a block no peer will accept by push

Root cause site: **which blocks get a declared content digest, and what happens to the ones that
don't.** Three arms, all resolving there. Arm A is the release blocker; B and C are the contract
work that stops it recurring.

## Confirmed state of the tree

`yarn check` is red at HEAD. `yarn check` = `lint && build && typecheck && test && test:integration`,
and the failure is in the integration tier:

```
cd packages/db-p2p
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --colors --reporter spec
```

Full db-p2p integration tier at HEAD: **29 passing, 2 pending, 1 failing.** The single failure,
deterministic across three runs (twice in isolation with `--grep "churn re-replication"`):

```
1) Real libp2p integration
     churn re-replication: a middle peer re-pushes an owned block to an expansion peer that then serves it:
   Error: waitFor timed out after 15000ms: an expansion-cohort peer durably holds the re-pushed block
    at Context.<anonymous> (test\real-libp2p.integration.spec.ts:669:3)
```

## The chain

Under `DEBUG='optimystic:db-p2p:*'`, in order:

1. `StorageRepo.persistProofIfContentMatches` (`storage-repo.ts:1156`) asks
   `proofDeclaredDigest(proof, {blockId, rev, actionId})` what digest the commit declared for this
   block. A commit carrying no `blockDigests` declares none, so **no proof is stored**, logged as
   `commit:proof-undeclared`. This is the documented retention rule, not a bug in itself.
2. `sourceBlockCertification` (`block-transfer-service.ts:125`) finds no local proof and pushes
   meta-only, logging `cert:no-local-proof`.
3. `handlePush` (`block-transfer-service.ts:432`) under the default `requirePushCertificate: true`
   rejects it: `push:reject-uncertified ... reason=no-proof`.
4. The spread's confirm arm reports `confirm:unmet block=... holders=0/2` and gives up.

## Corrections to the fix ticket's framing — read these before starting

Three things the upstream ticket got slightly wrong. They change what you should do.

**1. The `as any` is not what caused the drift.** Measured: strip the `as any` from all seven
`repo.commit({...} as any)` / `client.get({...} as any)` sites in `real-libp2p.integration.spec.ts`
(lines 59, 224, 290, 321, 407, 529, 651) and `npx tsc --noEmit` in `packages/db-p2p` reports **0
errors**. The casts are vestigial noise that hid nothing. What let the test drift out of production
shape is that `blockDigests` is *optional*, so an omitted declaration is a legal request either way.
Remove the casts anyway (they are dead weight), but do not describe them as the cause.

**2. "Can never replicate" means "never by push."** `handlePull` is not gated by
`requirePushCertificate` — it serves this node's own storage unconditionally. So an undeclared block
stays readable, still repairs by corroboration while two or more holders remain, and is still
obtainable by pull. What is lost is the ability to **gain new holders**: the spread-on-churn path
(`cluster/spread-on-churn.ts`) and cohort-growth healing both push, and both are refused. The real
user-visible effect is that replication factor decays as membership changes, silently, with the only
signal at debug level. That is a genuine availability defect, just a slower one than "the block
vanishes."

**3. There is a production path that produces undeclared blocks — and it is not the one the upstream
ticket named.** `computeBlockContentDigests` (`db-core/src/transform/digest.ts:21`) omits any block
id whose base is not already resident in the read cache, rather than fetching it. The existing
`NOTE:` at `digest.ts:15-20` records that as an accepted tradeoff, justified as *"omission degrades
to corroboration rather than failing, so this is safe."* **That justification predates the
`requirePushCertificate: true` default and is now out of date**: omission today additionally means
the block cannot gain holders by push. The NOTE's own revisit condition ("if commits routinely touch
more blocks than the cache holds") has effectively tripped early — the consequence got worse, not
just more frequent. This arm is `repro: static` — read from the code, not observed; arm C says how to
confirm it.

## Arm A — put the integration test in production shape (the release blocker)

**Verified fix.** With this change the test passes in **4.4s** (vs. the 15s timeout at HEAD):

```ts
import { canonicalBlockHash } from '@optimystic/db-core';
// ...
const commit = await ownerRepo.commit({
  actionId: 'spread-churn-a1',
  tailId: blockId as BlockId,
  rev: 1,
  blockIds: [blockId as BlockId],
  blockDigests: { [blockId]: { digest: await canonicalBlockHash(makeBlock(blockId)) } },
});
```

`makeBlock(blockId)` is exactly what `makeTransforms(blockId)` inserts, so its canonical hash is what
`StorageRepo` materializes at the committing revision. Inserts are base-independent, so no `baseRev`
rides along — matching what `computeBlockContentDigests` produces for an inserted block.

Do **not** make it pass by setting `requirePushCertificate: false`. Two unit specs
(`block-transfer-roundtrip.spec.ts`, `block-transfer-push-persist.spec.ts`) already run the migration
posture; a third would leave the production default essentially unexercised end to end. This test, in
production shape, *is* the end-to-end certified-push coverage the `require-proof-on-block-push`
handoff flagged as its largest gap.

Apply the same treatment to the other hand-built commits in the file — the `pendCommitGet` helper
(~line 54) and the direct commits at lines 407 and 529. They all insert via `makeTransforms`, so the
same one-entry digest map applies. They pass today only because nothing pushes their blocks; leaving
them undeclared preserves the drift that produced this ticket.

**Warning before you do that:** declaring a digest has consequences. Cohort members run
`ClusterMember.validateCommitOperations` (`cluster-repo.ts:1262`) on the promise round and vote
**reject** with `content-digest-mismatch` if a declaration disagrees with what they materialize. An
undeclared commit is voted on blind; a declared one is checked. So a wrong digest turns a passing
test into a failing commit, not a silently weaker one. Run the whole integration tier after the
change, not just the churn test.

## Arm B — decide the contract, and record the decision at the sites

**Decision: `blockDigests` stays optional. Do not make it required.** Reasons, in order of weight:

- **It would not make the bad state unrepresentable.** The strongest available typed form is a
  required-but-nullable key (`blockDigests: BlockContentDigests | undefined`), which forces every
  caller to *mention* the field but still lets them write `undefined`. It converts a silent omission
  into a typed-out-loud omission — real but small value.
- **Measured migration cost.** Making the key required-but-nullable on both `RepoCommitRequest`
  (`i-repo.ts:48`) and `CommitRequest` (`struct.ts:126`), then running `npx tsc --noEmit` per
  package: **39 errors across 9 files in db-core** (3 src — `coordinator.ts`,
  `network-transactor.ts`, `transactor-source.ts`, all via `blockDigestsField`'s optional-spread
  return type — plus 6 test files) and **155 errors across 30 files in db-p2p** (2 src —
  `testing/raw-storage-conformance.ts`, `testing/reactivity-mesh-harness.ts` — plus 28 test files).
  ≥194 errors across ≥39 files, with `quereus-plugin-optimystic` unmeasured on top. Nearly every fix
  is literally writing `undefined`.
- **Some commits legitimately declare nothing.** Delete-only / tombstone commits materialize no
  content to digest (and have nothing to push either). `computeBlockContentDigests` returns a partial
  map by design. A member on a lagging base abstains rather than declaring.
- **`blockDigestsField` omits the empty map deliberately** so an undeclared commit's canonical-JSON
  preimage stays byte-identical to pre-feature — the request is hashed verbatim into every cohort
  signature. Forcing `blockDigests: {}` would change that preimage. (An explicit
  `blockDigests: undefined` would *not*: `canonicalJson` is `JSON.stringify` with a key-sorting
  replacer, and `JSON.stringify` drops `undefined`-valued object properties. Worth confirming against
  the message-hash specs if anyone revisits this.)

What to write instead — accepted-tradeoff `NOTE:`s, in the *code*, where the next reviewer meets
them:

- At `RepoCommitRequest.blockDigests` (`i-repo.ts:41-48`) and/or `CommitRequest.blockDigests`
  (`struct.ts:126`): the field is optional by necessity; a block committed with no declaration
  retains no `BlockCommitProof` and is refused by any receiver running the default
  `requirePushCertificate: true`, so it stops gaining holders by push while staying readable and
  pullable. State the measured migration cost above so nobody re-derives it. Revisit condition: if
  undeclared commits ever become common enough to show up as replication-factor decay.
- At `digest.ts:15-20`: **update the existing NOTE.** Its current claim that omission "degrades to
  corroboration rather than failing, so this is safe" is no longer the whole consequence. Add that
  omission now also means the block cannot be push-replicated under the default push-certificate
  policy.
- `docs/correctness.md` — one sentence. The "Content digest declaration" paragraph (line 58)
  describes what a declaration buys at vote time but not what *absence* costs at replication time;
  the durable-proof discussion (line 397) is the natural place to say that a revision committed
  without a declaration retains no proof and is therefore push-refused.

Do **not** promote `commit:proof-undeclared` or `push:reject-uncertified` onto the libp2p component
logger. `BlockTransferService` does have one (`components.logger?.forComponent('db-p2p:block-transfer')`,
line 250), but `backlog/debt-service-logs-split-across-two-logger-factories` documents that this
factory produces namespaces *outside* `optimystic:db-p2p:*` — the filter `docs/debugging.md` tells
operators to set. Routing a new line there would add a seventh instance of that known trap. Keep
these lines on `createLogger`.

## Arm C — measure the read-cache declaration gap, then decide

Confirm or refute correction #3 above with a cheap unit-tier test in db-core: drive a commit through
the production path (`Collection` / `coordinator`, which call `computeBlockContentDigests`) touching
more update-carrying blocks than the `CacheSource` capacity (default 128), and assert what fraction
of `blockIds` end up declared.

- If coverage turns out complete, the concern is refuted — say so, and tighten the `digest.ts` NOTE
  rather than widening it.
- If blocks come back undeclared, keep the test as the standing guard (this is the generalized-test
  rung: it catches the whole class, now and after future edits) and **file a `debt-` backlog ticket**
  for the remediation. Do not attempt the remediation here — `digest.ts`'s NOTE already sketches the
  two candidates (size the cache to the transaction, or carry the base revision alongside the staged
  updates), and both are larger than this ticket.

## Edge cases that must survive whatever lands

- **Tombstones** (a commit with no `block`) legitimately declare no digest and must keep committing.
- **A diverged member** stores no proof by design (`commit:proof-digest-mismatch`) and falls back to
  corroboration. That must stay distinguishable from "declared nothing" — same absent proof, very
  different meaning, and those two log lines are the only way to tell them apart.
- **`backFillProof`** shares `persistProofIfContentMatches`, so a change to the declaration rule hits
  both the fresh-commit and the back-fill site.
- **Multi-block commits** narrow the action-wide digest map per request (`network-transactor.ts:915`,
  `digestsFor`); anything that changes the field's shape must survive that narrowing.
- **`push:reject-uncertified` must keep firing for genuinely unproven content.** That rejection is
  the fix for the measured forgery path; nothing here may weaken it.

## Noticed, out of scope — for the reviewer to index, not to fix here

`yarn typecheck` at the repo root is close to a no-op: only `packages/quereus-plugin-optimystic`
defines a `typecheck` script (`tsc --noEmit`); `db-core` and `db-p2p` do not, so
`yarn workspaces foreach ... run typecheck` skips them and exits 0 in ~18s. Type errors in those two
packages are still caught, because `yarn check` runs `yarn build` (a real `tsc`) first — so
`yarn check` itself is sound. But `yarn typecheck` alone is misleading to anyone using it as a fast
pre-flight. Not filed; mentioned so the review stage can decide whether adding
`"typecheck": "tsc --noEmit"` to those two packages is worth a one-line change.

## Validation

- `cd packages/db-p2p && OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.integration.spec.ts" --colors --reporter spec`
  — expect 30 passing, 2 pending, 0 failing.
- `yarn test` (unit tier, all workspaces) — must stay green; arm C adds a db-core spec.
- `yarn build` — the real typechecker for db-core and db-p2p.

## TODO

Phase 1 — arm A (unblocks `yarn check`)

- Add the `blockDigests` declaration to the churn commit at `real-libp2p.integration.spec.ts:651`,
  importing `canonicalBlockHash` from `@optimystic/db-core`.
- Give `pendCommitGet` (~line 54) and the direct commits at lines 407 and 529 the same declaration.
- Remove the seven vestigial `as any` casts (lines 59, 224, 290, 321, 407, 529, 651); confirm with
  `npx tsc --noEmit` in `packages/db-p2p`.
- Run the full db-p2p integration tier and confirm zero failures — a wrong digest now causes a
  promise-round reject, so a partial pass is not good enough.

Phase 2 — arm B (contract; documentation only)

- Add the accepted-tradeoff `NOTE:` at `RepoCommitRequest.blockDigests` / `CommitRequest.blockDigests`,
  carrying the measured migration cost and the revisit condition.
- Update the existing `NOTE:` at `digest.ts:15-20` so its stated consequence includes push refusal.
- Add the one sentence to `docs/correctness.md` about what absence of a declaration costs at
  replication time.

Phase 3 — arm C (measure, then decide)

- Add the db-core spec that measures declaration coverage for a commit touching more update-carrying
  blocks than the read-cache capacity.
- If a gap is confirmed: keep the spec as the guard and file a `debt-` backlog ticket for the
  remediation. If refuted: tighten the `digest.ts` NOTE and say so in the handoff.

Handoff

- Be explicit about which arms landed and which did not, and state arm C's measured result either
  way — that number is the whole point of the arm.
