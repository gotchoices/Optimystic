/**
 * Reactivity — push-based change notifications on the cohort-topic substrate.
 *
 * See `docs/reactivity.md`. This module lands the reactivity hot path — the rotating tail-anchored topic,
 * the subscribe `appPayload`, notification origination (reusing the commit cert unchanged), the forwarder
 * receive path (verify → dedupe → buffer → forward), the `W`-entry replay ring with cohort gossip, the
 * sliding `(revision, sigDigest)` dedupe window, and subscriber-side verify/deliver with gap detection
 * ([reactivity-origination-replay-delivery]) — plus **recovery beyond the live stream**
 * ([reactivity-backfill-resume-checkpoints]): the {@link ./backfill.js} RPC served from the replay ring,
 * the rolling parent {@link ./checkpoint.js} stacked below it, and the four-variant {@link ./resume.js}
 * protocol for mobile wake — plus **tail rotation, slow-subscriber backpressure, and Edge/Core policy**
 * ([reactivity-rotation-backpressure-policy]): the {@link ./rotation.js} lifecycle (pre-announce, drain,
 * jittered re-registration, buffer-to-checkpoint handoff, warm-up), the per-subscriber drop-oldest
 * {@link ./backpressure.js}, and the {@link ./policy.js} Edge-subscriber-only / `delta_max` gate.
 */

export * from "./config.js";
export * from "./topic-anchor.js";
export * from "./wire.js";
export * from "./notification.js";
export * from "./dedupe.js";
export * from "./replay-buffer.js";
export * from "./checkpoint.js";
export * from "./backpressure.js";
export * from "./push-state.js";
export * from "./verify.js";
export * from "./forwarder.js";
export * from "./subscriber.js";
export * from "./subscription.js";
export * from "./backfill.js";
export * from "./resume.js";
export * from "./recover.js";
export * from "./rotation.js";
export * from "./policy.js";
