/**
 * Reactivity — push-based change notifications on the cohort-topic substrate.
 *
 * See `docs/reactivity.md`. This module lands the reactivity **hot path**: the rotating tail-anchored
 * topic, the subscribe `appPayload`, notification origination (reusing the commit cert unchanged), the
 * forwarder receive path (verify → dedupe → buffer → forward), the `W`-entry replay ring with cohort
 * gossip, the sliding `(revision, sigDigest)` dedupe window, and subscriber-side verify/deliver with gap
 * detection. Backfill/resume/checkpoints, tail rotation, and backpressure are delivered by the sibling
 * tickets ([reactivity-backfill-resume-checkpoints], [reactivity-rotation-backpressure-policy]); the
 * `parentCheckpoint` / `perSubscriberQueue` fields here are reserved for them.
 */

export * from "./config.js";
export * from "./topic-anchor.js";
export * from "./wire.js";
export * from "./notification.js";
export * from "./dedupe.js";
export * from "./replay-buffer.js";
export * from "./push-state.js";
export * from "./verify.js";
export * from "./forwarder.js";
export * from "./subscriber.js";
export * from "./subscription.js";
