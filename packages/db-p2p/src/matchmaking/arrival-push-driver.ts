/**
 * Matchmaking — the cohort member that sends arrival pushes (db-p2p).
 *
 * `docs/matchmaking.md` §Arrival push on provider arrival. When a provider's registration becomes present
 * on one of this node's cohort engines ({@link import("../cohort-topic/host.js").CohortTopicHost.onRecordAdded}
 * — admission, gossip merge or handoff pull, never a renewal), the driver ranks the push-opted seekers the
 * engine holds for the topic with db-core's {@link selectArrivalPushTargets}, and keeps the ones whose slot
 * primary is this node. Every member runs the same selection over the same gossip-replicated records, so
 * each selected seeker is pushed by exactly one member. The primary is computed fresh from the engine's
 * current cohort view, so a rotation moves push duty with no handoff of push state.
 *
 * Per seeker registration — a **binding**, keyed `(servedCoord, topicId, seeker, correlationId)` — arrivals
 * are coalesced for `coalesceMs` (or flushed at once when they cover the seeker's whole outstanding need),
 * then signed with this node's peer key and sent as one {@link ArrivalPushV1}. Binding state is soft and
 * local: never gossiped, lost on restart or engine eviction. A re-created binding may re-push a provider the
 * seeker already has, which the seeker dedups by `participantId`. Pushes are not queries, so nothing here
 * counts toward the engine's `queriesPerMin` (doc §Contention-signal interaction).
 *
 * Independent of libp2p: delivery, signing, the slot rule and timers are injected, so the mesh harness and
 * unit tests drive it directly. The libp2p `send` binding and the node wiring live elsewhere.
 */

import {
	DEFAULT_ARRIVAL_PUSH_CONFIG,
	QUERY_LIMIT_MAX,
	arrivalPushSigningPayload,
	bytesEqual,
	bytesToB64url,
	decodeArrivalPushAckV1,
	encodeArrivalPushV1,
	providerEntryOf,
	selectArrivalPushTargets,
	type ArrivalPushCandidate,
	type ArrivalPushConfig,
	type ArrivalPushResult,
	type ArrivalPushV1,
	type LocalSeekerRegistration,
	type ProviderEntryV1,
	type RegistrationRecord,
	type SlotAssigner,
} from "@optimystic/db-core";
import type { CoordEngine } from "../cohort-topic/host.js";
import { peerIdToBytes } from "../cohort-topic/peer-codec.js";
import { createLogger } from "../logger.js";
import { armUnrefTimer } from "../unref-timer.js";
import { decodeLocalRegistration, type LocalMatchRegistration } from "./local-registration.js";

const defaultLog = createLogger("matchmaking:arrival-push");

type Log = (formatter: string, ...args: unknown[]) => void;

/** Default cap on bindings held across the node. */
export const DEFAULT_ARRIVAL_PUSH_MAX_BINDINGS = 4096;

/** The parts of a cohort engine the driver reads. */
export type ArrivalPushEngine = Pick<CoordEngine, "servedCoord" | "cohort" | "records" | "heldRecord" | "topicTraffic">;

/** Everything an {@link ArrivalPushDriver} needs, all injected. */
export interface ArrivalPushDriverDeps {
	/** This node's peer-id string, compared with each selected seeker's slot primary. */
	readonly selfPeerId: string;
	/** The slot rule (`createSlotAssigner(createRingHash())`) — the same one registration renewal uses. */
	readonly slots: SlotAssigner;
	/** Sign a push's canonical image with this node's peer key; resolves the base64url signature. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** Deliver one encoded {@link ArrivalPushV1} to the seeker named by `contactHint`; resolves the ack frame, or `undefined` on no reply / failure. */
	readonly send: (contactHint: string, frame: Uint8Array) => Promise<Uint8Array | undefined>;
	/** Coalescing window; default {@link DEFAULT_ARRIVAL_PUSH_CONFIG}. */
	readonly config?: ArrivalPushConfig;
	/** Arm a one-shot timer, returning its cancel; default `setTimeout`, unref'd so it never holds a process open. */
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
	/** Cap on bindings held across the node; default {@link DEFAULT_ARRIVAL_PUSH_MAX_BINDINGS}. */
	readonly maxBindings?: number;
	/** Logger for dropped pushes and skipped records; default the `matchmaking:arrival-push` debug namespace. */
	readonly log?: Log;
}

/** A push-opted seeker the engine holds, ready for selection and binding. */
interface PushOptedSeeker extends ArrivalPushCandidate {
	/** The record's participant id bytes — the slot rule's input. */
	readonly participantBytes: Uint8Array;
	readonly correlationId: string;
	readonly bindingKey: string;
}

/** One seeker registration this node pushes to. Soft, local state; never gossiped. */
interface Binding {
	readonly key: string;
	readonly scopeKey: string;
	readonly topicId: Uint8Array;
	readonly seekerBytes: Uint8Array;
	readonly correlationId: string;
	readonly contactHint: string;
	readonly wantCount: number;
	/** The engine that last queued to this binding; read at flush for the epoch, traffic and held record. */
	engine: ArrivalPushEngine;
	/** Provider participant ids queued or delivered under this binding. Its size against `wantCount` is the outstanding need. */
	readonly pushed: Set<string>;
	batch: ProviderEntryV1[];
	cancelTimer?: () => void;
	/** The seeker answered `unknown_seeker`: this registration is not its current one. */
	dead: boolean;
}

/**
 * Cohort-side arrival push: subscribe {@link onRecordAdded} to the host, and {@link stop} on teardown.
 */
export class ArrivalPushDriver {
	private readonly selfBytes: Uint8Array;
	private readonly coalesceMs: number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	private readonly log: Log;
	private readonly bindings: BindingTable;
	/**
	 * Decoded registrations by record object. Each provider arrival reads every record of its topic, and a
	 * member catching up on a topic receives its records one at a time, so without this a catch-up would
	 * re-parse the whole topic per record. Every store write puts a new record object rather than changing a
	 * held one, so an entry is never stale.
	 */
	private readonly decoded = new WeakMap<RegistrationRecord, LocalMatchRegistration>();
	private stopped = false;

	constructor(private readonly deps: ArrivalPushDriverDeps) {
		this.selfBytes = peerIdToBytes(deps.selfPeerId);
		this.coalesceMs = (deps.config ?? DEFAULT_ARRIVAL_PUSH_CONFIG).coalesceMs;
		this.setTimer = deps.setTimer ?? armUnrefTimer;
		this.log = deps.log ?? defaultLog;
		this.bindings = new BindingTable(deps.maxBindings ?? DEFAULT_ARRIVAL_PUSH_MAX_BINDINGS);
	}

	/** The host listener: a record became present on `engine`. A property, so it can be passed unbound. */
	readonly onRecordAdded = (engine: ArrivalPushEngine, rec: RegistrationRecord): void => {
		if (this.stopped) {
			return;
		}
		// Every application's records on this node arrive here (reactivity's among them), so a record that is
		// not a matchmaking provider is the common case, not a fault, and is not logged. A malformed record in a
		// matchmaking topic is logged where that topic is read: the seeker pass below, and the query handler.
		const arrived = this.decode(rec, undefined);
		if (arrived?.role !== "provider") {
			return;
		}
		// NOTE: bindings are scoped per engine, so while a moved root leaves two of this node's engines holding one
		// seeker, an arrival reaching both pushes it twice (the seeker dedups by participantId). If that window ever
		// shows up as duplicate-push load, key bindings by (topicId, seeker, correlationId) alone.
		const scopeKey = `${bytesToB64url(engine.servedCoord)}|${bytesToB64url(rec.topicId)}`;
		const seekers = this.pushOptedSeekers(engine, rec.topicId, scopeKey);
		this.dropUnheldBindings(scopeKey, seekers);
		const targets = selectArrivalPushTargets(arrived.registration, seekers);
		if (targets.length === 0) {
			return;
		}
		const { members, cohortEpoch } = engine.cohort();
		const entry = providerEntryOf(arrived.registration);
		for (const seeker of targets) {
			if (bytesEqual(this.deps.slots.assignSlots(seeker.participantBytes, cohortEpoch, members).primary, this.selfBytes)) {
				this.enqueue(this.bindingFor(engine, rec.topicId, scopeKey, seeker), entry);
			}
		}
	};

	/** Cancel every timer and drop all state. Pushes already in flight complete; their acks change nothing. */
	stop(): void {
		this.stopped = true;
		this.bindings.clear();
	}

	private decode(rec: RegistrationRecord, log: Log | undefined): LocalMatchRegistration | undefined {
		const cached = this.decoded.get(rec);
		if (cached !== undefined) {
			return cached;
		}
		const decoded = decodeLocalRegistration(rec, log);
		if (decoded !== undefined) {
			this.decoded.set(rec, decoded);
		}
		return decoded;
	}

	/**
	 * The push-opted seekers `engine` holds for `topicId`.
	 * NOTE: lists the whole topic per provider arrival (the cost a query pays per query; decoding is cached).
	 * Bounded by the `cap_promote` participant ceiling; if arrival bursts ever show this in profiles, keep a
	 * per-topic push-opted seeker index updated from the same record-added and eviction signals.
	 */
	private pushOptedSeekers(engine: ArrivalPushEngine, topicId: Uint8Array, scopeKey: string): PushOptedSeeker[] {
		const seekers: PushOptedSeeker[] = [];
		for (const rec of engine.records(topicId)) {
			const decoded = this.decode(rec, this.log);
			if (decoded?.role !== "seeker") {
				continue;
			}
			const correlationId = pushCorrelationId(decoded.registration);
			if (correlationId !== undefined) {
				seekers.push({
					...decoded.registration,
					participantBytes: rec.participantId,
					correlationId,
					bindingKey: `${scopeKey}|${decoded.registration.participantId}|${correlationId}`,
				});
			}
		}
		return seekers;
	}

	/** Drop this scope's bindings whose seeker record is gone, or now carries another registration (it re-registered). */
	private dropUnheldBindings(scopeKey: string, seekers: readonly PushOptedSeeker[]): void {
		const held = new Set(seekers.map((s) => s.bindingKey));
		for (const binding of this.bindings.inScope(scopeKey)) {
			if (!held.has(binding.key)) {
				this.bindings.remove(binding);
			}
		}
	}

	private bindingFor(engine: ArrivalPushEngine, topicId: Uint8Array, scopeKey: string, seeker: PushOptedSeeker): Binding {
		const binding = this.bindings.touch(seeker.bindingKey) ?? this.bindings.add({
			key: seeker.bindingKey,
			scopeKey,
			topicId,
			seekerBytes: seeker.participantBytes,
			correlationId: seeker.correlationId,
			contactHint: seeker.payload.contactHint,
			wantCount: seeker.payload.wantCount,
			engine,
			pushed: new Set<string>(),
			batch: [],
			dead: false,
		});
		binding.engine = engine;
		return binding;
	}

	private enqueue(binding: Binding, entry: ProviderEntryV1): void {
		if (binding.dead || binding.pushed.size >= binding.wantCount || binding.pushed.has(entry.participantId)) {
			return;
		}
		binding.pushed.add(entry.participantId);
		binding.batch.push(entry);
		// The batch now covers the seeker's whole remaining need, or is as large as one push may be: no reason to wait.
		if (binding.pushed.size >= binding.wantCount || binding.batch.length >= QUERY_LIMIT_MAX) {
			this.flush(binding);
			return;
		}
		binding.cancelTimer ??= this.setTimer(() => {
			binding.cancelTimer = undefined;
			this.flush(binding);
		}, this.coalesceMs);
	}

	/** Send the queued batch. The batch is cleared first, so a later arrival starts a new one (a concurrent flush is allowed). */
	private flush(binding: Binding): void {
		stopTimer(binding);
		const providers = binding.batch;
		binding.batch = [];
		if (providers.length === 0 || binding.dead) {
			return;
		}
		// The engine may have lost the seeker since the batch was queued (expiry, withdrawal, re-registration, eviction).
		if (!this.stillHolds(binding)) {
			this.bindings.remove(binding);
			return;
		}
		void this.deliver(binding, providers);
	}

	private stillHolds(binding: Binding): boolean {
		const rec = binding.engine.heldRecord(binding.topicId, binding.seekerBytes);
		const decoded = rec === undefined ? undefined : this.decode(rec, this.log);
		return decoded?.role === "seeker" && pushCorrelationId(decoded.registration) === binding.correlationId;
	}

	/**
	 * Sign, send, and act on the ack. A failure of any step drops the batch with no retry or replay: the push
	 * is advisory, and the seeker's safety poll recovers what is missed. The dropped providers leave `pushed`,
	 * since they were not delivered — otherwise a lost push covering the seeker's whole need would leave the
	 * binding satisfied, and no later arrival would be pushed to it.
	 */
	private async deliver(binding: Binding, providers: ProviderEntryV1[]): Promise<void> {
		let reply: Uint8Array | undefined;
		try {
			reply = await this.deps.send(binding.contactHint, await this.buildPush(binding, providers));
		} catch (err) {
			this.dropBatch(binding, providers, "sign or send failed", err);
			return;
		}
		if (reply === undefined) {
			this.dropBatch(binding, providers, "no reply", undefined);
			return;
		}
		let result: ArrivalPushResult;
		try {
			result = decodeArrivalPushAckV1(reply).result;
		} catch (err) {
			this.dropBatch(binding, providers, "undecodable ack", err);
			return;
		}
		if (result === "unknown_seeker") {
			// This registration is not the seeker's current one. A re-registration carries a new correlation id,
			// so it gets a new binding; this one stays, dead, so no further arrival is pushed under it.
			binding.dead = true;
			binding.batch = [];
			stopTimer(binding);
		}
	}

	private async buildPush(binding: Binding, providers: ProviderEntryV1[]): Promise<Uint8Array> {
		const unsigned: Omit<ArrivalPushV1, "signature"> = {
			v: 1,
			topicId: bytesToB64url(binding.topicId),
			cohortEpoch: bytesToB64url(binding.engine.cohort().cohortEpoch),
			correlationId: binding.correlationId,
			providers,
			topicTraffic: binding.engine.topicTraffic(binding.topicId),
		};
		const signature = await this.deps.sign(arrivalPushSigningPayload(unsigned));
		return encodeArrivalPushV1({ ...unsigned, signature });
	}

	private dropBatch(binding: Binding, providers: readonly ProviderEntryV1[], why: string, err: unknown): void {
		this.log("arrival push to %s dropped (%s), %d provider(s): %o", binding.contactHint, why, providers.length, err);
		for (const p of providers) {
			binding.pushed.delete(p.participantId);
		}
	}
}

/** The seeker registration's push binding id, or `undefined` when it did not opt into pushes. */
function pushCorrelationId(seeker: LocalSeekerRegistration): string | undefined {
	return seeker.payload.pushOnArrival === true ? seeker.payload.correlationId : undefined;
}

function stopTimer(binding: Binding): void {
	binding.cancelTimer?.();
	binding.cancelTimer = undefined;
}

/**
 * The node's bindings, capped, with least-recently-touched eviction, and indexed by `(servedCoord, topicId)`
 * scope for the per-arrival cleanup. Map insertion order is the recency order: a touch re-inserts.
 */
class BindingTable {
	private readonly byKey = new Map<string, Binding>();
	private readonly byScope = new Map<string, Set<Binding>>();

	constructor(private readonly max: number) {
		if (!Number.isInteger(max) || max < 1) {
			throw new RangeError(`arrival push: maxBindings must be an integer >= 1, got ${max}`);
		}
	}

	/** The binding for `key`, now the most recently touched; `undefined` if none. */
	touch(key: string): Binding | undefined {
		const binding = this.byKey.get(key);
		if (binding !== undefined) {
			this.byKey.delete(key);
			this.byKey.set(key, binding);
		}
		return binding;
	}

	add(binding: Binding): Binding {
		this.byKey.set(binding.key, binding);
		let scope = this.byScope.get(binding.scopeKey);
		if (scope === undefined) {
			scope = new Set<Binding>();
			this.byScope.set(binding.scopeKey, scope);
		}
		scope.add(binding);
		// NOTE: the cap is a fixed count, not derived from load. If pushes are ever measured missing under load
		// (bindings evicted while their seekers still wait), size it from `cap_promote` × the coord engine budget
		// — the most push-opted seekers this node can be primary for — instead.
		if (this.byKey.size > this.max) {
			const oldest = this.byKey.values().next().value;
			if (oldest !== undefined) {
				this.remove(oldest);
			}
		}
		return binding;
	}

	remove(binding: Binding): void {
		if (this.byKey.get(binding.key) !== binding) {
			return;
		}
		this.byKey.delete(binding.key);
		const scope = this.byScope.get(binding.scopeKey);
		scope?.delete(binding);
		if (scope?.size === 0) {
			this.byScope.delete(binding.scopeKey);
		}
		stopTimer(binding);
	}

	/** A snapshot of the bindings in `scopeKey`, safe to remove from while iterating. */
	inScope(scopeKey: string): readonly Binding[] {
		return [...(this.byScope.get(scopeKey) ?? [])];
	}

	clear(): void {
		for (const binding of this.byKey.values()) {
			stopTimer(binding);
		}
		this.byKey.clear();
		this.byScope.clear();
	}
}
