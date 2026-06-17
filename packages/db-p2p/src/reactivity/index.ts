/**
 * Reactivity — db-p2p wiring to the cohort-topic substrate.
 *
 * The db-core `reactivity` module owns the wire codecs, topic anchor, config, origination assembler,
 * forwarder/dedupe/replay logic, and subscriber-side verify/deliver; these managers bind that to the
 * participant-facing `CohortTopicService` (subscribe/renew/withdraw at tier T3) and install the
 * `onLocalCommit` origination hook. See `docs/reactivity.md` §Subscription / §Notification origination.
 */

export * from "./protocols.js";
export * from "./notify-transport.js";
export * from "./subscription-manager.js";
export * from "./origination-manager.js";
