import type { Startable, Logger, PeerId } from '@libp2p/interface'
import { assembleTwoSidedCohort } from './cohort.js'

type Components = {
	logger: { forComponent: (name: string) => Logger }
	registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> }
}

export type FretServiceInit = {
	clusterSize?: number
}

export class FretService implements Startable {
	private running = false
	private readonly log: Logger
	private readonly k: number
	private libp2pRef: any | undefined

	constructor(private readonly components: Components, init: FretServiceInit = {}) {
		this.log = components.logger.forComponent('db-p2p:fret')
		this.k = Math.max(1, init.clusterSize ?? 10)
	}

	setLibp2p(libp2p: any): void { this.libp2pRef = libp2p }

	private getLibp2p(): any {
		try {
			return this.libp2pRef ?? (this.components as any).libp2p
		} catch {
			return this.libp2pRef
		}
	}

	get [Symbol.toStringTag](): string { return '@libp2p/fret' }

	async start(): Promise<void> {
		if (this.running) return
		// Ensure we hold a stable reference to libp2p instance as early as possible
		try { ((this.components as any).libp2p?.services?.fret as any)?.setLibp2p?.((this.components as any).libp2p) } catch {}
		this.running = true
	}

	async stop(): Promise<void> {
		this.running = false
	}

	private getKnownPeers(): PeerId[] {
		try {
			const libp2p = this.getLibp2p()
			const selfId: PeerId = libp2p.peerId
			const storePeers: Array<{ id: PeerId }> = libp2p.peerStore.getPeers() ?? []
			const connPeers: PeerId[] = (libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer)
			const all = [...storePeers.map(p => p.id), ...connPeers]
			const uniq = all.filter((p, i) => all.findIndex(x => x.toString() === p.toString()) === i)
			return uniq.filter((pid: PeerId) => pid.toString() !== selfId.toString())
		} catch {
			return []
		}
	}

	async getCluster(key: Uint8Array): Promise<PeerId[]> {
		const libp2p = this.getLibp2p()
		if (!libp2p?.peerId) return []
		const peers: PeerId[] = [libp2p.peerId, ...this.getKnownPeers()]
		const wants = Math.min(this.k, peers.length)
		if (wants === 0) return []
		const { cohort } = assembleTwoSidedCohort(key, peers, wants)
		return cohort
	}

	async isInCluster(key: Uint8Array): Promise<boolean> {
		const libp2p = this.getLibp2p()
		const cluster = await this.getCluster(key)
		return cluster.some(p => p.toString() === libp2p.peerId.toString())
	}
}

export function fretService(init: FretServiceInit = {}) {
	return (components: Components) => new FretService(components, init)
}

