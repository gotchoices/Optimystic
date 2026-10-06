/**
 * Matchmaking — db-p2p wiring to the cohort-topic substrate.
 *
 * The db-core `matchmaking` module owns the wire codecs, anchor, config, provider/seeker
 * decision/state, the capability filter, the pure query evaluation, and the hang-out decision engine;
 * these db-p2p bindings wire that logic to the cohort-topic substrate: the register/renew/withdraw
 * managers (tier T2), the cohort-side `QueryV1` handler and arrival-push driver with its libp2p send, the seeker-side arrival-push
 * receiver, and the seeker walk client that drives the hang-out-vs-continue walk. See `docs/matchmaking.md` §Provider registration / §Seeker
 * query / §Hang-out vs. continue / §Arrival push on provider arrival.
 */

export * from "./protocols.js";
export * from "./provider-manager.js";
export * from "./seeker-manager.js";
export * from "./query-handler.js";
export * from "./arrival-push-driver.js";
export * from "./arrival-push-send.js";
export * from "./arrival-push-receiver.js";
export * from "./query-transport.js";
export * from "./seeker-walk-client.js";
export * from "./aggregate-counts.js";
export * from "./traffic-validation.js";
export * from "./module.js";
