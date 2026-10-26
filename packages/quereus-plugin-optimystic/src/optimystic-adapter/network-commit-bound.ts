/**
 * The longest a network-acknowledged SQL commit is given, five minutes, read by the two places that
 * bound one: the expiry of a legacy multi-tree commit's transaction stamp
 * (`TransactionBridge.legacyTransaction`), and the default wait of a network-acknowledged commit
 * queued behind offline transactions (`OfflineConfig.networkCommitTimeoutMs`). Set well above the
 * default retry budget (about 21 s of backoff across 10 attempts, plus round trips) so that the
 * budget, not the clock, ends a contended commit; the single-tree `Collection.sync` path has no clock
 * at all.
 */
export const NetworkCommitBoundMs = 5 * 60_000;
