import { Tracker } from "./tracker.js";
import type { IBlock, BlockStore, Transforms } from "../index.js";
import { applyTransformToStore } from "./helpers.js";

export class Atomic<TBlock extends IBlock> extends Tracker<TBlock> {
	constructor(public readonly store: BlockStore<TBlock>) {
		super(store);
	}

	/** Flush what this atomic staged into its store and empty it.
	 *
	 * @returns the flushed transforms. This atomic no longer references them, and a parent
	 * `Tracker` copied what it kept ({@link Tracker.absorb}), so the caller may keep them as a record
	 * of what was staged; any other store may have taken the values by reference, so a caller over
	 * one must not change them. */
	commit(): Transforms {
		// A parent tracker takes the staged transform AND the bases pinned inside this atomic
		// (Tracker.absorb): without the pins, a single act() carrying more actions than the read
		// cache holds would lose digest coverage, the cache having evicted the early bases by the
		// flush; and without absorb keeping them as the bases of the flushed operations, a base the
		// cache moved on from between the pin and the flush would be re-pinned at the newer revision.
		// Any other store just receives the transform.
		if (this.store instanceof Tracker) {
			return this.store.absorb(this);
		}
		const transforms = this.reset();
		applyTransformToStore(transforms, this.store);
		return transforms;
	}

	// rollback = reset
}
