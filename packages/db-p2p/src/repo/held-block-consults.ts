import type { BlockId } from "@optimystic/db-core";
import { MAX_CONSULT_BATCH_BLOCKS } from "../protocol-limits.js";
import type { ConsultRound } from "./consult-round.js";

/**
 * How many consult requests the held-block consults running behind reads may have put to each cohort
 * peer at once ({@link HeldBlockConsults}). A consult request is one sync-protocol stream to the peer.
 * A running pass is a seat in its read's {@link ConsultRound}, and the round sends each peer ONE
 * request per {@link MAX_CONSULT_BATCH_BLOCKS} (32) blocks it names, so a round of up to 32 blocks is
 * one request per peer however many of its passes run; a pass with no round asks each peer on a
 * request of its own. The sync protocol is registered under libp2p's defaults
 * (`registerProtocolHandler`: 32 inbound streams per connection on the answering peer, 64 outbound
 * here), so 16 leaves the answering peer half its inbound allowance for its other readers and for the
 * archive fetches that acquisition runs over the same protocol. A read naming one block takes one slot
 * per pass, so for unbatched reads — every read before batching, and still the common shape — the
 * bound is 16 passes, as it always was.
 *
 * Counting requests rather than passes is what lets one read naming many window-expired blocks — a
 * scan, or a batched tail read across collections — start a consult for every one of them. Counted
 * per block, such a read started the first 16 in `blockIds` order and deferred the rest, and since a
 * deferred block stays unstamped, the same trailing blocks were deferred by every such read and never
 * consulted at all.
 *
 * NOTE: a conservative bound, not a measured one. If `cluster-tx:read-repair-deferred` lines show
 * steadily under normal load, raise it. Do not queue the deferred blocks instead: a queued pass would
 * run outside its read's round and cost one request per block, undoing the batching.
 *
 * NOTE: the slots bound the CONSULT requests only. A pass that finds the cohort ahead goes on to an
 * acquisition, so a large round whose blocks are all behind can start many at once; in the common case
 * they reuse the archives the consult already returned (`ConsultedArchives`) and open no stream. If
 * acquisitions after a large round ever show stream-limit resets on the answering peer, bound
 * acquisitions separately.
 */
export const MAX_HELD_BLOCK_CONSULT_SLOTS = 16;

/** What {@link HeldBlockConsults.start} did with a pass. */
export type HeldBlockConsultStart =
	| { readonly kind: 'started' }
	/** The block's pass is already running; nothing started. */
	| { readonly kind: 'running' }
	/** Starting it would have exceeded the slots; nothing started. Carries the counts to log. */
	| { readonly kind: 'deferred'; readonly inFlight: number; readonly slotsInUse: number };

/** Requests per peer that `passes` seats of one round need: one per chunk the round sends. */
function chunksFor(passes: number): number {
	return Math.ceil(passes / MAX_CONSULT_BATCH_BLOCKS);
}

/**
 * The consults running behind reads that were served from the local copy
 * (`CoordinatorRepo.startHeldBlockConsult`): at most one per block, and as many as fit in
 * {@link MAX_HELD_BLOCK_CONSULT_SLOTS} request slots. A round with `n` running passes occupies
 * `ceil(n / 32)` slots, and a pass with no round occupies one by itself. A pass keeps its round's
 * share until it ends, including any acquisition it runs after its round's answers came back, which
 * over-counts the requests still open, as the per-block count did. The share follows how many of the
 * round's passes still run, not which request each rode in, so a round whose passes end unevenly can
 * briefly count fewer slots than it has requests still unanswered.
 *
 * A pass's slot share is final by the time its round sends only because every pass that joins a round
 * does so synchronously, before `CoordinatorRepo.get` closes it.
 */
export class HeldBlockConsults {
	private readonly running = new Map<BlockId, Promise<void>>();
	/** Running passes per round they joined. A round leaves the map with its last pass. */
	private readonly passesPerRound = new Map<ConsultRound, number>();
	/** Running passes with no round, each asking every peer on a request of its own. */
	private passesWithoutRound = 0;

	/**
	 * Start the pass for `blockId` as a seat in `round`, unless the block's pass is already running or
	 * starting it would exceed the slots. `pass` is called synchronously, and only when it starts, so it
	 * can join `round` before the caller's first await. The pass must never reject.
	 */
	start(blockId: BlockId, round: ConsultRound | undefined, pass: () => Promise<void>): HeldBlockConsultStart {
		if (this.running.has(blockId)) return { kind: 'running' };
		const slotsInUse = this.slotsInUse();
		if (slotsInUse + this.slotsToJoin(round) > MAX_HELD_BLOCK_CONSULT_SLOTS) {
			return { kind: 'deferred', inFlight: this.running.size, slotsInUse };
		}
		const started = pass();
		this.count(round, 1);
		this.running.set(blockId, started.finally(() => {
			this.running.delete(blockId);
			this.count(round, -1);
		}));
		return { kind: 'started' };
	}

	/**
	 * Resolve once no pass is running. Loops, because a pass that ends without arming the window (a
	 * transient decline) leaves its block open to a read made meanwhile starting the next one.
	 */
	async settled(): Promise<void> {
		while (this.running.size > 0) {
			await Promise.all([...this.running.values()]);
		}
	}

	/** The request slots the running passes occupy. At most {@link MAX_HELD_BLOCK_CONSULT_SLOTS} rounds contribute, so this stays cheap. */
	private slotsInUse(): number {
		let slots = this.passesWithoutRound;
		for (const passes of this.passesPerRound.values()) slots += chunksFor(passes);
		return slots;
	}

	/** The slots one more pass in `round` adds: none while its round's last chunk has room. */
	private slotsToJoin(round: ConsultRound | undefined): number {
		if (!round) return 1;
		const passes = this.passesPerRound.get(round) ?? 0;
		return chunksFor(passes + 1) - chunksFor(passes);
	}

	private count(round: ConsultRound | undefined, delta: 1 | -1): void {
		if (!round) {
			this.passesWithoutRound += delta;
			return;
		}
		const passes = (this.passesPerRound.get(round) ?? 0) + delta;
		if (passes > 0) this.passesPerRound.set(round, passes);
		else this.passesPerRound.delete(round);
	}
}
