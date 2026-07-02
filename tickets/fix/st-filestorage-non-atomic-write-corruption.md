description: The on-disk storage backend overwrites files in place with no crash safety, so a single crash or power loss part-way through a write can leave a file half-written, after which that block becomes permanently unreadable — even by the recovery path.
prereq:
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts
difficulty: medium
----

# Filesystem adapter writes are non-atomic — one crash permanently corrupts a block

`ensureAndWriteFile` in the filesystem raw-storage adapter is truncate-then-write with no
temp-file+rename and no fsync (`file-storage.ts:251-254`, `file-kv-store.ts:18-22`).
`meta.json` is rewritten on every commit. If the process crashes or the machine loses power
mid-write, the file is left truncated / half-written.

The corruption is then permanent, not transient: `readIfExists` only maps `ENOENT` to
`undefined` and **rethrows** any JSON parse error. So `getMetadata` on the truncated
`meta.json` throws on every subsequent read, forever. Critically, `recover()` reads metadata
*first*, so the block cannot even be recovered — a single ill-timed crash destroys committed
data rather than merely delaying it.

Expected behavior:

- Writes are atomic: write to `<path>.tmp` then `fs.rename` into place (atomic on POSIX and on
  NTFS), so a reader ever only sees a complete old or complete new file. fsync the metadata
  write (and the containing directory where the platform requires it) so a rename survives
  power loss.
- A JSON parse failure on read is treated as corrupt-but-recoverable, not an indefinite
  throw — so `recover()` and normal reads can make progress against a damaged file rather than
  wedging on it.

After the fix, injecting a crash at any point during a `meta.json` (or block/transform) write
leaves the block readable and recoverable — either the prior committed state or the new one,
never a permanently-throwing truncated file.

## Reproduction notes

- Simulate a partial write (write a truncated / invalid-JSON `meta.json`) and assert
  `getMetadata` / `recover()` do not throw indefinitely.
- Assert that a completed write is never observable in a torn state (temp-then-rename), e.g. by
  asserting the target path only ever contains parseable JSON.

Relationship (do not duplicate): this concerns write **atomicity/durability** of the fs
adapter and is distinct from `eh-7` (fs adapter untested / no README / out-of-CI), which is
owned by the Engineering-health agent. Prior fs-adapter tickets
`optimystic-filestorage-colon-actionid-windows`, `1-filestorage-posix-colon-actionid-migration`,
and `filestorage-legacy-rawcolon-delete-resurrection` (all complete) touched the same file but
addressed filename encoding, not write atomicity.

Suggested-fix hint: temp-file + `fs.rename`, fsync metadata; in `readIfExists`, distinguish
parse-failure (corrupt-recoverable) from a real read.
