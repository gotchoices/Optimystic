/**
 * How many identify exchanges are in flight on this node, with any peer.
 *
 * A peer mid-identify is invisible to every cohort this node assembles: one never seen before is
 * not yet classified, and one that reconnected may show a partial protocol list that reads as
 * foreign until identify lands (see `identify-on-open.ts`). So a cohort view that names nobody but
 * this node, while an exchange is in flight, may be about to widen — which is what the cohort
 * reachability gate (`cohort-reachability.ts`) reads this for.
 */
import type { PeerId } from '@libp2p/interface';
import { createLogger } from '../logger.js';
import type { IdentifyObserver } from './identify-on-open.js';

const log = createLogger('identify-progress');

/** Counts identify exchanges between their `started` and their `settled`, per peer and in total. */
export class IdentifyProgress implements IdentifyObserver {
	private readonly byPeer = new Map<string, number>();
	private total = 0;

	started(peerId: PeerId): void {
		const id = peerId.toString();
		this.byPeer.set(id, (this.byPeer.get(id) ?? 0) + 1);
		this.total++;
	}

	/** Ignores — never drives negative — a `settled` with nothing in flight for the peer. */
	settled(peerId: PeerId): void {
		const id = peerId.toString();
		const flights = this.byPeer.get(id);
		if (flights === undefined) {
			log('settled:unmatched peer=%s', id.substring(0, 12));
			return;
		}
		if (flights === 1) this.byPeer.delete(id);
		else this.byPeer.set(id, flights - 1);
		this.total--;
	}

	inFlight(): number {
		return this.total;
	}
}
