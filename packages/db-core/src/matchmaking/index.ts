/**
 * Matchmaking — the directory application of the cohort-topic substrate.
 *
 * See `docs/matchmaking.md`. This ticket lands the foundation layer: wire codecs, the stable
 * topic-anchor derivation, the configuration slice, and both registration roles' decision/state
 * (provider attach/renew/self-throttle; seeker short-TTL registration). Query/filter evaluation and
 * the seeker hang-out engine land in `matchmaking-query-filter-hangout`.
 */

export * from "./config.js";
export * from "./topic-anchor.js";
export * from "./wire.js";
export * from "./provider.js";
export * from "./seeker.js";
