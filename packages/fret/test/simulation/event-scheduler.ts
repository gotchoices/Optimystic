export type SimEvent = {
	time: number
	type: 'join' | 'leave' | 'connect' | 'disconnect' | 'stabilize'
	peerId?: string
	targetId?: string
}

export class EventScheduler {
	private events: SimEvent[] = []
	private currentTime = 0

	schedule(event: Omit<SimEvent, 'time'>, delayMs: number): void {
		this.events.push({ ...event, time: this.currentTime + delayMs })
		this.events.sort((a, b) => a.time - b.time)
	}

	nextEvent(): SimEvent | undefined {
		const evt = this.events.shift()
		if (evt) this.currentTime = evt.time
		return evt
	}

	advanceTo(time: number): SimEvent[] {
		const fired: SimEvent[] = []
		while (this.events.length > 0 && this.events[0]!.time <= time) {
			const evt = this.nextEvent()
			if (evt) fired.push(evt)
		}
		this.currentTime = time
		return fired
	}

	getCurrentTime(): number {
		return this.currentTime
	}

	pending(): number {
		return this.events.length
	}

	peek(): SimEvent | undefined {
		return this.events[0]
	}
}

