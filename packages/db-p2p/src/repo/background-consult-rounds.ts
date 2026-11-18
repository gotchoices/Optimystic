import type { ActionContext } from "@optimystic/db-core";
import { MAX_CONSULT_BATCH_BLOCKS } from "../protocol-limits.js";
import type { Logger } from "../logger.js";
import { armUnrefTimer } from "../unref-timer.js";
import type { ConsultRound, ConsultSeat } from "./consult-round.js";

export interface BackgroundConsultRoundsDeps {
	/** Builds a round exactly as `CoordinatorRepo.openConsultRound` does. */
	open(): ConsultRound;
	/** How long the open round collects seats after its first seat joins. */
	delayMs: number;
	log: Logger;
}

/** The round seats join now, how many have, and the cancel of its close timer once one has. */
interface OpenRound {
	readonly round: ConsultRound;
	seats: number;
	cancelTimer?: () => void;
}

/**
 * The {@link ConsultRound} that the consults running behind reads (`CoordinatorRepo.startHeldBlockConsult`)
 * share, so consults started by reads close together ask each cohort peer in one request rather than one
 * per read. After a restart no held block has been consulted, and an app reading its tables one at a time
 * started one consult per table, each a request of its own to every peer (sereus#60).
 *
 * At most one round is open. It closes `delayMs` after its first seat joins, or at once when the seat
 * that joins brings it to {@link MAX_CONSULT_BATCH_BLOCKS} — one request's worth, since each background
 * pass is one block and `HeldBlockConsults` runs at most one pass per block. A closed round still sends
 * only once every joined seat has registered its questions or left (the round's barrier), so a seat whose
 * cohort lookup is slow holds back the other background seats' requests; no read waits on any of them,
 * and the per-peer deadline starts at send, so the wait never makes a peer read as silent.
 *
 * The timer is unref'd, so an open round never keeps a process alive. A round open when the node stops
 * behaves like any pass in flight then (the `NOTE:` on `CoordinatorRepo.heldBlockConsults`).
 */
export class BackgroundConsultRounds {
	private openRound?: OpenRound;

	constructor(private readonly deps: BackgroundConsultRoundsDeps) {}

	/**
	 * The open round, opening one if none is open. Arms nothing: a round no seat joins — its pass was
	 * already running, or the slots were full — costs nothing and stays open for the next pass.
	 */
	current(): ConsultRound {
		this.openRound ??= { round: this.deps.open(), seats: 0 };
		return this.openRound.round;
	}

	/**
	 * Join `round`, which must be the one {@link current} just returned, in the same synchronous step.
	 * The first seat arms the close timer; the seat that brings the round to
	 * {@link MAX_CONSULT_BATCH_BLOCKS} seats closes it at once. A closed round is never returned by
	 * {@link current} again.
	 */
	join(round: ConsultRound, context: ActionContext | undefined): ConsultSeat {
		const open = this.openRound;
		if (open?.round !== round) throw new Error('BackgroundConsultRounds: a seat joined a round that is not the open one');
		const seat = round.join(context);
		open.seats++;
		if (open.seats >= MAX_CONSULT_BATCH_BLOCKS) this.close(open, 'full');
		else open.cancelTimer ??= armUnrefTimer(() => this.close(open, 'timer'), this.deps.delayMs);
		return seat;
	}

	private close(open: OpenRound, reason: 'timer' | 'full'): void {
		if (this.openRound !== open) return;
		this.openRound = undefined;
		open.cancelTimer?.();
		open.round.close();
		this.deps.log('cluster-fetch:background-round', { blocks: open.seats, reason });
	}
}
