import { Tracker } from "./tracker.js";
import type { IBlock, BlockStore } from "../index.js";
import { applyTransformToStore } from "./helpers.js";

export class Atomic<TBlock extends IBlock> extends Tracker<TBlock> {
	constructor(public readonly store: BlockStore<TBlock>) {
		super(store);
	}

	commit() {
		// A parent tracker takes the staged transform AND the bases pinned inside this atomic
		// (Tracker.absorb): without the pins, a single act() carrying more actions than the read
		// cache holds would lose digest coverage, the cache having evicted the early bases by the
		// flush; and without absorb keeping them as the bases of the flushed operations, a base the
		// cache moved on from between the pin and the flush would be re-pinned at the newer revision.
		// Any other store just receives the transform.
		if (this.store instanceof Tracker) {
			this.store.absorb(this);
		} else {
			applyTransformToStore(this.reset(), this.store);
		}
	}

	// rollback = reset
}
