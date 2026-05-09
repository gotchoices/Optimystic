----
description: Optional OPFS-backed IRawStorage in @optimystic/db-p2p-storage-web for higher-throughput browser persistence
prereq: web-raw-storage-indexeddb
files: packages/db-p2p-storage-web/src
----

The IndexedDB-backed `IRawStorage` lands first because it works on the main thread in every modern browser. OPFS (Origin Private File System) offers significantly faster writes for blob-shaped data — useful as block sizes grow — but its synchronous handle API is only available inside a Worker, and the main-thread async surface is more limited.

Add a parallel `OPFSRawStorage` in the same `@optimystic/db-p2p-storage-web` package. Selection is explicit (caller chooses which provider to instantiate) — do not auto-detect OPFS and silently switch backends; reference apps need to know which one they're validating.

Open questions to resolve before promoting from backlog:
- Worker-vs-main-thread API: do we ship a wrapper that runs OPFS in a dedicated Worker so callers retain a main-thread async API, or expose only a Worker-side variant?
- Coexistence with IndexedDB-stored identity (`identity.ts`) — keep identity in IndexedDB even when block storage is OPFS, or move both?
- Migration path from IndexedDB → OPFS for existing browser users (probably out of scope; document re-pair as the answer).

Promote when there is a measured perf reason; not blocking the web reference app.
