description: Give the crypto plugin a SQL function that generates a random id and tells Quereus it is unique per call, so a row keyed by it is predicted safe to sync without the application tagging the column.
architecture: docs/offline-sync.md#judging-each-guard
files: packages/quereus-plugin-crypto/src/plugin.ts, packages/quereus-plugin-crypto/README.md
difficulty: easy
tradeoffs: `hex(randomblob(16))` and `StampId()` already classify fresh, and an application can tag a column `optimystic.fresh`, so a third fresh source may never be asked for.
----

Quereus labels a written value `fresh` (unique per call, at least 128 bits of entropy) when it comes from a function carrying `FunctionFlags.FRESH`, from `randomblob(n)` with literal `n ≥ 16`, or from an injective wrapper over one of those (`../quereus/docs/write-scope.md` § Written-value provenance). The offline outlook reads that label to decide that no other machine can collide with a generated key ([docs/offline-sync.md §Judging each guard](../../docs/offline-sync.md#judging-each-guard)).

The crypto plugin's `random_bytes(bits, encoding)` cannot carry the flag: its width is an argument (default 256 bits), and the flag is a promise regardless of arguments, so `random_bytes(8)` would be labelled fresh falsely. The design doc's earlier test plan named `random_bytes(16)` as a fresh source; it was corrected to `hex(randomblob(16))`.

## What is wanted

A zero-argument function in the crypto plugin — `random_id()`, or a name the plugin's naming prefers — returning a base64url string of 16 or more random bytes, registered with `fresh: true` (which sets the flag and clears `DETERMINISTIC`; it must not also declare `deterministic`). Declare its `returnType` as text so a write of it to a text column stays fresh. Document it in the crypto plugin's README beside `random_bytes`, with the one-line rule for which of the two the outlook treats as fresh.

No optimystic-side change: the outlook reads the provenance label and needs nothing per function.
