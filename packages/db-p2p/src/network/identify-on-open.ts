/**
 * Runs identify on every connection the moment it opens, and reports how each exchange ended.
 *
 * `@libp2p/identify` does the first half by itself (`runOnConnectionOpen`) and throws the outcome
 * away. One outcome is worth keeping: a peer that refuses this network's identify protocol is not
 * on this network. Identify here is network-namespaced, so such a peer never completes it, and its
 * peerStore protocol list says nothing reliable in the meantime. libp2p adds every protocol a
 * stream negotiates, in either direction, to that list, so a peer on another network shows
 * whatever happened to be negotiated (a ping, a relay hop), and a peer on THIS network shows a
 * partial list for a moment before its identify lands. The refusal is the only definite "not one
 * of ours", and the completed exchange the only definite "this is its whole list".
 *
 * The node is therefore built with `runOnConnectionOpen: false` and
 * {@link identifyOnConnectionOpen} installed in its place: the same call on the same event, with
 * the result observed instead of discarded.
 */
import type { Connection, PeerId } from '@libp2p/interface';
import type { Identify } from '@libp2p/identify';
import { createLogger } from '../logger.js';

const log = createLogger('identify-on-open');

/** How one identify exchange ended. */
export type IdentifyOutcome =
	/** The peer answered with its protocol list, which is now in the peerStore. */
	| 'identified'
	/** The peer does not speak this network's identify protocol: it is not on this network. */
	| 'foreign'
	/** The exchange failed some other way (a timeout, a reset, a closed connection). Nothing was learned. */
	| 'failed';

/** Told when identify starts on a connection to a peer, and how it ended. `settled` follows every `started`. */
export interface IdentifyObserver {
	started(peerId: PeerId): void;
	settled(peerId: PeerId, outcome: IdentifyOutcome): void;
}

/** The slice of the node {@link identifyOnConnectionOpen} uses. */
export interface IdentifyOnOpenHost {
	addEventListener(type: 'connection:open', listener: (evt: CustomEvent<Connection>) => void): void;
	services: { identify: Pick<Identify, 'identify'> };
}

/** libp2p's multistream negotiation raises this, by name, when the far side handles none of the offered protocols. */
const UNSUPPORTED_PROTOCOL_ERROR = 'UnsupportedProtocolError';

async function identifyConnection(node: IdentifyOnOpenHost, connection: Connection, observer?: IdentifyObserver): Promise<void> {
	const peerId = connection.remotePeer;
	observer?.started(peerId);
	let outcome: IdentifyOutcome = 'failed';
	try {
		await node.services.identify.identify(connection);
		outcome = 'identified';
	} catch (err) {
		// The built-in trigger swallows this silently; a line per failure is what makes a peer that
		// never classifies explainable.
		if ((err as Error | undefined)?.name === UNSUPPORTED_PROTOCOL_ERROR) outcome = 'foreign';
		log('identify:%s peer=%s - %o', outcome, peerId.toString().substring(0, 12), err);
	} finally {
		observer?.settled(peerId, outcome);
	}
}

/**
 * Run identify on every connection `node` opens or accepts from now on. Call before `node.start()`
 * on a node whose identify service was built with `runOnConnectionOpen: false`; installing it on a
 * node that still runs identify by itself would start two exchanges per connection, and the
 * protocol allows one.
 */
export function identifyOnConnectionOpen(node: IdentifyOnOpenHost, observer?: IdentifyObserver): void {
	node.addEventListener('connection:open', evt => {
		void identifyConnection(node, evt.detail, observer);
	});
}
