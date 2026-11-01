import type { ActionId, Hlc, HlcClock, PendRequest } from "@optimystic/db-core";
import { LruMap, SkewLedger, isHlc } from "@optimystic/db-core";
import { createLogger } from "../logger.js";

const log = createLogger('storage-repo');

/** Default for `StorageRepoOptions.skewLogThresholdMs`: a pend whose HLC sits further than this from local time is logged as `hlc:skew`. */
export const DEFAULT_SKEW_LOG_THRESHOLD_MS = 1000;

/** How many actions a malformed-HLC report is remembered for, so a re-sent pend is not reported again. */
const MALFORMED_REPORTS_REMEMBERED = 256;

/**
 * What a storage repo does with the HLC each pend carries (`PendRequest.hlc`, docs/crdt-sync.md
 * §Migration Path, Stage 1). Every write a node holds for others passes through `StorageRepo.pend`
 * exactly once, whether this node applies a consensus record as a cohort member or coordinates the
 * write alone, so this is the one place a node observes the writes it stores.
 *
 * Two things happen, and neither ever refuses a pend:
 * - **Measured** on receipt, against the clock's wall time, into {@link skew}: the gap is recorded per
 *   issuing node and logged as `hlc:skew` past the threshold. A gap behind local time also counts the
 *   write's age — an offline-queue entry keeps the HLC it was minted with at enqueue, and a retry the
 *   one its first attempt minted — so only an ahead gap is evidence about a clock.
 * - **Observed** by the node's clock once the pend is stored, so the node never mints an HLC below a
 *   write it holds. A pend the repo refuses is not observed: the node does not build on it.
 *
 * A field without the shape of an HLC is ignored for both and logged once per action as
 * `hlc:malformed`; a pend with none (an older writer, or the re-send of a retained attempt) is ignored
 * silently.
 */
export class PendHlcIntake {
	readonly skew = new SkewLedger();
	private readonly malformedReported = new LruMap<ActionId, true>(MALFORMED_REPORTS_REMEMBERED);

	constructor(private readonly clock: HlcClock, private readonly skewLogThresholdMs: number) {
		if (!Number.isFinite(skewLogThresholdMs) || skewLogThresholdMs < 0) {
			throw new RangeError(`skewLogThresholdMs must be a finite number at or above 0, got ${skewLogThresholdMs}`);
		}
	}

	/** Measure the pend's HLC and return it for {@link stored}; `undefined` when it carries no well-formed one. */
	receive(request: PendRequest): Hlc | undefined {
		const hlc: unknown = request.hlc;
		if (hlc === undefined) return undefined;
		if (!isHlc(hlc)) {
			this.reportMalformed(request.actionId, hlc);
			return undefined;
		}
		this.measure(request.actionId, hlc);
		return hlc;
	}

	/** The pend carrying `hlc` was stored. */
	stored(hlc: Hlc): void {
		this.clock.observe(hlc);
	}

	private measure(actionId: ActionId, hlc: Hlc): void {
		const gapMs = hlc.wallMs - this.clock.localTime();
		const skew = this.skew.record(hlc.nodeId, gapMs);
		if (Math.abs(gapMs) > this.skewLogThresholdMs) {
			log('hlc:skew actionId=%s nodeId=%s gapMs=%d maxAheadMs=%d maxBehindMs=%d samples=%d',
				actionId, hlc.nodeId.substring(0, 12), gapMs, skew.maxAheadMs, skew.maxBehindMs, skew.samples);
		}
	}

	private reportMalformed(actionId: ActionId, value: unknown): void {
		if (this.malformedReported.has(actionId)) return;
		this.malformedReported.set(actionId, true);
		log('hlc:malformed actionId=%s value=%o', actionId, value);
	}
}
