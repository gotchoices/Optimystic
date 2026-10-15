description: `db-p2p-storage-ns` requires `@nativescript-community/sqlite` `^3.5.0`, whose 3.x copies blobs byte by byte across the JS-Java boundary in both directions (109-170 ms for a 16 KB blob on a Galaxy S7). 4.x moves the copy into native code. Admit 4.x once it is verified. Reported from Sereus (gotchoices/sereus#45, point 3).
files: packages/db-p2p-storage-ns/package.json (peer range), packages/db-p2p-storage-ns/src/ns-opener.ts
----

# db-p2p-storage-ns admits sqlite 4.x

kjeib measured this from a NativeScript chat app (gotchoices/sereus#45). `@nativescript-community/sqlite` 3.x's `arrayToNativeByteArray` / `byteArrayToBuffer` copy each byte separately, which costs 109-170 ms for a 16 KB blob on a Galaxy S7. 4.x, released 2026-10-14, does the copy natively.

## What to do

- Check 4.x's API against `ns-opener.ts` and the raw-storage and kv code. Note any breaking changes, such as how a name or path is opened.
- Widen the peer range to `^3.5.0 || ^4.0.0`, or move to `^4` if 3.x support isn't needed.
- Mention it in the release notes, so that Sereus's `reference-app-ns` can move to 4.x.

When opening the database, call sites should pass a full path (`getDatabasePath`) rather than a bare name. 3.x opens a bare name through the foreground activity, which may not exist yet at launch (Sereus `fix/ns-app-bundles-node-variants-and-opens-sqlite-by-bare-name`).
