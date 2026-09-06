----
description: When a read fails, the database layer works hard to say exactly which of four things went wrong — but the SQL adapter throws that away and hands the application a plain error with the reason flattened into English prose. An application that wants to react differently to "nobody could be reached" than to "somebody else has it" has nothing to test but the text of a sentence.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:704, :1153, :2405, :2916, :2929, :2942 (six `throw new Error(message)` rewraps — the break)
  - packages/db-core/src/network/struct.ts:273 (`BlockUnavailableError`, carrying `reason`) and :289 (`BlockPossiblyStaleError`, carrying `claimedRev`)
  - packages/db-core/src/network/struct.ts:218 (`BlockUnavailableReason` — the four values)
  - packages/quereus/src/runtime/emit/scan.ts:227 (in the sibling `../quereus` checkout — the layer ABOVE, which does preserve `cause`)
difficulty: easy
repro: static
severity: wrong-result
likelihood: normal-use
----

# The SQL adapter flattens a typed read failure into a string

## What is wrong

`db-core` raises two errors that exist specifically so a caller can branch on them:

- `BlockUnavailableError` carries `reason: BlockUnavailableReason` — one of `'unmaterializable'`,
  `'peers-unreachable'`, `'cohort-unreachable'`, `'claimed-elsewhere'`. Naming those apart was the
  entire deliverable of `complete/absence-verdict-names-the-evidence`.
- `BlockPossiblyStaleError` carries `claimedRev: number`.

Every read that reaches SQL passes through `OptimysticModule`, and at six places it does this:

```ts
} catch (error) {
  const message = `Query failed: ${error instanceof Error ? error.message : String(error)}`;
  this.setErrorMessage(message);
  throw new Error(message);
}
```

`new Error(message)` with no `{ cause }`. The class, the `reason` field and the `claimedRev` field
are gone; what survives is the sentence they were interpolated into.

## Why the layer above makes this worse, not better

The chain is one link short, and the missing link is the only one in our control:

| layer | what it does with the error |
| --- | --- |
| `db-core` | throws `BlockUnavailableError`, `reason` populated |
| **this plugin** | **`throw new Error(message)` — class and fields dropped** |
| `quereus` `scan.ts:227` | `new QuereusError(msg, code, e)` → `super(message, { cause })` — **preserves it** |

So Quereus already threads `cause` faithfully. Repair the six sites and an application reading
through SQL can walk `err.cause` to the original error and test `reason`; leave them and no amount
of work upstream or downstream can recover it.

## The claim this refutes, which is why it is worth fixing rather than noting

`complete/absence-verdict-names-the-evidence` states its contract as:

> `BlockUnavailableError.reason` carries the value verbatim through `TransactorSource.tryGet`,
> `Collection.bootstrapContext`, and `NetworkTransactor.get`, so a consumer's boot path can catch
> `reason === 'cohort-unreachable'` and proceed under its own risk model **with no further
> plumbing**.

That is true for a consumer calling `db-core` directly. It is false for a consumer reading through
SQL, and every real consumer we have reads through SQL. The ticket deliberately left the boot
policy to the caller — correctly — but the caller cannot execute that policy, because the value the
policy would branch on does not reach it.

## Who is waiting on it

`sereus/tickets/blocked/control-read-over-fresh-edge-stream-resets` (a `repro: verified` ticket in
the sibling `../sereus` checkout, failing 5 of 5 isolated rounds) dies during boot on exactly this
value, and can only see it as prose:

```
Error during query on table 'Revocation': Query failed:
  Block default/Revocation is unavailable (cohort-unreachable): the repo could not determine whether it exists
```

That is a `QuereusError` wrapping a plain `Error` wrapping nothing. Its `reason` is present three
frames down in a string. Their ticket is parked as "a dependency outside this repo"; the dependency
is this rewrap.

Note the value of telling the four reasons apart is not hypothetical for them: `'cohort-unreachable'`
means *nobody outside this node could be asked*, which during a boot may well be tolerable under a
consumer's own risk model, while `'claimed-elsewhere'` means *the block is known to exist somewhere*
and tolerating it would serve a knowingly false absent.

## Expected behaviour

A read failure crossing the SQL adapter must keep the original error reachable. The message may
still be rewritten for display — the change is additive:

- The thrown error carries `{ cause: error }` so the original object survives, with its class and
  its fields.
- A caller that walks the cause chain can recover `BlockUnavailableError.reason` and
  `BlockPossiblyStaleError.claimedRev`.
- Nothing that only reads `.message` changes behaviour.

## Why this is filed at the seam rather than as six edits

Six sites in one file share one rewrap shape, and nothing stops a seventh being written the same
way tomorrow — the file is 3,000 lines and actively worked. The durable form of this fix is one
helper that every catch arm in the module funnels through, plus a test that fails if a rewrap loses
its cause. Filing the instance without the invariant buys one fix and no protection.

## Verification status — honest about what has and has not been run

`repro: static`. Established by reading code, not by running it:

- The six sites and their exact `throw new Error(message)` shape (grep, this file).
- `QuereusError`'s constructor doing `super(message, { cause })` (read in `../quereus`).
- `BlockUnavailableError` declaring `readonly reason` (read in `db-core`).
- The failing message text, quoted from the downstream ticket's own capture.

**What would confirm it** and should be the first task: a spec in
`packages/quereus-plugin-optimystic/test/` that drives a read whose transactor raises
`BlockUnavailableError`, catches what SQL throws, and asserts the cause chain reaches an error with
`reason === 'cohort-unreachable'`. That test fails at HEAD and passes after the fix, which is the
whole ticket in one assertion.

## TODO

- Write the failing spec above first; confirm it fails at HEAD.
- Funnel the module's catch arms through one rewrap helper that preserves `cause`, and cover
  `BlockPossiblyStaleError` as well as `BlockUnavailableError` — the same six arms drop both.
- Check whether the message should keep interpolating the original text at all once the cause is
  reachable, or whether doubling it up (prose *and* structure) is worth keeping for logs. Either is
  defensible; say which and why.
- Sweep the rest of the package for the same shape before concluding six is the count — the grep
  above covered `optimystic-module.ts` only.
- Note for whoever picks this up: `backlog/debt-optimystic-vtab-class-is-too-big-to-review` proposes
  splitting this same 3,000-line file. It is a pure move-code refactor and does not own error
  handling, so there is no conflict of intent — but expect textual conflicts if both are in flight,
  and land the helper first so the split carries it along.
