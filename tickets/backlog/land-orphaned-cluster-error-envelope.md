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

## Notes

This ticket is a flag for in-progress code that needs a home, not a new feature spec — the design already exists in the working-tree files above; the task is to verify, test, and land it correctly.
