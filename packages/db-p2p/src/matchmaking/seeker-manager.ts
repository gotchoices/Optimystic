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
 *
 * A machine holds at most one registration per topic (`docs/matchmaking.md` §Overview), so a brief seeker
 * registration never displaces another of the machine's registrations there: {@link MatchmakingSeekerManager.register}
 * refuses with {@link TopicRegistrationHeldError}. The reverse is allowed — a provider registering over a brief
 * seeker registration displaces it (the offer wins), and this manager's handle then goes stale, so its withdraw
 * sends nothing (`CohortTopicService.withdraw`'s identity guard).
 */

import { Tier, SEEKER_TTL_MS, bytesEqual, type CohortTopicService, type MatchmakingSeeker, type RegistrationHandle } from "@optimystic/db-core";

/** Construction inputs for a {@link MatchmakingSeekerManager}. */
export interface MatchmakingSeekerManagerOptions {
	/** Participant-facing cohort-topic substrate API. */
	readonly service: CohortTopicService;
	/** The seeker state/decision object this manager registers. */
	readonly seeker: MatchmakingSeeker;
	/** Seeker TTL (ms). Default {@link SEEKER_TTL_MS} (10 s). */
	readonly ttlMs?: number;
	/**
	 * The brief registration this one replaces — the session's previous seeker registration, made by an earlier
	 * manager. While it is still the live registration for this seeker's topic, {@link MatchmakingSeekerManager.register}
	 * registers over it rather than refusing.
	 */
	readonly replaces?: RegistrationHandle;
}

/**
 * A seeker registration was refused because this machine already holds another registration for the topic (in
 * practice a provider's). A cohort keeps one record per machine per topic, so registering would replace it; a
 * walk of the topic looks without registering instead.
 */
export class TopicRegistrationHeldError extends Error {
	constructor(readonly topicId: Uint8Array) {
		super("matchmaking seeker: this machine already holds a registration for the topic, which a seeker registration would replace; walk the topic instead");
		this.name = "TopicRegistrationHeldError";
	}
}

/** Wires one matchmaking seeker's brief registration to the cohort-topic substrate at tier T2. */
export class MatchmakingSeekerManager {
	private readonly service: CohortTopicService;
	private readonly seeker: MatchmakingSeeker;
	private readonly ttlMs: number;
	private readonly replaces: RegistrationHandle | undefined;
	private handle?: RegistrationHandle;

	constructor(options: MatchmakingSeekerManagerOptions) {
		this.service = options.service;
		this.seeker = options.seeker;
		this.ttlMs = options.ttlMs ?? SEEKER_TTL_MS;
		this.replaces = options.replaces;
	}

	/** The live registration handle, or `undefined` before {@link register}. */
	get registration(): RegistrationHandle | undefined {
		return this.handle;
	}

	/**
	 * Register the seeker briefly at tier T2 with the short seeker TTL; no renewal is started. Throws
	 * {@link TopicRegistrationHeldError} when this machine holds a live registration for the topic other than this
	 * manager's own or the one it {@link MatchmakingSeekerManagerOptions.replaces}.
	 */
	async register(): Promise<RegistrationHandle> {
		const topicId = this.seeker.topicId;
		if (this.service.holds(topicId) && !this.holdsOwnRegistration()) {
			throw new TopicRegistrationHeldError(topicId);
		}
		const appPayload = await this.seeker.appPayloadBytes();
		this.handle = await this.service.register({
			topicId,
			tier: Tier.T2,
			appPayload,
			ttl: this.ttlMs,
		});
		return this.handle;
	}

	/** Drop the seeker registration: stop renewing and send a best-effort signed tombstone so the
	 * cohort frees the record immediately (TTL expiry is the fallback if the primary is unreachable). */
	async withdraw(): Promise<void> {
		if (this.handle !== undefined) {
			await this.service.withdraw(this.handle);
		}
	}

	/** Whether the live registration for the topic is this seeker's own (this manager's, or the one it replaces). */
	private holdsOwnRegistration(): boolean {
		const topicId = this.seeker.topicId;
		return [this.handle, this.replaces].some((own) =>
			own !== undefined && bytesEqual(own.topicId, topicId) && this.service.isLive(own));
	}
}
