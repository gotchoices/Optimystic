description: Each value written in a transaction is carried at least twice, once in the data blocks it changes and once in the log entry that records the change, so a transaction holds only about 2 MB of blob data. Deciding whether to stop repeating it is a change to the stored log format, so it needs a maintainer's call.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/log/log.ts (`Log.addActions`), packages/db-core/src/log/struct.ts (`ActionEntry`), packages/db-core/src/collection/collection.ts (`Collection.replayActions`, head commit), packages/db-core/src/collection/segments.ts, packages/upgrade-check/
----

**Blocked: an architecture decision.** Split from `plan/0.6-a-large-write-costs-time-and-space-per-byte` (GitHub #63). Unblocks when a maintainer accepts or edits the proposal below.

## The question

A log entry records each action (for a SQL write, the row itself) beside the transforms of the blocks the action changes, so row data is counted about twice against the 7.5 MiB transaction limit and paid for twice in encoding, hashing and storage (docs/internals.md §A transaction's size limit; GitHub #61 measured about 2.2× for small text rows, #63 about 2.75–3.4× for blobs including base64). Removing the repeat means the log entry names its actions by reference or digest instead of carrying them.

The repeat is load-bearing today: conflict replay (`Collection.replayActions`) and the offline queue's sealed segments re-run actions read from the log, a retry must resend byte-identical transforms, and the planned replay-mode merge (backlog `6.52-feat-replay-mode-collections-merge-divergent-histories`) merges divergent histories by replaying their logged actions.

## Proposal (recommended default)

Keep the log format as it is in this release, and send large values outside transactions instead: document a practical ceiling of about 2 MB of blob data per transaction, and point large-content applications at a content layer (the strand-scoped file layer proposed in sereus#62, or Quereus's native large-value request, gotchoices/quereus#40). Revisit the format once the replay-mode merge design settles what the log must carry, so the format changes at most once.

## Alternatives

- **Log entries carry action digests; replay reads the content from blocks.** Doubles what fits in a transaction, but is a persisted-format change (new reader for old entries, upgrade-check fixtures) and conflicts with replaying a history whose blocks this machine does not hold.
- **Compress** (backlog `7.5-block-compression` under `backlog/enhancements`). Helps text and JSON, does little for already-compressed attachments.

## If nothing is done

Transactions stay limited to about 2 MB of blob data; applications chunk large content across transactions, as the reporter already does.

## Reversibility

The recommended default changes nothing and is fully reversible. The digest alternative is a one-way format change once written data exists.
