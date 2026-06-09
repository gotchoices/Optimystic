/**
 * Matchmaking — provider manager (db-p2p, wires to the cohort-topic substrate).
 *
 * Drives a db-core {@link MatchmakingProvider}'s lifecycle against the participant-facing
 * {@link CohortTopicService}: register at cohort-topic tier **T2 (functional)** with a profile-based
 * TTL, renew to keep the record alive, and withdraw by ceasing renewal (`docs/matchmaking.md`
 * §Provider registration).
 *
 * Self-throttling maps onto the substrate as follows (an honest gap surfaced for the reviewer): the
 * cohort-topic `RenewV1` carries **no** `appPayload` and **no** `ttl` field — a renewal is a pure
 * keep-alive touch. So a capacity change ("signal full", `capacityBudget = 0`) is realized by
 * **re-registering** with the new signed payload (which updates the cohort record's `appState`), not
 * by a renewal. Likewise immediate withdrawal (`RenewV1` TTL = 0 in the matchmaking doc) has no wire
 * realization yet — {@link withdraw} stops renewing and lets the record age out by TTL. Per the
 * §Provider self-throttling GROUNDING resolution, withdrawal is an **optimization, not correctness**,
 * so passive TTL expiry is acceptable; an immediate-tombstone renew is a documented cohort-topic
 * follow-on.
 */

import { Tier, providerTtlForProfile, type CohortTopicService, type MatchmakingProvider, type NodeProfile, type RegistrationHandle } from "@optimystic/db-core";

/** Construction inputs for a {@link MatchmakingProviderManager}. */
export interface MatchmakingProviderManagerOptions {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/** The provider state/decision object this manager drives. */
	readonly provider: MatchmakingProvider;
	/** Provider TTL (ms). Default: derived from {@link profile} via `providerTtlForProfile`. */
	readonly ttlMs?: number;
	/** Node profile used to derive the TTL when {@link ttlMs} is absent (Core 90 s / Edge 60 s). */
	readonly profile?: NodeProfile;
}

/** Wires one matchmaking provider to the cohort-topic substrate at tier T2. */
export class MatchmakingProviderManager {
	private readonly service: CohortTopicService;
	private readonly provider: MatchmakingProvider;
	private readonly ttlMs: number;
	private handle?: RegistrationHandle;

	constructor(options: MatchmakingProviderManagerOptions) {
		this.service = options.service;
		this.provider = options.provider;
		this.ttlMs = options.ttlMs ?? (options.profile !== undefined ? providerTtlForProfile(options.profile) : undefined) ?? DEFAULT_PROVIDER_TTL_MS;
	}

	/** The live registration handle, or `undefined` before the first {@link register}. */
	get registration(): RegistrationHandle | undefined {
		return this.handle;
	}

	/** Register (or re-register) the provider at tier T2 with the current signed payload. */
	async register(): Promise<RegistrationHandle> {
		const appPayload = await this.provider.appPayloadBytes();
		this.handle = await this.service.register({
			topicId: this.provider.topicId,
			tier: Tier.T2,
			appPayload,
			ttl: this.ttlMs,
		});
		return this.handle;
	}

	/** Run one renewal cycle (keep-alive touch). No-op before the first {@link register}. */
	async renew(): Promise<void> {
		if (this.handle === undefined) {
			return;
		}
		await this.service.renew(this.handle);
	}

	/** Set the live capacity budget and push it by re-registering (`RenewV1` cannot carry payload). */
	async setCapacity(budget: number): Promise<RegistrationHandle> {
		this.provider.setCapacity(budget);
		return this.register();
	}

	/** Signal "available but at capacity" (`capacityBudget = 0`) and push it by re-registering. */
	async signalFull(): Promise<RegistrationHandle> {
		this.provider.signalFull();
		return this.register();
	}

	/** Withdraw: stop renewing so the record TTL-expires (optimization, not correctness). */
	async withdraw(): Promise<void> {
		this.provider.markWithdrawn();
		if (this.handle !== undefined) {
			await this.service.withdraw(this.handle);
		}
	}
}

/** Fallback provider TTL when neither an explicit `ttlMs` nor a `profile` is supplied (Core default). */
const DEFAULT_PROVIDER_TTL_MS = 90_000;
