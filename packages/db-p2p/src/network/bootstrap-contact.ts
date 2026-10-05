/**
 * What a node has established about its configured bootstrap peers since it started.
 *
 * A node built with bootstrap addresses knows, from its own configuration, of other machines it
 * was told to join through. `@libp2p/bootstrap` reaches for them from a timer, one second after
 * start by default, and for that second the node's view of every cohort is itself alone: whatever
 * it opens and does not find locally, it founds from scratch (GitHub issue #27, where a joining
 * node built its own copy of the shared table catalog). {@link BootstrapContactTracker} dials them
 * the moment the node has started instead, and keeps the two facts the key network needs while a
 * cohort lookup would otherwise come back with nobody but this node in it:
 *
 *  - whether anything is still IN FLIGHT: a dial, or identify on a connection to one of them;
 *  - each peer's ANSWER, once identify has settled what it is: a member of some network that
 *    answered with its protocol list, or a peer that does not speak this network's identify at
 *    all, which is how a relay or another group's node used as infrastructure answers.
 *
 * A connection alone is not an answer, and neither is the peerStore's protocol list; see
 * `identify-on-open.ts` for why only the identify exchange's outcome is definite.
 */
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { createLogger } from '../logger.js';
import type { IdentifyObserver, IdentifyOutcome } from './identify-on-open.js';

const log = createLogger('bootstrap-contact');

/** One configured bootstrap peer, with every configured address that reaches it. */
export interface BootstrapTarget {
	readonly peerId: PeerId;
	readonly addrs: Multiaddr[];
}

/** What identify established about a bootstrap peer; an exchange that merely failed establishes nothing. */
export type BootstrapAnswer = Exclude<IdentifyOutcome, 'failed'>;

/** The node's contact with its bootstrap peers, as `Libp2pKeyPeerNetwork` reads it. */
export interface BootstrapContact {
	/** The peers the configured bootstrap addresses name, in `PeerId.toString()` form; never this node. */
	readonly peerIds: readonly string[];
	/** What the peer has answered in this process, or `undefined` while it has not. Once given, an answer stands. */
	answerOf(peerId: string): BootstrapAnswer | undefined;
	/** Dials of bootstrap peers, and identify exchanges with them, that have not settled yet. */
	inFlight(): number;
	/** Resolves, never rejects, when the next of those settles; at once when none is in flight. */
	nextSettled(): Promise<void>;
}

/**
 * The peer a bootstrap address reaches: its LAST `/p2p/` component. On a plain address that is the
 * only one; on a circuit address (`<relay>/p2p/<relay id>/p2p-circuit/p2p/<partner id>`) it is the
 * partner behind the relay, which is the machine the host asked this node to join, not the relay.
 */
function peerReachedBy(addr: Multiaddr): string | undefined {
	let reached: string | undefined;
	for (const component of addr.getComponents()) {
		if (component.name === 'p2p' && component.value) reached = component.value;
	}
	return reached;
}

/**
 * Group the configured bootstrap addresses by the peer each one reaches (see {@link peerReachedBy}),
 * in configured order. An address that names no peer is skipped with a log line, as
 * `@libp2p/bootstrap` skips it; one that is not a multiaddr at all throws, as it does there.
 */
export function planBootstrapTargets(bootstrapNodes: readonly string[]): BootstrapTarget[] {
	const byPeer = new Map<string, BootstrapTarget>();
	for (const entry of bootstrapNodes) {
		const addr = multiaddr(entry);
		const reached = peerReachedBy(addr);
		if (reached === undefined) {
			log('plan:skipped addr=%s reason=no-peer-id', entry);
			continue;
		}
		const peerId = peerIdFromString(reached);
		const target = byPeer.get(peerId.toString());
		if (target) target.addrs.push(addr);
		else byPeer.set(peerId.toString(), { peerId, addrs: [addr] });
	}
	return [...byPeer.values()];
}

/**
 * Dials a node's bootstrap peers and records what each has answered.
 *
 * Built before the node starts, so it can observe identify from the first connection
 * (`identifyOnConnectionOpen` takes it as the observer); {@link dial} is called once the node has
 * started. It counts every identify exchange with a bootstrap peer, not only the ones on
 * connections its own dials opened: the peer may have dialed this node first.
 *
 * A target naming this node itself is dropped. A bootstrap list shared by every machine of a
 * deployment names each of them, and a node can never hear from itself, so counting it would leave
 * the node waiting on contact for the life of the process.
 */
export class BootstrapContactTracker implements BootstrapContact, IdentifyObserver {
	readonly peerIds: readonly string[];
	private readonly targets: readonly BootstrapTarget[];
	private readonly answers = new Map<string, BootstrapAnswer>();
	private flights = 0;
	private settleWaiters: Array<() => void> = [];

	constructor(selfPeerId: PeerId, targets: readonly BootstrapTarget[]) {
		this.targets = targets.filter(target => !target.peerId.equals(selfPeerId));
		this.peerIds = this.targets.map(target => target.peerId.toString());
	}

	/**
	 * Start dialing every target now. Nothing is awaited and nothing needs releasing: a dial runs
	 * under libp2p's own `dialTimeout`, and stopping the node aborts it.
	 */
	dial(node: Pick<Libp2p, 'dial'>): void {
		for (const target of this.targets) void this.dialTarget(node, target);
	}

	/** One dial, reported rather than thrown: an unreachable bootstrap peer is an ordinary start. */
	private async dialTarget(node: Pick<Libp2p, 'dial'>, target: BootstrapTarget): Promise<void> {
		const id = target.peerId.toString().substring(0, 12);
		this.flights++;
		try {
			await node.dial(target.addrs);
			log('dial:connected peer=%s', id);
		} catch (err) {
			log('dial:failed peer=%s addrs=%d - %o', id, target.addrs.length, err);
		} finally {
			this.flightSettled();
		}
	}

	started(peerId: PeerId): void {
		if (this.peerIds.includes(peerId.toString())) this.flights++;
	}

	settled(peerId: PeerId, outcome: IdentifyOutcome): void {
		const id = peerId.toString();
		if (!this.peerIds.includes(id)) return;
		if (outcome !== 'failed' && !this.answers.has(id)) {
			this.answers.set(id, outcome);
			log('answer:%s peer=%s', outcome, id.substring(0, 12));
		}
		this.flightSettled();
	}

	answerOf(peerId: string): BootstrapAnswer | undefined {
		return this.answers.get(peerId);
	}

	inFlight(): number {
		return this.flights;
	}

	nextSettled(): Promise<void> {
		if (this.flights === 0) return Promise.resolve();
		return new Promise<void>(resolve => this.settleWaiters.push(resolve));
	}

	private flightSettled(): void {
		this.flights--;
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const wake of waiters) wake();
	}
}
