description: FileRawStorage (db-p2p-storage-fs) writes pend/action files named `<actionId>.json`, but db-core stamps transaction/action ids as `tx:<hash>` / `stamp:<hash>` (with a colon). On Windows a colon is illegal in a filename, so the consensus commit's pend→actions rename fails with EINVAL — making the coordinator (session/consensus) commit path unusable on Windows over FileRawStorage. POSIX is unaffected (colons are legal there). The legacy `Collection.sync()` path sidesteps this by using colon-free base64url action ids.
files: ../optimystic/packages/db-p2p-storage-fs/src/file-storage.ts, ../optimystic/packages/db-core/src/transaction/transaction.ts
difficulty: easy
----

# FileRawStorage colon-in-actionId breaks consensus commit on Windows

## Symptom

A real-DML session/consensus-mode commit (`TransactionSession.commit` → `TransactionCoordinator.commit` → transactor PEND/COMMIT) over the `local` transactor backed by `FileRawStorage` fails on Windows during COMMIT:

```
EINVAL: invalid argument, rename
  '...\<block>\pend\tx:<hash>.json' -> '...\<block>\actions\tx:<hash>.json'
```

PEND succeeds (the pend file is created — Windows treats `tx:<hash>.json` as the alternate-data-stream `<hash>.json` on file `tx`), but `promotePendingTransaction`'s `fs.rename` then fails because the colon path is not a valid rename target.

## Root cause

- `db-core/src/transaction/transaction.ts`: `createTransactionId` returns `` `tx:${hash}` `` and `createTransactionStamp` returns `` `stamp:${hash}` `` — both contain a colon.
- `db-p2p-storage-fs/src/file-storage.ts`: `getPendingActionPath` / `getActionPath` build `path.join(blockPath, 'pend' | 'actions', `${actionId}.json`)` and `promotePendingTransaction` does `fs.rename(pendingPath, actionPath)`. The colon in `actionId` makes an illegal Windows filename.

Legacy `Collection.sync()` (`syncInternal`) does not hit this because it mints a fresh colon-free base64url `actionId = uint8ArrayToString(randomBytes(16), 'base64url')`. Only the coordinator/consensus path uses the colon-bearing `transaction.id` as the storage action id.

## Why it matters

Surfaced by `quereus-plugin-optimystic/test/session-mode-commit.spec.ts`, which therefore drives consensus over the in-memory `test` transactor (no filesystem) and gates its single on-disk reopen test to POSIX (`process.platform !== 'win32'`). The colon issue blocks the on-disk durability path on Windows dev machines / runners.

## Expected behaviour

The consensus commit path persists correctly through `FileRawStorage` on all platforms (Windows included), so a committed session-mode transaction survives a reopen from disk.

## Possible directions (for the fix/plan stage to weigh)

- Sanitize/encode the colon when an id is used as a filename in `file-storage.ts` (encode on write, decode in `listPendingTransactions` which parses filenames back to ActionIds — keep the round-trip exact). Changes on-disk layout.
- Or change the id scheme so storage-facing ids are filename-safe (drop/replace the `tx:`/`stamp:` colon prefix). Wider blast radius (ids appear in logs, hashes, wire).

Whichever is chosen, add a Windows-exercised regression (or unskip the POSIX-gated reopen test in `session-mode-commit.spec.ts`).
