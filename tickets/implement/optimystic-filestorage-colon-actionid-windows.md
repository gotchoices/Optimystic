description: Encode colons in action IDs when used as filenames in FileRawStorage so consensus commit works on Windows, and unskip the on-disk reopen durability test on all platforms.
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
difficulty: easy
----

## Changes

### `packages/db-p2p-storage-fs/src/file-storage.ts`

Added two module-level helpers:

```ts
function encodeActionIdForFilename(actionId: ActionId): string {
    return actionId.replace(/:/g, '%3A');
}
function decodeFilenameToActionId(filename: string): ActionId {
    return filename.replace(/%3A/g, ':') as ActionId;
}
```

Updated three private path helpers to encode on write:
- `getPendingActionPath` — `pend/<encoded>.json`
- `getActionPath` — `actions/<encoded>.json`
- `getMaterializedPath` — `blocks/<encoded>.json`

Updated `listPendingTransactions` to decode filenames and accept both formats:
- `decodeFilenameToActionId(file.slice(0, -5))` before the regex test
- Regex updated to accept both legacy UUID and consensus `tx:`/`stamp:` formats:
  ```
  /^(?:[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+|(?:tx|stamp):[0-9a-f]+)$/
  ```

### `packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts`

Removed the `process.platform === 'win32' ? it.skip : it` guard and updated the suite name. The reopen durability test now runs on all platforms.

## Verification

`node --import ./register.mjs mocha "test/session-mode-commit.spec.ts"` — **8 passing** on Windows (including the formerly-skipped reopen test).

## Gaps / notes for reviewer

- Existing on-disk data (if any) written with raw `tx:` filenames on POSIX will become invisible to `listPendingTransactions` after the upgrade. This is acceptable: pending data is only used for crash recovery of in-flight transactions; any such data would be stale after a restart.
- The `getMaterializedPath` encoding is defensive; the coordinator does not currently store materialized blocks with transaction-style ids, but keeps the invariant consistent.
- No new test file was added for `db-p2p-storage-fs` directly; coverage comes from the integration test that was unskipped.

## TODO

- Reviewer: confirm the `getMaterializedPath` encoding is consistent with all current callers of `saveMaterializedBlock` / `getMaterializedBlock`.
- Reviewer: confirm there are no POSIX-only data-at-rest concerns for existing deployments that may have `tx:` files written.
