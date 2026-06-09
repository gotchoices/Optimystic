/**
 * Matchmaking — seeker manager (db-p2p, wires to the cohort-topic substrate).
 *
 * Registers a db-core {@link MatchmakingSeeker} at cohort-topic tier **T2 (functional)** with a short
 * TTL (`seeker_ttl`, default 10 s — `docs/matchmaking.md` §Seeker query). The seeker registers
 * **briefly** so other seekers can find it (collective assembly) and the cohort sees active demand.
 *
 * By design this manager does **not** renew by default: the cohort-topic service does not auto-ping
 * (renewal is caller-driven), so simply not calling renew lets the registration age out by TTL. This
 * makes seeker TTL eviction directly observable — the property this ticket proves. The `QueryV1`
 * issuance, filter evaluation, and hang-out decision (which would keep a hanging-out seeker's
 * registration alive via renewals) land in `matchmaking-query-filter-hangout`.
 */

import { Tier, SEEKER_TTL_MS, type CohortTopicService, type MatchmakingSeeker, type RegistrationHandle } from "@optimystic/db-core";

/** Construction inputs for a {@link MatchmakingSeekerManager}. */
export interface MatchmakingSeekerManagerOptions {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/** The seeker state/decision object this manager registers. */
	readonly seeker: MatchmakingSeeker;
	/** Seeker TTL (ms). Default {@link SEEKER_TTL_MS} (10 s). */
	readonly ttlMs?: number;
}

/** Wires one matchmaking seeker's brief registration to the cohort-topic substrate at tier T2. */
export class MatchmakingSeekerManager {
	private readonly service: CohortTopicService;
	private readonly seeker: MatchmakingSeeker;
	private readonly ttlMs: number;
	private handle?: RegistrationHandle;

	constructor(options: MatchmakingSeekerManagerOptions) {
		this.service = options.service;
		this.seeker = options.seeker;
		this.ttlMs = options.ttlMs ?? SEEKER_TTL_MS;
	}

	/** The live registration handle, or `undefined` before {@link register}. */
	get registration(): RegistrationHandle | undefined {
		return this.handle;
	}

	/** Register the seeker briefly at tier T2 with the short seeker TTL; no renewal is started. */
	async register(): Promise<RegistrationHandle> {
		const appPayload = await this.seeker.appPayloadBytes();
		this.handle = await this.service.register({
			topicId: this.seeker.topicId,
			tier: Tier.T2,
			appPayload,
			ttl: this.ttlMs,
		});
		return this.handle;
	}

	/** Drop the seeker registration (stop any renewal); the cohort soft-state TTL-expires. */
	async withdraw(): Promise<void> {
		if (this.handle !== undefined) {
			await this.service.withdraw(this.handle);
		}
	}
}
