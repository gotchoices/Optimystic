import { describe, it } from 'mocha'
import { FretSimulation } from './simulation/fret-sim.js'
import type { SimMetrics } from './simulation/sim-metrics.js'

describe('FRET simulation tests', function () {
	this.timeout(30000)

	it('converges with N=5, no churn', () => {
		const sim = new FretSimulation({
			seed: 42,
			n: 5,
			k: 5,
			m: 3,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 3000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 5) throw new Error(`Expected 5 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=5 metrics:', metrics)
	})

	it('converges with N=10, no churn', () => {
		const sim = new FretSimulation({
			seed: 123,
			n: 10,
			k: 7,
			m: 4,
			churnRatePerSec: 0,
			stabilizationIntervalMs: 500,
			durationMs: 5000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 10) throw new Error(`Expected 10 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=10 metrics:', metrics)
	})

	it('converges with N=25, light churn (1%/s)', () => {
		const sim = new FretSimulation({
			seed: 999,
			n: 25,
			k: 15,
			m: 8,
			churnRatePerSec: 0.25,
			stabilizationIntervalMs: 500,
			durationMs: 10000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 25) throw new Error(`Expected 25 joins, got ${metrics.totalJoins}`)
		if (metrics.avgNeighborCount === 0) throw new Error('No neighbors found')
		console.log('  N=25 metrics:', metrics)
	})

	it('handles N=100, moderate churn (5%/s)', () => {
		const sim = new FretSimulation({
			seed: 7777,
			n: 100,
			k: 15,
			m: 8,
			churnRatePerSec: 5,
			stabilizationIntervalMs: 300,
			durationMs: 10000,
		})
		const metrics = sim.run()
		if (metrics.totalJoins !== 100) throw new Error(`Expected 100 joins, got ${metrics.totalJoins}`)
		console.log('  N=100 metrics:', metrics)
	})
})

