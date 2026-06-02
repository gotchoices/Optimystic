description: Review and properly land an uncommitted structured cluster-error-envelope feature found loose in the working tree, attributing it to its own ticket rather than leaving it to be swept into an unrelated commit.
files: packages/db-p2p/src/cluster/cluster-error.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/cluster/client.ts, docs/architecture.md
prereq:
----

## Problem

During the review of the DCUtR/AutoNAT ticket, the working tree was found to contain a coherent body of **uncommitted, unrelated work** — a structured error envelope for the cluster protocol — that does not belong to the DCUtR/AutoNAT change:

- `packages/db-p2p/src/cluster/cluster-error.ts` (new, untracked) — `CLUSTER_ERROR_KEY` / `ClusterErrorEnvelope` / `toClusterErrorEnvelope` / `isClusterErrorEnvelope` / `clusterErrorFromEnvelope`. The cluster service serializes a thrown error as this envelope and closes the stream normally; the coordinator's `ClusterClient` detects the envelope and rethrows a real `Error` instead of collapsing into an opaque `StreamResetError`.
- `packages/db-p2p/src/cluster/service.ts` (modified) — uses `toClusterErrorEnvelope`.
- `packages/db-p2p/src/cluster/client.ts` (modified) — imports `clusterErrorFromEnvelope` and rethrows on the coordinator side.
- `docs/architecture.md` (modified) — cluster protocol-prefix rename in the protocol table + mermaid diagram (`/db-p2p/cluster` → `/{prefix}/cluster`).

This is related to the cluster protocol / `optimystic-cluster-membership-check` line of work (already in `tickets/complete/`), not to DCUtR/AutoNAT.

## Why this needs attention

- HEAD is self-consistent **without** these changes (HEAD `client.ts` does not import `cluster-error.js`, and `cluster-error.ts` does not exist in HEAD). The working tree adds the feature additively. It builds cleanly and the full `db-p2p` suite (485 passing / 8 pending) passes with it present.
- Because it was loose in the working tree during an unrelated ticket, it risks being committed under the wrong ticket message (or, worse, discarded). It was deliberately left untouched during the DCUtR review — neither deleted nor committed.

## Requirements

- Determine the correct attribution for this work (likely a follow-on to the cluster-membership / cluster-protocol error-handling effort) and land it under its own properly-scoped ticket and commit.
- If it was already swept into the DCUtR/AutoNAT commit by the runner, split it back out into its own commit.
- Confirm the feature is intentional and complete: structured-error round-trip on the cluster `update` path (service serializes → client deserializes and rethrows with original message/name/code), and the `docs/architecture.md` protocol-prefix rename is consistent with the actual `protocolPrefix` used in `cluster/service.ts`.
- Add/confirm test coverage for the envelope round-trip (error thrown server-side surfaces as a typed `Error` with the original message on the coordinator, not a `StreamResetError`), since the loose work did not arrive with an obvious dedicated spec.
- **Document the envelope wire contract in `packages/db-p2p/docs/cluster.md`.** The "Error Handling and Monitoring → Error Conditions" section (~line 585) documents *which* errors are thrown but not *how they now propagate over the protocol*. Add that a member that throws while processing an `update` serializes the error into a structured `__clusterError` envelope and **closes the stream normally** (no longer `stream.abort`), and that the coordinator's `ClusterClient` rethrows the original `Error` preserving `name`/`code`. This is the new wire reality and is currently undocumented.

## Status as of 2026-06-02 (sereus review of `web-e2e-tier2-cluster-tx-error-surface`)

- The work **was** swept into commit `ba4a0df` (`ticket(review): enable-dcutr-autonat-in-libp2p-node-base`) — requirement #2 ("split it back out into its own commit") is the live action item. `cluster-error.ts`, `service.ts`, `client.ts`, and the doc protocol-prefix rename are all in that commit.
- Test coverage **has** landed: `packages/db-p2p/test/cluster-error-propagation.spec.ts` (8 tests) covers the helper round-trip, the service producing an envelope and closing (not aborting) on a throwing `update`, and the client rethrowing. Full `db-p2p` suite green (496 passing / 8 pending / 0 failing). Requirement #4 is satisfied; verify it survives the re-attribution split.
- The legacy `/db-p2p/cluster/1.0.0` second-dial fallback was removed from `client.ts`. Verified safe: `libp2p-node-base.ts` registers the service and dials the client under the same `/optimystic/<network>` prefix, so the bare protocol is never registered. No `ERR_PROTOCOL_SELECTION_FAILED` can originate from a cluster update anymore.

## Notes

This ticket is a flag for in-progress code that needs a home, not a new feature spec — the design already exists in the working-tree files above; the task is to verify, test, and land it correctly.
