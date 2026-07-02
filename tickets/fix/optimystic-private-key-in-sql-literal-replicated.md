description: A SQL statement that passes a private signing key inline as a literal gets stored verbatim in the transaction record and shipped to other nodes to re-run — so secret key material leaves the machine.
files: packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
difficulty: medium
----

## Bug (security)

A data-mutating statement that embeds a private key as a SQL literal — e.g.
`... sign(<data>, '<privkey>') ...` — is captured **verbatim** into the
replicated transaction record and sent to validator peers to re-execute. The
private key material therefore leaves the originating node.

The cryptography itself is sound (noble-curves prehash defaults, RFC6979 nonces,
low-S, CSPRNG). This is an **integration-level exposure**: the replication layer
records the literal SQL text without regard to whether a call's arguments are
secret or whether re-executing the call on another node is even meaningful.

Locations (verify current lines): `sign()` implementation
`quereus-plugin-crypto/src/plugin.ts:224-235`; statement capture
`optimystic-module.ts:914-916` and `txn-bridge.ts:369-379`.

## Expected behavior

Secret key material never enters the replicated transaction record. Directions
(from review, likely combined):

- **Document + guide:** `sign()` (and any function taking secret arguments) must
  receive keys via bound parameters, not inline literals, and must not appear in
  replicated mutation statements. A bound parameter value is not part of the
  recorded SQL text.
- **Enforce:** before accumulating a mutation statement into the record, detect
  statements containing non-replicable / secret-bearing function calls and
  redact or reject them (re-executing a `sign()` on a validator is not even
  semantically valid, so rejecting is defensible).

This is a design decision on redact-vs-reject and how to identify
non-replicable functions; resolve it in this ticket (or split a small plan step)
before implementing. Add a test asserting a `sign(...)`-bearing DML statement
does not land in the transaction record with the key visible.

## Edge cases

- Key as literal vs bound parameter (only the literal case leaks).
- Non-DML statements (may not be recorded — confirm).
- Other crypto functions that could take secret arguments.
