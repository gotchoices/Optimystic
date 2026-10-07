/**
 * Cohort-topic substrate — participant-side bootstrap-evidence builder (db-p2p side of the `buildBootstrapEvidence` seam).
 *
 * Implements the db-core `CohortTopicServiceDeps.buildBootstrapEvidence` seam for the node's participant
 * role: on a cold-start re-issue — `bootstrap: true` at a root, `followOn: true` at a deeper tier — the
 * service calls this with the register's own canonical `(topicId, tier, participantCoord, timestamp)` tuple
 * (base64url wire strings) and attaches the returned bytes — **before** signing — into
 * `RegisterV1.bootstrapEvidence`.
 *
 * - **Tier ≤ maxNoPowTier (T0/T1):** no evidence. The serving group's policy accepts only a signed parent
 *   reference there, which this builder does not mint (a brand-new root has no parent to reference; the
 *   richer committed-parent check is the follow-on `cohort-topic-parent-ref-tx-log-content`). Anything
 *   else offered at these tiers would be bytes no verifier reads.
 * - **Tier ≥ maxNoPowTier+1 (T2/T3), with `endorse` (a node with a peer key):** a *self-endorsement* — the
 *   node signs the bound image with its own key and names itself the referee. One signature, which the
 *   serving group's reputation verifier admits for any key it has not banned or deprioritized. This is the
 *   evidence a key-ful node offers; it costs a phone what it costs a desktop.
 * - **Tier ≥ maxNoPowTier+1 (T2/T3), without `endorse` (a participant with no key):** mint a proof-of-work —
 *   search nonces until `meetsDifficulty(hash.H(powPreimage(reg, nonce)), bits)`. The search takes a geometrically
 *   distributed number of tries around `2^bits` (default 20 ≈ 1 M). One try costs about 1.2 µs on a
 *   desktop under Node 24 (one SHA-256 of a ~180-byte preimage), so a default mint averages about 1.2 s of
 *   hashing there and a slow one takes several times that; on Hermes (React Native), which runs the hash as
 *   un-JITted JavaScript, it is far slower. So the search **yields** to the event loop every
 *   {@link POW_SLICE_MS}, letting timers and sockets run, and **gives up** — returning `undefined`, as
 *   the iteration cap ({@link DEFAULT_POW_MAX_ITERATIONS}) also does — once it has run for
 *   `timeBudgetMs`, because the register's `timestamp` is inside the hashed preimage and the serving
 *   group refuses a register older than its replay window: a later answer would be refused anyway.
 *
 * Returns the **raw** envelope JSON bytes (`utf8(JSON.stringify(env))`), NOT the already-base64url string
 * from `serializeBootstrapEvidenceEnvelope` — the service base64url-encodes them itself (returning the
 * serialized string's bytes would double-encode the field). We obtain the raw bytes by decoding the
 * canonical serializer output once, so the byte layout matches exactly what a verifier reconstructs.
 */

import {
	serializeBootstrapEvidenceEnvelope,
	bootstrapBoundImage,
	powPreimage,
	meetsDifficulty,
	DEFAULT_POW_DIFFICULTY_BITS,
	DEFAULT_MAX_NO_POW_TIER,
	DEFAULT_REPLAY_MAX_AGE_MS,
	bytesToB64url,
	b64urlToBytes,
	type IRingHash,
	type BootstrapBoundFields,
	type BootstrapEvidenceEnvelopeV1,
	type ReputationEvidenceV1,
} from "@optimystic/db-core";
import { randomBytes } from "@libp2p/crypto";
import { createLogger } from "../logger.js";

const log = createLogger("cohort-topic");

/**
 * Defensive cap on the PoW nonce search (~16.7 M hashes). Comfortably above the ~`2^bits` expected for
 * the default 20-bit difficulty (~1 M), so a real miner solves long before the cap; hitting it (a
 * mis-set, very-high `bits`) returns `undefined` rather than searching on. Values above `2^32` are
 * clamped to it, the most nonces the 4-byte counter can name.
 */
export const DEFAULT_POW_MAX_ITERATIONS = 1 << 24;

/**
 * How long one synchronous stretch of the nonce search runs before it yields with a `setTimeout(0)`.
 * A yield costs about 15 ms under Node on Windows (its timer granularity), about 4 ms in a browser once
 * timeouts nest, and about 1 ms under Node elsewhere, so 50 ms keeps that overhead under a quarter of the
 * mint's wall-clock time at worst (measured 23% on Windows) while no stretch blocks the thread for longer.
 */
export const POW_SLICE_MS = 50;

/**
 * Tries between clock reads. A read is a few tens of nanoseconds against about 300 µs of hashing per
 * stride on a desktop, and a stride stays well under {@link POW_SLICE_MS} even where a try is tens of
 * times slower (Hermes), so a slice overruns its length by at most one stride.
 */
const POW_CLOCK_STRIDE = 256;

/** The serving group's replay window, halved: the other half is left for the register to travel and be checked. */
export function powTimeBudgetFor(replayMaxAgeMs: number): number {
	return replayMaxAgeMs / 2;
}

/** Default {@link BootstrapEvidenceBuilderDeps.timeBudgetMs}: half the default replay window (30 s). */
export const DEFAULT_POW_TIME_BUDGET_MS = powTimeBudgetFor(DEFAULT_REPLAY_MAX_AGE_MS);

/** Nonce layout: a random prefix drawn once per mint, then a big-endian try counter in the low bytes. */
const NONCE_BYTES = 16;
const COUNTER_BYTES = 4;
const MAX_COUNTER_TRIES = 2 ** (8 * COUNTER_BYTES);

/** The bound tuple the service hands the builder — the same shape a verifier binds via {@link bootstrapBoundImage}. */
export type BootstrapEvidenceBuildParams = BootstrapBoundFields;

/** Inputs to {@link createBootstrapEvidenceBuilder}. */
export interface BootstrapEvidenceBuilderDeps {
	/** The node's ring hash (SHA-256) — the same `H` the PoW verifier checks against. */
	readonly hash: IRingHash;
	/** Difficulty bits to mint at. Default {@link DEFAULT_POW_DIFFICULTY_BITS}. `0` solves on the first nonce (test). */
	readonly bits?: number;
	/** Highest tier the builder offers no evidence at — the policy's PoW-exempt tiers (T0/T1 → 1). Default {@link DEFAULT_MAX_NO_POW_TIER}. */
	readonly maxNoPowTier?: number;
	/** Nonce-search cap. Default {@link DEFAULT_POW_MAX_ITERATIONS}. */
	readonly maxIterations?: number;
	/**
	 * How long a PoW search may run, in milliseconds, before it gives up and the register goes without
	 * evidence. Measured from the call, not from the bound `timestamp`: the service stamps the timestamp
	 * synchronously just before calling, and from its own clock, which a test may have replaced — so the
	 * two starts coincide in production, and only the call is on this builder's clock. Keep it below the
	 * serving group's replay window ({@link powTimeBudgetFor}). Default {@link DEFAULT_POW_TIME_BUDGET_MS}.
	 */
	readonly timeBudgetMs?: number;
	/**
	 * Self-endorsement capability for a node with a peer key: signs the bound image with that key and returns
	 * the referee (= self) and the signature. Supplied → the endorsement is the evidence at every tier whose
	 * policy accepts one (T2/T3), and no proof-of-work is searched for. Absent → T2/T3 pays a proof-of-work,
	 * the evidence a participant with no key can offer.
	 */
	readonly endorse?: (boundImage: Uint8Array) => Promise<ReputationEvidenceV1>;
}

/**
 * Build the {@link import("@optimystic/db-core").CohortTopicServiceDeps.buildBootstrapEvidence} seam:
 * a `(params) => Promise<Uint8Array | undefined>` that mints the cold-start evidence for the node's own
 * register. Nothing at T0/T1; at T2/T3 a self-endorsement when `endorse` is supplied, else a proof-of-work.
 * A PoW search yields to the event loop every {@link POW_SLICE_MS} and ends at the iteration cap or the
 * time budget, whichever comes first.
 */
export function createBootstrapEvidenceBuilder(
	deps: BootstrapEvidenceBuilderDeps,
): (params: BootstrapEvidenceBuildParams) => Promise<Uint8Array | undefined> {
	const maxNoPowTier = deps.maxNoPowTier ?? DEFAULT_MAX_NO_POW_TIER;
	const limits: PowSearchLimits = {
		bits: deps.bits ?? DEFAULT_POW_DIFFICULTY_BITS,
		maxTries: Math.min(deps.maxIterations ?? DEFAULT_POW_MAX_ITERATIONS, MAX_COUNTER_TRIES),
		timeBudgetMs: deps.timeBudgetMs ?? DEFAULT_POW_TIME_BUDGET_MS,
	};

	return async (params: BootstrapEvidenceBuildParams): Promise<Uint8Array | undefined> => {
		const bound: BootstrapBoundFields = {
			topicId: params.topicId,
			tier: params.tier,
			participantCoord: params.participantCoord,
			timestamp: params.timestamp,
		};

		if (params.tier <= maxNoPowTier) {
			return undefined;
		}

		if (deps.endorse !== undefined) {
			// NOTE: a serving group whose reputation view has this key banned, or at/above its deprioritize
			// threshold, refuses the endorsement, and there is no proof-of-work fallback — the register reply is
			// a generic `unwilling_cohort`, so this participant cannot tell an evidence refusal from any other.
			// That is the reputation subsystem doing its job for a misbehaving key; if honest-but-penalized keys
			// (a flaky phone accumulating timeouts) are seen to lose their watches in practice, carry a
			// proof-of-work alongside the endorsement once a key is known to be refused, or have the register
			// reply name an evidence refusal so the participant can retry with one.
			const reputation = await deps.endorse(bootstrapBoundImage(bound));
			return rawEnvelopeBytes({ v: 1, reputation });
		}

		// No key: mint a proof-of-work. Without one a configured cohort denies the register.
		const nonce = await searchPowNonce(new PowCandidate(deps.hash, bound), limits);
		return nonce === undefined ? undefined : rawEnvelopeBytes({ v: 1, pow: { nonce: bytesToB64url(nonce) } });
	};
}

/** When a PoW search stops looking. */
interface PowSearchLimits {
	readonly bits: number;
	/** Already clamped to what the counter can name. */
	readonly maxTries: number;
	readonly timeBudgetMs: number;
}

/**
 * The PoW preimage for one mint, built once: `powPreimage(bound, nonce)` with a random 16-byte nonce
 * whose low {@link COUNTER_BYTES} bytes are overwritten in place by each try's counter. Rebuilding the
 * preimage and drawing a fresh random nonce per try cost about twice the hash itself. The nonce needs no
 * per-try randomness: the bound fields already make each mint's search space its own, and the random
 * prefix keeps two mints of the same fields from retracing each other's nonces.
 *
 * NOTE: the bound image runs past 128 bytes, so the first two of the preimage's three SHA-256 blocks
 * never change within a mint, and hashing from a saved mid-state would cut a try to about a third of its
 * cost. `IRingHash` offers only a one-shot `H`; if mint time on phones stays the binding cost, add a
 * prefix-state hash to the port.
 */
class PowCandidate {
	private readonly preimage: Uint8Array;
	private readonly counterView: DataView;

	constructor(private readonly hash: IRingHash, bound: BootstrapBoundFields) {
		this.preimage = powPreimage(bound, randomBytes(NONCE_BYTES));
		const counterOffset = this.preimage.byteOffset + this.preimage.length - COUNTER_BYTES;
		this.counterView = new DataView(this.preimage.buffer, counterOffset, COUNTER_BYTES);
	}

	/** Try counters `[from, to)` in order; true once one meets `bits`, leaving it written into the nonce. */
	solveWithin(from: number, to: number, bits: number): boolean {
		for (let counter = from; counter < to; counter++) {
			this.counterView.setUint32(0, counter);
			if (meetsDifficulty(this.hash.H(this.preimage), bits)) {
				return true;
			}
		}
		return false;
	}

	/** A copy of the nonce region as it stands — call right after a solving try, since the buffer is reused. */
	nonce(): Uint8Array {
		return this.preimage.slice(this.preimage.length - NONCE_BYTES);
	}
}

/**
 * Search counters in strides of {@link POW_CLOCK_STRIDE}, reading the clock between strides to yield
 * once a slice has run for {@link POW_SLICE_MS} and to give up once the time budget is spent.
 *
 * NOTE: concurrent mints interleave and share the CPU while each budget runs on the wall clock, so N
 * cold starts at once each get about 1/N of it and can all give up where run one after another the
 * first few would finish; if a slow device ever cold-starts many topics together, queue mints per
 * builder (a queued mint's budget already counts its wait, which is right: its timestamp ages too).
 * NOTE: nothing cancels a mint — a node stopped mid-search keeps searching, yielding, until it solves
 * or the budget ends; if shutdown latency matters, thread an `AbortSignal` from the service's register builder.
 */
async function searchPowNonce(candidate: PowCandidate, limits: PowSearchLimits): Promise<Uint8Array | undefined> {
	const startedAt = Date.now();
	let sliceStartedAt = startedAt;
	for (let from = 0; from < limits.maxTries; from += POW_CLOCK_STRIDE) {
		const to = Math.min(from + POW_CLOCK_STRIDE, limits.maxTries);
		if (candidate.solveWithin(from, to, limits.bits)) {
			return candidate.nonce();
		}
		const now = Date.now();
		if (now - startedAt >= limits.timeBudgetMs) {
			return giveUp("time budget spent", now - startedAt, to, limits);
		}
		if (now - sliceStartedAt >= POW_SLICE_MS) {
			await yieldToEventLoop();
			sliceStartedAt = Date.now();
		}
	}
	return giveUp("iteration cap reached", Date.now() - startedAt, limits.maxTries, limits);
}

/** One line per abandoned mint: on a slow device it is what explains a cold start that keeps being refused. */
function giveUp(reason: string, elapsedMs: number, tries: number, limits: PowSearchLimits): undefined {
	log(
		"cohort-topic: proof-of-work mint abandoned (%s) after %d ms and %d tries at %d bits — the register goes without evidence, which a configured cohort refuses",
		reason, elapsedMs, tries, limits.bits,
	);
	return undefined;
}

/**
 * A macrotask yield. Not a resolved promise (a microtask lets no timer or socket callback in) and not
 * `setImmediate` (on React Native it runs inside the same JS batch, so native events still wait).
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * The raw envelope JSON bytes the service expects (`utf8(JSON.stringify(env))`). Reuses the db-core
 * canonical serializer (fixed field order, deterministic JSON) and decodes its base64url output back to
 * the underlying bytes — so the layout is byte-identical to what a verifier reconstructs, with zero
 * duplicated canonicalization here.
 */
function rawEnvelopeBytes(env: BootstrapEvidenceEnvelopeV1): Uint8Array {
	return b64urlToBytes(serializeBootstrapEvidenceEnvelope(env));
}
