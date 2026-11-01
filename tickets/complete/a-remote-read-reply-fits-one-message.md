description: A machine reading several blocks from another machine used to get them all back in one message, and the whole read failed when they added up to more than the 8 MiB message limit even though each block fit on its own. The answer now carries what fits and the reader asks again for the rest.
prereq: a-log-block-rolls-over-by-size
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-p2p/src/repo/get-reply.ts (packing, reading and narrowing), packages/db-p2p/src/repo/service.ts (`RepoService.answerGet`), packages/db-p2p/src/repo/client.ts (`RepoClient.get`), packages/db-p2p/src/protocol-limits.ts (`GET_REPLY_CONTENT_BUDGET_BYTES`), packages/db-p2p/test/repo-get-reply-fits-one-frame.spec.ts, docs/internals.md (§A transaction's size limit), packages/db-p2p/docs/repo.md (RepoClient)
----
# A remote read reply fits one message

## What landed

Entirely inside db-p2p (`ticket(implement): a-remote-read-reply-fits-one-message`); db-core is untouched.

- `RepoService.answerGet` packs a multi-block `get` reply with `fitGetReply` (`packages/db-p2p/src/repo/get-reply.ts`): entries in request order, the first always whole, each further one whole while the running JSON size of the entries stays within `GET_REPLY_CONTENT_BUDGET_BYTES` (frame less envelope reserve = `MAX_BLOCK_BYTES`), the rest replaced by `{ leftOut: 'size' }`. A one-entry reply is returned unmeasured.
- `RepoClient.get` sends `acceptsLeftOut: true`, merges answered entries, and re-asks the same peer for the left-out ids with `narrowBlockGets` (same context and `lineageOf`; `floors` and `askerHolds` cut to those ids). A round that leaves out every asked id throws, so a buggy or hostile peer cannot loop it.
- Only a request carrying `acceptsLeftOut` is packed, so a reader on an older build never mistakes a left-out entry for an authoritative absent. The flag is stripped before `CoordinatorRepo.get`.

Regression test: `packages/db-p2p/test/repo-get-reply-fits-one-frame.spec.ts` (two 5 MiB blocks through a real `RepoService`/`RepoClient` over linked duplex pairs; both arrive whole in two rounds).

## Review findings

Read the implement diff first, then the handoff.

- **Correctness of packing (`fitGetReply`).** Checked: the first entry is always whole, so every reply answers at least one block; greedy continues past a miss, so small later entries still fit; requested ids precede unasked ones, so a requested id is only left out when some requested id was answered; the measured `[blockId, entry]` size matches the object-member size within a couple of bytes. A single entry can be at most a block of `MAX_BLOCK_BYTES` plus its small state, inside the 512 KiB reserve. No defect.
- **Termination and the no-progress guard (`RepoClient.get`).** Checked the shapes a peer can return: a left-out entry for an unasked id is dropped; a requested id the reply omits entirely shrinks the next round like any other progress (it is reported missing, as before); a reply leaving out every asked id throws, which `NetworkTransactor.get` treats as a failed batch and retries elsewhere. Every round strictly shrinks the asked set, so it ends in at most N rounds. No defect.
- **Narrowing.** `BlockGets` has exactly two per-block fields (`floors`, `askerHolds`); both are narrowed and omitted when empty. `context` and `lineageOf` are request-wide and carried unchanged. Deadline: every round shares `options.expiration`, each arming its own timer for what remains. No defect.
- **Redirects.** A redirected first round re-sends the same operations (flag included) to the target; later rounds go back to the original peer and may redirect again. The handoff's `NOTE:` on `RepoClient.get` is accurate; left as a tripwire.
- **Mixed versions.** New client → old server: flag ignored, whole reply, as before. Old client → new server: no flag, whole reply. The one other `{ get }` sender (`reactivity-mesh-harness.ts`, empty `blockIds`) sends no flag and is unaffected.
- **Non-object reply now returns `{}`** rather than the raw value. All callers of `RepoClient.get` go through `NetworkTransactor.get` or `stateHoldingsOnReads` (quereus collection-factory, reference-peer CLI), which index the result per block; `{}` and `null` both read as "not answered". No behaviour change.
- **Snapshot claim across rounds.** Blocks of one read can be answered at different moments. `Collection.readLogEnds` (header + tail in one request) is the one batched read that cares, and `Collection.headerCurrentThroughTail` already guards the header-older-than-tail case; a split there also needs the two blocks to exceed 7.5 MiB together. Claim holds.
- **Resource use / performance.** Multi-block replies are encoded once to measure and once to send — accepted, `NOTE:` on `fitGetReply`. Many left-out ids overflowing the reserve — conditional, `NOTE:` on `fitGetReply`. Both are tripwires, not tickets.
- **Type safety / hygiene.** `RepoBlockGets` and `RepoGetReply` type the wire shape; `readGetReply` takes `unknown` and guards it. `get-reply.ts` is 122 lines, comments state constraints rather than narrate. Moving the long `skipClusterFetch` comment into `answerGet` kept it at its site. Nothing to change.
- **Tests.** The one new spec is the ticket's regression, at the lowest layer that reproduces it (real encode/decode on both ends); kept. No test added for the no-progress guard or narrowing — small branches guarding against a misbehaving peer, per the test bar.
- **Docs.** `docs/internals.md` §A transaction's size limit was updated by the implementer and is accurate. `packages/db-p2p/docs/repo.md`'s RepoClient section did not mention the multi-round read; added one bullet linking to internals. `yarn lint:docs` resolves.
- **Validation.** eslint on changed files clean; `yarn lint:docs` clean; `yarn test` (db-p2p) 3528 passing, 74 pending, 0 failing. Integration suite not re-run (no code changed in review; the implementer ran it: 51 passing).

Major findings: none. No tickets filed.
