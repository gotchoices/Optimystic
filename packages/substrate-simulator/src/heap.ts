import type { VTime, EventRun, BatchRun } from './types.js';

/**
 * One pending scheduled item. `isBatch` discriminates a single event from a batch
 * (Decision 3); a batch occupies exactly one heap slot regardless of `count`.
 */
export interface HeapEntry {
	readonly at: VTime;
	/** Monotonic counter assigned at schedule time; the (at, seq) tie-break key (Decision 4). */
	readonly seq: number;
	readonly run: EventRun | BatchRun;
	/** Number of sub-invocations for a batch; ignored for single events. */
	readonly count: number;
	readonly isBatch: boolean;
}

/** True if `a` should pop before `b`: earlier `at`, or equal `at` and lower `seq`. */
function before(a: HeapEntry, b: HeapEntry): boolean {
	return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/**
 * Binary min-heap keyed on (at, seq) — O(log n) push/pop. Chosen over a sorted-array
 * insert (O(n) per push) precisely so 1M discrete events drain in well under a second
 * (Decision 3).
 */
export class EventHeap {
	private readonly items: HeapEntry[] = [];

	get size(): number {
		return this.items.length;
	}

	peek(): HeapEntry | undefined {
		return this.items[0];
	}

	push(entry: HeapEntry): void {
		const items = this.items;
		items.push(entry);
		let i = items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (before(items[i]!, items[parent]!)) {
				this.swap(i, parent);
				i = parent;
			} else {
				break;
			}
		}
	}

	pop(): HeapEntry | undefined {
		const items = this.items;
		const n = items.length;
		if (n === 0) {
			return undefined;
		}
		const top = items[0]!;
		const last = items.pop()!;
		if (n > 1) {
			items[0] = last;
			this.siftDown(0);
		}
		return top;
	}

	private siftDown(start: number): void {
		const items = this.items;
		const n = items.length;
		let i = start;
		for (;;) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < n && before(items[left]!, items[smallest]!)) {
				smallest = left;
			}
			if (right < n && before(items[right]!, items[smallest]!)) {
				smallest = right;
			}
			if (smallest === i) {
				break;
			}
			this.swap(i, smallest);
			i = smallest;
		}
	}

	private swap(i: number, j: number): void {
		const items = this.items;
		const tmp = items[i]!;
		items[i] = items[j]!;
		items[j] = tmp;
	}
}
