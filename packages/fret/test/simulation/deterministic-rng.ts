// Mulberry32 PRNG for deterministic simulation
export class DeterministicRNG {
	private state: number

	constructor(seed: number) {
		this.state = seed >>> 0
	}

	next(): number {
		let t = (this.state += 0x6d2b79f5)
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	nextInt(min: number, max: number): number {
		return Math.floor(min + this.next() * (max - min))
	}

	pick<T>(arr: T[]): T | undefined {
		if (arr.length === 0) return undefined
		return arr[this.nextInt(0, arr.length)]
	}

	shuffle<T>(arr: T[]): T[] {
		const copy = [...arr]
		for (let i = copy.length - 1; i > 0; i--) {
			const j = this.nextInt(0, i + 1)
			;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
		}
		return copy
	}
}

