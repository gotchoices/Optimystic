/**
 * Matchmaking — db-p2p wiring to the cohort-topic substrate.
 *
 * The db-core `matchmaking` module owns the wire codecs, anchor, config, and provider/seeker
 * decision/state; these managers bind that state to the participant-facing `CohortTopicService`
 * (register/renew/withdraw at tier T2). See `docs/matchmaking.md` §Provider registration / §Seeker
 * query.
 */

export * from "./provider-manager.js";
export * from "./seeker-manager.js";
