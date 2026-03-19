# Schema Versioning for Multi-Node

description: no explicit schema version tracking; schema cache can become stale when another node updates the schema
dependencies: none
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
----

Schema is stored and retrieved but has no version tracking. In a single-node deployment this is benign because the local cache is the only copy. In multi-node deployments, if node A performs DDL that changes the schema, node B's cached schema becomes stale with no mechanism to detect this beyond transaction validation failures (schema hash mismatch).

A version counter or change-notification mechanism would allow nodes to detect and refresh stale schemas proactively rather than failing at commit time.
