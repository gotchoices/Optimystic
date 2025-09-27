import type { Libp2p } from 'libp2p'
import type { DigitreeStore } from '../store/digitree-store.js'
import { peerIdFromString } from '@libp2p/peer-id'

export function seedDiscovery(node: Libp2p, store: DigitreeStore): void {
	const anyNode = node as unknown as { dispatchEvent?: (evt: Event) => void }
	for (const entry of store.list()) {
		try {
			const pid = peerIdFromString(entry.id)
			anyNode.dispatchEvent?.(new CustomEvent('peer:discovery', { detail: { id: pid, multiaddrs: [] } as any }))
		} catch {}
	}
}
