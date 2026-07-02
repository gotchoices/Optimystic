----
description: The peer-to-peer node startup code silently ignores errors while connecting up its most critical internal services, so if that wiring fails the node keeps running and the failure only shows up much later as confusing network and consensus misbehavior instead of a clear error.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts
difficulty: medium
----

Review finding eh-4 (docs/review.html, Section 9 "Cross-cutting engineering health"). This is the canonical home for the swallowed-wiring concern; a separate p2p composition-root finding may overlap, which is fine.

All of the repository's empty `catch { }` blocks live in `packages/db-p2p/src/libp2p-node-base.ts` (around lines 481-533). They wrap `setLibp2p` injections that the file's own comments describe as load-bearing — for example the `repo` service injection is explicitly "done before start() so the protocol handler is live with a resolvable node from its first request." If any of these injections throws, the error is discarded and the node continues in a half-wired state; the symptom surfaces later as mysterious routing or consensus failures with no trace back to the real cause.

Separately, `createLibp2p(libp2pOptions as any)` at ~line 504 casts the entire options object to `any`, defeating libp2p's configuration typing at exactly the seam where a misconfiguration is most costly.

Expected end state:

- Every `setLibp2p` injection either succeeds or its failure is surfaced. At minimum, log each swallowed wiring failure through the package's `debug` logger with enough context to identify which service failed; for injections the comments call load-bearing, consider failing fast (rejecting node creation) rather than continuing degraded — decide per-injection based on whether the node can function without that service.
- Replace the untyped `(svc as any).setLibp2p?.(...)` / `(node as any).services?.X` access with a typed `SetLibp2pCapable` interface and a typed services record, so the compiler checks these calls.
- Remove the `libp2pOptions as any` cast to `createLibp2p`, typing `libp2pOptions` to libp2p's expected config shape (narrow or adjust the local option construction as needed rather than casting the whole object).
