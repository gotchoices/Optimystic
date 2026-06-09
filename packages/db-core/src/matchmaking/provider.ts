/**
 * Matchmaking — provider decision/state (db-core, transport-agnostic).
 *
 * A {@link MatchmakingProvider} owns the live provider state for one topic: its capability tags, its
 * current `capacityBudget`, and a correlation id (registration identity; not bound into the
 * matchmaking signature — see {@link providerSigningPayload} option (b)). It builds the
 * signed {@link ProviderAppPayloadV1} (and the opaque bytes for the cohort-topic
 * `RegisterV1.appPayload` slot) that the db-p2p `provider-manager` registers at cohort-topic tier
 * **T2** (`docs/matchmaking.md` §Provider registration).
 *
 * It is crypto-free: signing is an injected callback (db-p2p supplies the libp2p peer key), matching
 * the cohort-topic {@link import("../cohort-topic/service.js").ParticipantSigner} pattern.
 *
 * Self-throttling (`docs/matchmaking.md` §Provider self-throttling) is expressed here as state:
 * - **Signal full** — {@link MatchmakingProvider.signalFull} sets `capacityBudget = 0`; the provider
 *   stays listed as "available but at capacity". The manager re-registers to push the new payload
 *   (the cohort-topic `RenewV1` carries no `appPayload`, so a capacity change is a re-register, not a
 *   ping — see the implement handoff).
 * - **Withdraw** — {@link MatchmakingProvider.markWithdrawn} records intent; the manager stops
 *   renewing so the record ages out by TTL. Withdrawal is an **optimization, not a correctness
 *   requirement** (§Provider self-throttling, GROUNDING resolution): a non-withdrawn registration is
 *   bounded by TTL eviction.
 */

import { randomBytes } from "@noble/hashes/utils.js";
import { providerSigningPayload, type ProviderAppPayloadV1, encodeProviderAppPayload } from "./wire.js";

/** Construction inputs for a {@link MatchmakingProvider}. */
export interface MatchmakingProviderOptions {
	/** The matchmaking topic this provider serves (from {@link import("./topic-anchor.js").MatchTopicAnchor}). */
	readonly topicId: Uint8Array;
	/** Application-defined capability tags. */
	readonly capabilities: readonly string[];
	/** Initial concurrent-task budget (integer `>= 0`). */
	readonly capacityBudget: number;
	/** Multiaddr or PeerId-based callback. */
	readonly contactHint: string;
	/** Optional soft expiry hint (unix ms). */
	readonly serviceUntil?: number;
	/** Sign the canonical registration image; resolves the base64url signature. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** 16-byte registration correlation id (not signature-bound); default fresh CSPRNG bytes. */
	readonly correlationId?: Uint8Array;
	/** CSPRNG source (injectable for deterministic tests). Default `@noble/hashes` `randomBytes`. */
	readonly randomBytes?: (n: number) => Uint8Array;
}

/** Live provider state + signed-payload builder for one matchmaking topic. */
export class MatchmakingProvider {
	readonly topicId: Uint8Array;
	readonly correlationId: Uint8Array;
	private readonly capabilities: readonly string[];
	private readonly contactHint: string;
	private readonly serviceUntil?: number;
	private readonly sign: (payload: Uint8Array) => Promise<string>;
	private capacity: number;
	private withdrawnFlag = false;

	constructor(options: MatchmakingProviderOptions) {
		this.topicId = options.topicId;
		this.capabilities = [...options.capabilities];
		this.contactHint = options.contactHint;
		this.serviceUntil = options.serviceUntil;
		this.sign = options.sign;
		this.capacity = requireBudget(options.capacityBudget);
		const rand = options.randomBytes ?? randomBytes;
		this.correlationId = options.correlationId ?? rand(16);
	}

	/** Current concurrent-task budget; `0` means "listed but full". */
	get capacityBudget(): number {
		return this.capacity;
	}

	/** True once {@link markWithdrawn} has been called (the manager should stop renewing). */
	get withdrawn(): boolean {
		return this.withdrawnFlag;
	}

	/** Set the live budget (integer `>= 0`). The next built payload reflects it. */
	setCapacity(budget: number): void {
		this.capacity = requireBudget(budget);
	}

	/** Signal "available but at capacity" by setting `capacityBudget = 0` (§Provider self-throttling). */
	signalFull(): void {
		this.capacity = 0;
	}

	/** Record withdrawal intent; the manager stops renewing so the record TTL-expires (optimization). */
	markWithdrawn(): void {
		this.withdrawnFlag = true;
	}

	/** Build the signed {@link ProviderAppPayloadV1} reflecting the current capacity. */
	async buildAppPayload(): Promise<ProviderAppPayloadV1> {
		const signature = await this.sign(providerSigningPayload(this.topicId, this.capabilities, this.capacity));
		const payload: ProviderAppPayloadV1 = {
			kind: "match-provider",
			capabilities: [...this.capabilities],
			capacityBudget: this.capacity,
			contactHint: this.contactHint,
			signature,
		};
		if (this.serviceUntil !== undefined) {
			payload.serviceUntil = this.serviceUntil;
		}
		return payload;
	}

	/** Build the opaque bytes for the cohort-topic `RegisterV1.appPayload` slot. */
	async appPayloadBytes(): Promise<Uint8Array> {
		return encodeProviderAppPayload(await this.buildAppPayload());
	}
}

/** Validate a capacity budget is an integer `>= 0`. */
function requireBudget(budget: number): number {
	if (!Number.isInteger(budget) || budget < 0) {
		throw new RangeError(`matchmaking provider: capacityBudget must be an integer >= 0, got ${budget}`);
	}
	return budget;
}
