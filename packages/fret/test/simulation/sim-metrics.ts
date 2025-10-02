export interface SimMetrics {
	totalJoins: number
	totalLeaves: number
	totalConnections: number
	totalDisconnections: number
	stabilizationCycles: number
	neighborsFound: number
	avgNeighborCount: number
	avgPathLength: number
	convergenceTimeMs: number
	dropRate: number
	maxHopCount: number
}

export class MetricsCollector {
	private metrics: SimMetrics = {
		totalJoins: 0,
		totalLeaves: 0,
		totalConnections: 0,
		totalDisconnections: 0,
		stabilizationCycles: 0,
		neighborsFound: 0,
		avgNeighborCount: 0,
		avgPathLength: 0,
		convergenceTimeMs: 0,
		dropRate: 0,
		maxHopCount: 0,
	}

	private neighborCounts: number[] = []
	private pathLengths: number[] = []

	recordJoin(): void {
		this.metrics.totalJoins++
	}

	recordLeave(): void {
		this.metrics.totalLeaves++
	}

	recordConnection(): void {
		this.metrics.totalConnections++
	}

	recordDisconnection(): void {
		this.metrics.totalDisconnections++
	}

	recordStabilization(): void {
		this.metrics.stabilizationCycles++
	}

	recordNeighbors(count: number): void {
		this.metrics.neighborsFound += count
		this.neighborCounts.push(count)
	}

	recordPath(hopCount: number): void {
		this.pathLengths.push(hopCount)
		if (hopCount > this.metrics.maxHopCount) this.metrics.maxHopCount = hopCount
	}

	recordConvergence(timeMs: number): void {
		this.metrics.convergenceTimeMs = timeMs
	}

	finalize(): SimMetrics {
		if (this.neighborCounts.length > 0) {
			this.metrics.avgNeighborCount =
				this.neighborCounts.reduce((a, b) => a + b, 0) / this.neighborCounts.length
		}
		if (this.pathLengths.length > 0) {
			this.metrics.avgPathLength =
				this.pathLengths.reduce((a, b) => a + b, 0) / this.pathLengths.length
		}
		const totalAttempts = this.metrics.totalConnections + this.metrics.totalDisconnections
		if (totalAttempts > 0) {
			this.metrics.dropRate = this.metrics.totalDisconnections / totalAttempts
		}
		return { ...this.metrics }
	}

	getMetrics(): Readonly<SimMetrics> {
		return this.metrics
	}
}

