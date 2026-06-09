/**
 * Reactivity — forwarder-cohort `PushState` and its intra-cohort gossip codec
 * (`docs/reactivity.md` §Forwarder-cohort state, §Replay window).
 *
 * A reactivity forwarder cohort holds the cohort-topic registration records (the direct-subscriber
 * list **is** the `RegistrationRecord` set with `appPayload.kind == "reactivity"` — reactivity reads it,
 * it does not duplicate it) plus this per-collection {@link PushState}: topic identity, parent/child
 * cohort refs, the {@link ReplayBuffer} ring, the {@link DedupeWindow}, and `lastRevision`.
 *
 * `PushState` is gossiped within the cohort (over the cohort-topic gossip channel) so any member can
 * serve a backfill/replay if the primary is unavailable. This module defines the **full** struct and its
 * gossip codec so all three reactivity tickets share one definition; the `parentCheckpoint` and
 * `perSubscriberQueue` fields are **reserved** here and populated by the sibling tickets
 * ([reactivity-backfill-resume-checkpoints], [reactivity-rotation-backpressure-policy]).
 */

import { bytesToB64url, b64urlToBytes, decodeCohortMessage, encodeCohortMessage, DEFAULT_MAX_MESSAGE_BYTES } from "../cohort-topic/wire/codec.js";
import { CohortWireError } from "../cohort-topic/wire/validate.js";
import { DEDUPE_WINDOW_DEFAULT, W_DEFAULT } from "./config.js";
import { createDedupeWindow, type DedupeStateV1, type DedupeWindow } from "./dedupe.js";
import { createReplayBuffer, type ReplayBuffer, type ReplayBufferStateV1, type RevisionEntry } from "./replay-buffer.js";
import { validateNotificationV1 } from "./wire.js";

/** A reference to a parent/child cohort in the reactivity tree (`tier-(d∓1)`). */
export interface CohortRef {
	/** The cohort's served ring coordinate, base64url. */
	readonly coord: string;
	/** The cohort's primary member id, base64url (when known). */
	readonly primary?: string;
}

/**
 * Parent checkpoint summary — **reserved** for [reactivity-backfill-resume-checkpoints]
 * (`docs/reactivity.md` §Parent checkpoint summaries). Declared minimally here so {@link PushState}
 * carries the field and the three tickets share one struct; the sibling ticket fills out the merged
 * digest / bracketing-signature logic.
 */
export interface CheckpointSummary {
	readonly fromRevision: number;
	readonly toRevision: number;
}

/**
 * Per-subscriber bounded queue — **reserved** for [reactivity-rotation-backpressure-policy]
 * (`docs/reactivity.md` §Slow-subscriber backpressure). Declared minimally so {@link PushState} carries
 * the `perSubscriberQueue` field; the sibling ticket fills out drop-oldest semantics.
 */
export interface BoundedQueueRef {
	readonly capacity: number;
	readonly dropped: number;
}

/** Construction inputs for a {@link PushState}. */
export interface PushStateInit {
	/** Collection id, base64url. */
	readonly collectionId: string;
	/** Reactivity topic id, base64url. */
	readonly topicId: string;
	/** Tail block id when this cohort joined the topic, base64url. */
	readonly tailIdAtJoin: string;
	/** Tier-`(d−1)` parent cohort (absent at the tail/root). */
	readonly parentCohort?: CohortRef;
	/** Tier-`(d+1)` child cohorts. */
	readonly childCohorts?: CohortRef[];
	/** Replay buffer depth `W` (default {@link W_DEFAULT}). */
	readonly w?: number;
	/** Dedupe-window span (default {@link DEDUPE_WINDOW_DEFAULT}). */
	readonly dedupeWindow?: number;
}

/** The cohort-gossiped wire image of a {@link PushState}. */
export interface PushStateGossipV1 {
	v: 1;
	collectionId: string;
	topicId: string;
	tailIdAtJoin: string;
	parentCohort?: CohortRef;
	childCohorts: CohortRef[];
	lastRevision: number;
	replayBuffer: ReplayBufferStateV1;
	dedupe: DedupeStateV1;
}

/**
 * Per-collection forwarder-cohort state. Owns the live {@link ReplayBuffer} and {@link DedupeWindow}
 * components and the scalar identity/revision state; the reserved sibling-ticket fields hang off it.
 */
export class PushState {
	readonly collectionId: string;
	readonly topicId: string;
	tailIdAtJoin: string;
	parentCohort?: CohortRef;
	childCohorts: CohortRef[];
	readonly replayBuffer: ReplayBuffer;
	readonly dedupe: DedupeWindow;
	lastRevision: number;

	/** Reserved — populated by [reactivity-backfill-resume-checkpoints]. */
	parentCheckpoint?: CheckpointSummary;
	/** Reserved — populated by [reactivity-rotation-backpressure-policy]. */
	readonly perSubscriberQueue: Map<string, BoundedQueueRef> = new Map();

	constructor(init: PushStateInit) {
		this.collectionId = init.collectionId;
		this.topicId = init.topicId;
		this.tailIdAtJoin = init.tailIdAtJoin;
		this.parentCohort = init.parentCohort;
		this.childCohorts = init.childCohorts ?? [];
		this.replayBuffer = createReplayBuffer(init.w ?? W_DEFAULT);
		this.dedupe = createDedupeWindow(init.dedupeWindow ?? DEDUPE_WINDOW_DEFAULT);
		this.lastRevision = -1;
	}

	/** Snapshot the gossipable slice for cohort replication. */
	serializeGossip(): PushStateGossipV1 {
		const out: PushStateGossipV1 = {
			v: 1,
			collectionId: this.collectionId,
			topicId: this.topicId,
			tailIdAtJoin: this.tailIdAtJoin,
			childCohorts: this.childCohorts,
			lastRevision: this.lastRevision,
			replayBuffer: this.replayBuffer.serialize(),
			dedupe: this.dedupe.serialize(),
		};
		if (this.parentCohort !== undefined) {
			out.parentCohort = this.parentCohort;
		}
		return out;
	}

	/** Merge a peer member's gossiped state so the whole cohort converges (any member can then serve). */
	mergeGossip(g: PushStateGossipV1): void {
		if (g.collectionId !== this.collectionId || g.topicId !== this.topicId) {
			return; // gossip for a different collection/topic is not ours to merge
		}
		this.replayBuffer.merge(g.replayBuffer);
		this.dedupe.merge(g.dedupe);
		if (g.lastRevision > this.lastRevision) {
			this.lastRevision = g.lastRevision;
		}
		if (g.childCohorts.length > this.childCohorts.length) {
			this.childCohorts = g.childCohorts;
		}
		if (this.parentCohort === undefined && g.parentCohort !== undefined) {
			this.parentCohort = g.parentCohort;
		}
	}
}

// --- gossip codec (length-framed JSON, mirroring cohort-topic conventions) ---

function fail(message: string): never {
	throw new CohortWireError(message);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${what}: expected an object`);
	}
	return value as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, key: string, what: string): string {
	const value = obj[key];
	if (typeof value !== "string") {
		fail(`${what}: field "${key}" must be a string`);
	}
	return value;
}

function reqFiniteNumber(obj: Record<string, unknown>, key: string, what: string): number {
	const value = obj[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(`${what}: field "${key}" must be a finite number`);
	}
	return value;
}

function reqInt(value: number, key: string, what: string): number {
	if (!Number.isInteger(value)) {
		fail(`${what}: field "${key}" must be an integer, got ${value}`);
	}
	return value;
}

function b64urlField(value: string, key: string, what: string): string {
	try {
		b64urlToBytes(value);
	} catch {
		fail(`${what}: field "${key}" is not valid base64url`);
	}
	return value;
}

function validateCohortRef(value: unknown, what: string): CohortRef {
	const obj = asObject(value, what);
	const coord = b64urlField(reqString(obj, "coord", what), "coord", what);
	if (obj["primary"] !== undefined) {
		return { coord, primary: b64urlField(reqString(obj, "primary", what), "primary", what) };
	}
	return { coord };
}

function validateRevisionEntry(value: unknown, what: string): RevisionEntry {
	const obj = asObject(value, what);
	return {
		revision: reqInt(reqFiniteNumber(obj, "revision", what), "revision", what),
		payload: validateNotificationV1(obj["payload"]),
		receivedAt: reqFiniteNumber(obj, "receivedAt", what),
	};
}

function validateReplayBufferState(value: unknown, what: string): ReplayBufferStateV1 {
	const obj = asObject(value, what);
	const entries = obj["entries"];
	if (!Array.isArray(entries)) {
		fail(`${what}: field "entries" must be an array`);
	}
	return {
		capacity: reqInt(reqFiniteNumber(obj, "capacity", what), "capacity", what),
		entries: entries.map((e) => validateRevisionEntry(e, `${what}.entry`)),
	};
}

function validateDedupeState(value: unknown, what: string): DedupeStateV1 {
	const obj = asObject(value, what);
	const entries = obj["entries"];
	if (!Array.isArray(entries)) {
		fail(`${what}: field "entries" must be an array`);
	}
	return {
		highestRevision: reqInt(reqFiniteNumber(obj, "highestRevision", what), "highestRevision", what),
		entries: entries.map((e) => {
			const eo = asObject(e, `${what}.entry`);
			return { key: reqString(eo, "key", `${what}.entry`), revision: reqInt(reqFiniteNumber(eo, "revision", `${what}.entry`), "revision", `${what}.entry`) };
		}),
	};
}

/** Narrow an already-parsed value to {@link PushStateGossipV1}, throwing on any defect. */
export function validatePushStateGossipV1(value: unknown): PushStateGossipV1 {
	const what = "PushStateGossipV1";
	const obj = asObject(value, what);
	if (obj["v"] !== 1) {
		fail(`${what}: expected v === 1, got ${JSON.stringify(obj["v"])}`);
	}
	const childCohorts = obj["childCohorts"];
	if (!Array.isArray(childCohorts)) {
		fail(`${what}: field "childCohorts" must be an array`);
	}
	const out: PushStateGossipV1 = {
		v: 1,
		collectionId: b64urlField(reqString(obj, "collectionId", what), "collectionId", what),
		topicId: b64urlField(reqString(obj, "topicId", what), "topicId", what),
		tailIdAtJoin: b64urlField(reqString(obj, "tailIdAtJoin", what), "tailIdAtJoin", what),
		childCohorts: childCohorts.map((c) => validateCohortRef(c, `${what}.childCohort`)),
		lastRevision: reqInt(reqFiniteNumber(obj, "lastRevision", what), "lastRevision", what),
		replayBuffer: validateReplayBufferState(obj["replayBuffer"], `${what}.replayBuffer`),
		dedupe: validateDedupeState(obj["dedupe"], `${what}.dedupe`),
	};
	if (obj["parentCohort"] !== undefined) {
		out.parentCohort = validateCohortRef(obj["parentCohort"], `${what}.parentCohort`);
	}
	return out;
}

/** Encode a {@link PushStateGossipV1} as a length-prefixed UTF-8 JSON frame. */
export function encodePushStateGossipV1(msg: PushStateGossipV1, maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES): Uint8Array {
	return encodeCohortMessage(validatePushStateGossipV1(msg), maxMessageBytes);
}

/** Decode a length-prefixed {@link PushStateGossipV1} frame. */
export function decodePushStateGossipV1(bytes: Uint8Array, maxMessageBytes?: number): PushStateGossipV1 {
	return validatePushStateGossipV1(decodeCohortMessage(bytes, maxMessageBytes));
}

/** Round-trip helper for `bytesToB64url` consumers wanting the raw coord bytes of a {@link CohortRef}. */
export function cohortRefCoordBytes(ref: CohortRef): Uint8Array {
	return b64urlToBytes(ref.coord);
}

/** Build a {@link CohortRef} from raw coord (and optional primary) bytes. */
export function makeCohortRef(coord: Uint8Array, primary?: Uint8Array): CohortRef {
	return primary !== undefined
		? { coord: bytesToB64url(coord), primary: bytesToB64url(primary) }
		: { coord: bytesToB64url(coord) };
}
