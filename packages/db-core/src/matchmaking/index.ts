/**
 * Matchmaking — the directory application of the cohort-topic substrate.
 *
 * See `docs/matchmaking.md`. The db-core layer owns the transport-agnostic pieces: wire codecs +
 * seeker-side entry re-validation, the stable topic-anchor derivation, configuration, both
 * registration roles' decision/state (provider attach/renew/self-throttle; seeker short-TTL
 * registration), the cohort-side capability filter + pure query evaluation, and the seeker
 * hang-out-vs-continue decision engine. The db-p2p layer wires these to the cohort-topic substrate
 * (managers, the cohort query handler, the seeker walk client).
 */

export * from "./config.js";
export * from "./topic-anchor.js";
export * from "./wire.js";
export * from "./provider.js";
export * from "./seeker.js";
export * from "./capability-filter.js";
export * from "./query-eval.js";
export * from "./seeker-walk.js";
export * from "./multi-cohort-seeker.js";
export * from "./voting-quorum.js";
