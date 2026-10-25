description: A machine reading several blocks from another machine used to get them all back in one message, and the whole read failed when they added up to more than the 8 MiB message limit even though each block fit on its own. The answer now carries what fits and the reader asks again for the rest.
prereq: a-log-block-rolls-over-by-size
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-p2p/src/repo/get-reply.ts (new: packing, reading and narrowing), packages/db-p2p/src/repo/service.ts (`RepoService.answerGet`), packages/db-p2p/src/repo/client.ts (`RepoClient.get`), packages/db-p2p/src/protocol-limits.ts (`GET_REPLY_CONTENT_BUDGET_BYTES`), packages/db-p2p/test/repo-get-reply-fits-one-frame.spec.ts (new), docs/internals.md (§A transaction's size limit)
----
# A remote read reply fits one message — review handoff

## What was built

The seam the ticket recommended, entirely inside db-p2p; db-core is untouched and never sees the new entry.

- **Server packs** (`RepoService.answerGet` → `fitGetReply` in `packages/db-p2p/src/repo/get-reply.ts`). Entries in request order (then any unasked ids the repo answered); the first is always whole; each further entry is whole while the running total of `jsonEncodedBytes([blockId, entry])` stays within `GET_REPLY_CONTENT_BUDGET_BYTES`; every other entry becomes `{ leftOut: 'size' }`, whose own size also counts toward the total. A one-entry reply is returned without measuring, so the common one-block read (`TransactorSource.tryGet`) pays nothing.
- **Budget** (`GET_REPLY_CONTENT_BUDGET_BYTES` in `protocol-limits.ts`) = frame − envelope reserve = 7.5 MiB = `MAX_BLOCK_BYTES`. Reasoning in its doc: a one-block reply of the largest allowed block fits inside the same reserve, so packing up to the same total leaves the reserve for markers and JSON punctuation. Not half the frame like the consult budget, because a left-out entry carries no claim or proof.
- **Client loops** (`RepoClient.get`). Asks with `acceptsLeftOut: true`, splits the reply (`readGetReply`), merges answered entries, and re-asks the same peer for left-out ids with `narrowBlockGets` (same context and `lineageOf`; `floors` and `askerHolds` cut to those ids, omitted when empty). Terminates because every round must shrink the left-out set; a round that leaves out every asked id throws instead of looping (protects against a buggy or hostile server).
- **Opt-in by request flag.** Only a get carrying `acceptsLeftOut: true` (`RepoBlockGets`) is packed. This is beyond the ticket's text and deliberate: a reader on an older build would read `{ leftOut }` (no `block`) as an authoritative "never created", which can make `createOrOpen`-style paths invent things. Without the flag the reply is whole, exactly as before, and a too-large reply fails for that reader as it always did. The flag is stripped before `repo.get`, so `CoordinatorRepo` never sees it.

## Test added

- `packages/db-p2p/test/repo-get-reply-fits-one-frame.spec.ts` — the ticket's regression: a real `RepoService` over a real `StorageRepo` holding two 5 MiB blocks, reached by a real `RepoClient` over linked-duplex pairs. Asserts both blocks arrive whole, no `leftOut` reaches the caller, and exactly two connects happened (one round per block). Verified it fails without the flag (`InvalidDataLengthError: Message length too long`, from the server's 8 MiB encoder) and passes with it.

No other tests: the packing order, the narrowing and the no-progress guard are small branches the regression already crosses, or guards against a misbehaving peer.

## Validation run

- `yarn build`, `yarn typecheck` (covers `test/`), eslint on changed files — clean.
- `yarn test` (db-p2p) — 3528 passing, 0 failing, 74 pending.
- `yarn test:integration` (db-p2p) — 51 passing, 2 pending (real TCP meshes, redirects, relay phones all go through `RepoClient.get`/`RepoService`).
- `yarn lint:docs` — all resolve.
- Not run: the root `yarn test` across other packages (db-core is unchanged; quereus plugin uses db-p2p's rebuilt `dist`).

## Things the reviewer should look at

- **Follow-ups after a redirect.** A later round goes to the client's original peer, so a redirected first round makes every later round redirect again (one extra hop each). Parked as a `NOTE:` on `RepoClient.get`; restructuring `processRepoMessage` to continue on the redirect target seemed too much for a rare case.
- **Many left-out ids.** Markers past the budget are not bounded except by the 512 KiB reserve (~several thousand ids). A read naming that many blocks on one coordinator, none fitting, would still overflow. Parked as a `NOTE:` on `fitGetReply`.
- **Double encode.** Multi-block replies are JSON-encoded once to measure and again to send (same accepted cost as `fitConsultContent`; `NOTE:` there).
- **Non-object reply.** `RepoClient.get` now returns `{}` for a null/non-object reply where it used to return the value verbatim. `NetworkTransactor.get` treats both as not answered (retry, then "Some peers did not complete"), so behaviour should be the same; check if any other direct caller of `RepoClient.get` cared.
- **Snapshot claim.** The comment on `RepoClient.get` (and docs) says blocks answered in different rounds may come from different moments and that this is no weaker than before because each block is judged on its own. Worth a second look against `Collection.readLogEnds` (header + tail in one request): a split there would put header and tail in different rounds, and `headerCurrentThroughTail` already guards the header/tail-at-different-moments case, so I believe it holds.
- **Mixed versions.** New client → old server: the old server ignores the flag and answers whole; too-large reads still fail as before. Old client → new server: no flag, answered whole. Nothing silently wrong in either direction.
