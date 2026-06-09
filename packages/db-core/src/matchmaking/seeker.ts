/**
 * Matchmaking — seeker registration (db-core, transport-agnostic).
 *
 * This ticket lands **registration only**. A {@link MatchmakingSeeker} owns the short-lived seeker
 * state for one topic and builds the signed {@link SeekerAppPayloadV1} that the db-p2p
 * `seeker-manager` registers at cohort-topic tier **T2** with a short TTL (`seeker_ttl`, default 10 s
 * — `docs/matchmaking.md` §Seeker query). The seeker registers briefly so other seekers can find it
 * (collective assembly) and the cohort sees active demand.
 *
 * The query issuance, capability-filter evaluation, and hang-out-vs-continue decision are **deferred**
 * to `matchmaking-query-filter-hangout`; see the stub note on {@link MatchmakingSeeker.query}.
 *
 * Crypto-free: signing is an injected callback, matching {@link MatchmakingProvider}.
 */

import { randomBytes } from "@noble/hashes/utils.js";
import { seekerSigningPayload, type CapabilityFilter, type SeekerAppPayloadV1, encodeSeekerAppPayload } from "./wire.js";

/** Construction inputs for a {@link MatchmakingSeeker}. */
export interface MatchmakingSeekerOptions {
	/** The matchmaking topic this seeker is querying. */
	readonly topicId: Uint8Array;
	/** Number of providers desired (integer `>= 1`). */
	readonly wantCount: number;
	/** Multiaddr or PeerId-based callback (collective-assembly use). */
	readonly contactHint: string;
	/** Optional capability filter (evaluated cohort-side in the next ticket; carried here). */
	readonly filter?: CapabilityFilter;
	/** Opt into arrival pushes; default false (poll path). Consumed by the next ticket. */
	readonly pushOnArrival?: boolean;
	/** Sign the canonical registration image; resolves the base64url signature. */
	readonly sign: (payload: Uint8Array) => Promise<string>;
	/** 16-byte correlation binding the signature; default fresh CSPRNG bytes. */
	readonly correlationId?: Uint8Array;
	/** CSPRNG source (injectable for deterministic tests). Default `@noble/hashes` `randomBytes`. */
	readonly randomBytes?: (n: number) => Uint8Array;
}

/** Live seeker state + signed-payload builder for one matchmaking topic (registration only). */
export class MatchmakingSeeker {
	readonly topicId: Uint8Array;
	readonly correlationId: Uint8Array;
	private readonly wantCount: number;
	private readonly contactHint: string;
	private readonly filter?: CapabilityFilter;
	private readonly pushOnArrival?: boolean;
	private readonly sign: (payload: Uint8Array) => Promise<string>;

	constructor(options: MatchmakingSeekerOptions) {
		if (!Number.isInteger(options.wantCount) || options.wantCount < 1) {
			throw new RangeError(`matchmaking seeker: wantCount must be an integer >= 1, got ${options.wantCount}`);
		}
		this.topicId = options.topicId;
		this.wantCount = options.wantCount;
		this.contactHint = options.contactHint;
		this.filter = options.filter;
		this.pushOnArrival = options.pushOnArrival;
		this.sign = options.sign;
		const rand = options.randomBytes ?? randomBytes;
		this.correlationId = options.correlationId ?? rand(16);
	}

	/** Build the signed {@link SeekerAppPayloadV1} for this seeker's registration. */
	async buildAppPayload(): Promise<SeekerAppPayloadV1> {
		const signature = await this.sign(seekerSigningPayload(this.topicId, this.wantCount, this.correlationId));
		const payload: SeekerAppPayloadV1 = {
			kind: "match-seeker",
			wantCount: this.wantCount,
			contactHint: this.contactHint,
			signature,
		};
		if (this.filter !== undefined) {
			payload.filter = this.filter;
		}
		if (this.pushOnArrival !== undefined) {
			payload.pushOnArrival = this.pushOnArrival;
		}
		return payload;
	}

	/** Build the opaque bytes for the cohort-topic `RegisterV1.appPayload` slot. */
	async appPayloadBytes(): Promise<Uint8Array> {
		return encodeSeekerAppPayload(await this.buildAppPayload());
	}

	/**
	 * Issue a `QueryV1` and evaluate the hang-out-vs-continue decision.
	 *
	 * Implemented in `matchmaking-query-filter-hangout` — this ticket lands seeker *registration*
	 * only. The query protocol codecs ({@link import("./wire.js").encodeQueryV1}) and the
	 * `QueryReplyV1` decoder already live in `wire.ts` so the next ticket's consumer can be built
	 * against fixtures.
	 */
	query(): never {
		throw new Error("MatchmakingSeeker.query is implemented in matchmaking-query-filter-hangout");
	}
}
