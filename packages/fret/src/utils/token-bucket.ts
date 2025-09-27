export class TokenBucket {
	private capacity: number;
	private refillPerSec: number;
	private tokens: number;
	private last: number;

	constructor(capacity: number, refillPerSec: number) {
		this.capacity = capacity;
		this.refillPerSec = refillPerSec;
		this.tokens = capacity;
		this.last = Date.now();
	}

	tryTake(cost = 1): boolean {
		this.refill();
		if (this.tokens >= cost) {
			this.tokens -= cost;
			return true;
		}
		return false;
	}

	retryAfterMs(cost = 1): number {
		this.refill();
		if (this.tokens >= cost) return 0;
		const deficit = cost - this.tokens;
		const sec = deficit / this.refillPerSec;
		return Math.ceil(sec * 1000);
	}

	private refill(): void {
		const now = Date.now();
		const deltaSec = (now - this.last) / 1000;
		if (deltaSec > 0) {
			this.tokens = Math.min(this.capacity, this.tokens + deltaSec * this.refillPerSec);
			this.last = now;
		}
	}
}
