import { Tracker } from "./tracker.js";
import type { IBlock, BlockStore } from "../index.js";
import { applyTransformToStore } from "./helpers.js";

export class Atomic<TBlock extends IBlock> extends Tracker<TBlock> {
	constructor(public readonly store: BlockStore<TBlock>) {
		super(store);
	}

	commit() {
		// Hand the bases pinned inside this atomic to the parent tracker BEFORE reset() wipes this
		// store — without this, a single act() carrying more actions than the read cache holds loses
		// digest coverage, because by the flush below the cache has already evicted the early bases.
		// The parent gets a COPY (adopt), not this store itself: sharing the store would let the
		// reset() below wipe the parent's pins a line before flushing into it.
		if (this.store instanceof Tracker) this.store.pins.adopt(this.pins);
		const transform = this.reset();
		applyTransformToStore(transform, this.store);
	}

	// rollback = reset
}
