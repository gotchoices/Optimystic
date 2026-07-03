/**
 * Reactivity — shared wire-validation primitives.
 *
 * The reactivity message codecs ({@link import("./wire.js")}, {@link import("./push-state.js")},
 * {@link import("./backfill.js")}, {@link import("./resume.js")}, plus checkpoint / rotation / recover)
 * decode untrusted JSON into validated V1 shapes with the same structural checks the rest of the
 * substrate uses. Those generic primitives now live in one place —
 * {@link import("../cohort-topic/wire/primitives.js")} — so a hardening tweak lands once; this module is
 * a thin re-export kept so the reactivity codecs import from a sibling path. Every helper throws
 * {@link CohortWireError} on a defect (base64url byte fields, finite/integer numbers, `v: 1`).
 */

export * from "../cohort-topic/wire/primitives.js";
