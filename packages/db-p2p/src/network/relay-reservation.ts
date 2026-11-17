/**
 * Keeps a relay-only node's circuit reservation alive.
 *
 * A phone or browser reaches its group only through a relay server: it listens on
 * `<relay address>/p2p/<relay id>/p2p-circuit`, holds a slot ("reservation") on that relay, and
 * advertises the circuit address other peers dial. libp2p asks the relay for that slot once, from
 * inside `start()`, and after that only renews it while the connection to the relay stays up. The
 * slot is lost, and the node stays unreachable until the app restarts, whenever the relay restarts
 * or the connection to it drops — both read from the installed `@libp2p/circuit-relay-v2` 4.2.13
 * (see the `NOTE:` at {@link findCircuitRelayTransport} for the exact mechanics). Through 4.1.3
 * libp2p's own routine renewal lost the slot as well; 4.2 renews it in place.
 *
 * This module gives the node its own supervisor for every such relay, in two parts:
 *
 * 1. {@link planRelayListenAddrs} rewrites each relay-naming circuit listen address into a bare
 *    `/p2p-circuit` entry and records the relay it named. libp2p treats the bare shape as a
 *    "search" listener: it registers a pending slot and publishes any `discovered` reservation
 *    that fills it, including the one requested again after the slot was lost. A listener on the
 *    relay-naming ("configured") shape publishes from inside its own `listen()` and, from 4.2, on
 *    a later `configured` reservation for the relay it already listened through; it publishes no
 *    `discovered` one, which is the kind the supervisor asks for, so the rewrite is what lets the
 *    supervisor bring the address back.
 * 2. {@link superviseRelayReservation} runs one supervisor per recorded relay. It dials the relay,
 *    asks the circuit-relay transport's reservation store for a `discovered` slot on it, waits
 *    until the node advertises a circuit address through it, and repeats that whenever the address
 *    goes away. "Held" is judged per relay ({@link routesThroughRelay}), so one relay's slot never
 *    satisfies another relay's supervisor. It is also judged locally, from the addresses this node
 *    advertises, which say nothing about whether the relay still keeps the slot: a relay can forget
 *    a reservation while the connection to it stays open, and then nobody can reach the node through
 *    it. So while held, the supervisor re-sends the reservation request every `renewMs` (5 min by
 *    default, {@link forceReservationRenewal}); that renewal is what checks "held" against the relay.
 *
 * `createLibp2pNodeBase` applies the plan before building libp2p's options, starts the supervisors
 * first thing after `node.start()`, and awaits their first drives so a relay that cannot be
 * reserved still rejects node creation, as it did when libp2p reserved from `listen()`.
 *
 * A host that passes a bare `/p2p-circuit` itself is left alone and not supervised: it owns that
 * reservation (Sereus runs its own supervisor over exactly that shape).
 *
 * Everything here is fail-soft: a drive never throws, a stopped supervisor never schedules
 * anything, and every timer is `unref`'d so a pending retry cannot keep a Node process alive.
 * Adapted from `sereus/packages/cadre-core/src/relay-reservation.ts`, reduced to what this node
 * needs: one relay per supervisor, event-driven re-checks, and no status surface.
 */
import { multiaddr, type Component } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { routesThroughRelay } from '../peer-address-book.js';
import { createLogger } from '../logger.js';
import { unrefTimer } from '../unref-timer.js';

const log = createLogger('relay-reservation');

/** The bare "search" circuit listen address: one pending slot, filled by whoever asks for it. */
export const CIRCUIT_SEARCH_LISTEN_ADDR = '/p2p-circuit';

/** A relay this node must keep a reservation on itself. */
export interface SupervisedRelay {
	/** Where to dial the relay: the listen entry without its trailing `/p2p-circuit`. */
	readonly dialAddr: string;
	/** The relay's peer id in the form `PeerId.toString()` produces, whatever spelling the listen entry used. */
	readonly peerId: string;
}

/** What {@link planRelayListenAddrs} hands back: the addresses libp2p listens on, and the relays to supervise. */
export interface RelayListenPlan {
	readonly listenAddrs: string[];
	readonly supervisedRelays: SupervisedRelay[];
}

/**
 * Split a node's listen addresses into what libp2p should listen on and which relays this node
 * must supervise.
 *
 * A relay-naming circuit listen address — exactly one `p2p-circuit` component, last, with a `p2p`
 * component (the relay's peer id) immediately before it — becomes one bare
 * {@link CIRCUIT_SEARCH_LISTEN_ADDR} entry plus one supervised relay. libp2p keeps listen addresses
 * as a plain array with no de-duplication, so N such entries give N bare listeners and N pending
 * slots. Two entries naming one relay (by peer id, whatever the spelling) give one of each; the
 * first entry's dial address wins. Everything else passes through untouched: a host's own bare
 * `/p2p-circuit` (the host owns that reservation), TCP and WebSocket entries, and anything
 * malformed or multi-hop, which libp2p rejects itself.
 */
export function planRelayListenAddrs(listenAddrs: readonly string[]): RelayListenPlan {
	const listen: string[] = [];
	const supervised: SupervisedRelay[] = [];
	const seen = new Set<string>();
	for (const addr of listenAddrs) {
		const relay = relayNamedByListenAddr(addr);
		if (relay === undefined) {
			listen.push(addr);
			continue;
		}
		if (seen.has(relay.peerId)) continue;
		seen.add(relay.peerId);
		supervised.push(relay);
		listen.push(CIRCUIT_SEARCH_LISTEN_ADDR);
	}
	return { listenAddrs: listen, supervisedRelays: supervised };
}

/** The relay a listen address names, or `undefined` when it is not a relay-naming circuit listen address. */
function relayNamedByListenAddr(addr: string): SupervisedRelay | undefined {
	let components: Component[];
	try {
		components = multiaddr(addr).getComponents();
	} catch {
		return undefined;
	}
	const circuitHops = components.filter(c => c.name === 'p2p-circuit').length;
	const last = components[components.length - 1];
	const relayHop = components[components.length - 2];
	if (circuitHops !== 1 || last?.name !== 'p2p-circuit' || relayHop?.name !== 'p2p' || relayHop.value === undefined) {
		return undefined;
	}
	let peerId: string;
	try {
		peerId = peerIdFromString(relayHop.value).toString();
	} catch {
		return undefined;
	}
	return { dialAddr: multiaddr(components.slice(0, -1)).toString(), peerId };
}

/**
 * The slice of `@libp2p/utils`' cuckoo `Filter` the reservation store remembers failed relays in.
 * `remove` is optional on that interface, so its absence must degrade, never throw.
 */
export interface RelayFilterLike {
	has(item: Uint8Array): boolean;
	remove?(item: Uint8Array): boolean;
}

/**
 * The slice of `@libp2p/circuit-relay-v2`'s transport-side `ReservationStore` this module drives.
 * Structural, because the class is internal to that package: naming only the members used keeps
 * the coupling small and greppable, and lets {@link findCircuitRelayTransport} duck-type it.
 */
export interface RelayReservationStoreLike {
	addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
	hasReservation(peerId: PeerId): boolean;
	/**
	 * The relay's grant for the reservation this store holds on `peerId`. The live object the store
	 * keeps, not a copy: {@link forceReservationRenewal} writes `expire` on it. `expire` is the relay's
	 * expiry in Unix seconds.
	 */
	getReservation(peerId: PeerId): { expire: bigint } | undefined;
	relayFilter?: RelayFilterLike;
}

/** The slice of libp2p's circuit-relay transport that owns the reservation store. */
export interface CircuitRelayTransportLike {
	reservationStore: RelayReservationStoreLike;
}

/**
 * The running node's circuit-relay transport, or `null` when it has none.
 *
 * NOTE: the ONE place this package reaches libp2p internals for relay reservations, pinned against
 * `libp2p` 3.3.11 and `@libp2p/circuit-relay-v2` 4.2.13 by `test/relay-reservation-seam.spec.ts`,
 * which must fail loudly if an upgrade moves any of it. There is no public route: the `Libp2p`
 * interface has no `listen`, and nothing public exposes the reservation store. `node.components`
 * is a real public field on libp2p's node class, just not on the interface; `transportManager`
 * is a component; the circuit-relay transport is the one whose `reservationStore` has `addRelay`,
 * `hasReservation` and `getReservation`. What the store does on 4.2.13, read from
 * `node_modules/@libp2p/circuit-relay-v2/src/transport/`: `listener.ts` publishes a `configured`
 * reservation from inside `listen()`, and on `relay:created-reservation` only when it is for the
 * relay that listener already published (a bare listener that has published nothing ignores it),
 * while a bare listener publishes any `discovered` reservation carrying its pending id, and
 * re-confirms its addresses on a later event for the relay it holds; and `reservation-store.ts`
 * drops a reservation on `connection:close`, re-queues the pending id only for `discovered` ones,
 * renews a reservation in place while its relay connection is still open (4.1.3 removed and
 * re-created it), and adds a relay whose request failed with `DialError` or
 * `UnsupportedProtocolError` to the private `relayFilter`, refusing it afterwards with "The relay
 * was previously invalid" until the filter is reset.
 *
 * Renewal ({@link forceReservationRenewal}) rests on two more facts of `addRelay` there. A plain
 * `addRelay` on a reservation that is held, whose connection is still open, and that expires more
 * than its `REFRESH_WINDOW` (10 min) from now returns that reservation WITHOUT contacting the
 * relay, so it cannot repair a relay that forgot the reservation. Anything else refreshes in place:
 * a fresh RESERVE over the open connection, the address kept advertised meanwhile, the entry's slot
 * id reused, libp2p's own refresh timer re-armed, the keep-alive tag renewed, and
 * `relay:created-reservation` dispatched; if that RESERVE fails, the `catch` removes the entry,
 * which withdraws the address. Zeroing `expire` on the held reservation is the only route into
 * that refresh, and it mutates a libp2p-owned object: `expire` is read only by the refresh-window
 * check, a successful refresh replaces the entry with the relay's new expiry, and if `addRelay`
 * throws before its job runs (`RelayQueueFullError`, or the relay filter) the zero stays, which
 * only means the next request refreshes too. On the relay side (`src/server/reservation-store.ts`,
 * `reserve`), a RESERVE from a peer that holds a reservation resets its lifetime and one from a
 * peer it forgot creates a new one, so any RESERVE that reaches the relay repairs it. The supervisor
 * only ever holds `discovered` reservations on its relays (the plan leaves no `configured`
 * listener on them), so renewing as `discovered` reuses the entry's slot id and never meets
 * `HadEnoughRelaysError`, whose pending-slot check an existing entry skips.
 */
export function findCircuitRelayTransport(node: Libp2p): CircuitRelayTransportLike | null {
	for (const transport of nodeTransports(node)) {
		const store = (transport as { reservationStore?: unknown }).reservationStore;
		if (isReservationStore(store)) {
			return { reservationStore: store };
		}
	}
	return null;
}

/** `components` is a real field on libp2p's node class but not on the `Libp2p` interface. */
interface Libp2pComponentsLike {
	components?: {
		transportManager?: {
			getTransports?: () => readonly unknown[];
		};
	};
}

function nodeTransports(node: Libp2p): readonly unknown[] {
	const manager = (node as Libp2p & Libp2pComponentsLike).components?.transportManager;
	if (typeof manager?.getTransports !== 'function') {
		log.error('no transportManager.getTransports() on this node — libp2p internals moved?');
		return [];
	}
	try {
		return manager.getTransports();
	} catch (err) {
		log.error('transportManager.getTransports() threw: %o', err);
		return [];
	}
}

function isReservationStore(value: unknown): value is RelayReservationStoreLike {
	if (typeof value !== 'object' || value === null) return false;
	const store = value as Partial<RelayReservationStoreLike>;
	return typeof store.addRelay === 'function'
		&& typeof store.hasReservation === 'function'
		&& typeof store.getReservation === 'function';
}

/**
 * Fail node creation, before anything starts, when a listen address names a relay but no transport
 * could ever reserve on it. libp2p would reject the bare `/p2p-circuit` entry itself during
 * `start()`, with a generic unsupported-listen-address error; this names the actual omission.
 */
export function assertCircuitRelayTransport(node: Libp2p, relays: readonly SupervisedRelay[]): void {
	if (relays.length === 0) return;
	if (findCircuitRelayTransport(node) !== null) return;
	throw new Error(
		`listen address names a relay (${relays[0]!.dialAddr}) but the node has no circuit-relay transport — add circuitRelayTransport() to transports`
	);
}

/**
 * Fail node creation, before anything is built, when a listen address names a relay but
 * `announceAddrs` is set. libp2p advertises ONLY the announce set then (the readme's "replaces the
 * advertised set entirely"), so the circuit address through the relay could never appear in
 * `node.getMultiaddrs()`, nobody could learn it, and every supervisor drive would time out waiting
 * for it: node creation would reject after a full drive deadline with a message about publishing
 * rather than about the configuration. `appendAnnounceAddrs` keeps the listener addresses and is fine.
 */
export function assertRelayAddrsAdvertisable(relays: readonly SupervisedRelay[], announceAddrs: readonly string[] | undefined): void {
	if (relays.length === 0 || announceAddrs === undefined || announceAddrs.length === 0) return;
	throw new Error(
		`listen address names a relay (${relays[0]!.dialAddr}) but announceAddrs replaces the advertised address set, so the circuit address through it could never be advertised — drop announceAddrs or use appendAnnounceAddrs`
	);
}

/**
 * Forget that a relay ever failed a reservation request, so the next request is actually made
 * rather than refused with "The relay was previously invalid".
 *
 * The store resets its filter when a reservation is removed while a pending slot exists, which a
 * bare listener always has, so this is a belt-and-braces step: the poisoning path this guards is a
 * failed request from libp2p's own relay discovery while the relay was down. Fails soft in every
 * direction; returns whether an entry was actually removed (for specs).
 */
export function clearRelayFilterEntry(store: RelayReservationStoreLike, relayPeerId: PeerId): boolean {
	const filter = store.relayFilter;
	if (typeof filter?.remove !== 'function') return false;
	try {
		return filter.remove(relayPeerId.toMultihash().bytes);
	} catch (err) {
		log('could not clear the relayFilter entry for %s: %o', relayPeerId.toString(), err);
		return false;
	}
}

/**
 * Re-send the request for the reservation the store holds on `relayPeerId`, over the connection it
 * was made on, so a relay that forgot it holds it again. A plain `addRelay` would not reach the
 * relay at all (see the `NOTE:` at {@link findCircuitRelayTransport}), so this first marks the held
 * reservation as expired. The address stays advertised throughout; if the relay refuses, libp2p
 * removes the reservation and withdraws the address, which is the truth then.
 *
 * Never throws. Resolves `null` once the store renewed the reservation, otherwise the reason it
 * did not — including that the store holds no reservation on the relay, in which case nothing is
 * requested. Takes no signal, as `addRelay` does not; a caller with a deadline races it.
 */
export async function forceReservationRenewal(store: RelayReservationStoreLike, relayPeerId: PeerId): Promise<string | null> {
	try {
		const held = store.getReservation(relayPeerId);
		if (held === undefined) return 'the store holds no reservation on the relay to renew';
		held.expire = 0n;
		await store.addRelay(relayPeerId, 'discovered');
		return null;
	} catch (err) {
		return `the renewal request failed: ${errorMessage(err)}`;
	}
}

/** Deadline for one drive: dial, reservation request and the wait for the address share it. */
export const DEFAULT_RELAY_DRIVE_TIMEOUT_MS = 10_000;
/** Gap between liveness checks while the reservation is held; a fallback in case an event is missed. */
export const DEFAULT_RELAY_CHECK_MS = 5_000;
/** Backoff before the first retry after a failed drive. */
export const DEFAULT_RELAY_MIN_BACKOFF_MS = 1_000;
/**
 * Backoff ceiling. It bounds recovery time after a long relay outage, because nothing else
 * reconnects a lone phone to its relay; a WebSocket dial every 30 s during an outage is cheap.
 */
export const DEFAULT_RELAY_MAX_BACKOFF_MS = 30_000;
/** How often a drive re-reads the address list while waiting for the address to be published. */
export const DEFAULT_RELAY_POLL_MS = 100;
/**
 * Gap between renewals of a held reservation. It bounds how long a relay that forgot the
 * reservation leaves the node unreachable; the cost is one RESERVE stream per supervised relay per
 * interval, far inside the relay's default two-hour reservation lifetime.
 */
export const DEFAULT_RELAY_RENEW_MS = 5 * 60_000;
/** Each renewal interval is `renewMs` ± this fraction, so many nodes on one relay do not renew in step. */
export const RELAY_RENEW_JITTER = 0.1;

export interface RelayReservationSupervisorOptions {
	/** Default {@link DEFAULT_RELAY_DRIVE_TIMEOUT_MS}. Also bounds one renewal. */
	driveTimeoutMs?: number;
	/** Default {@link DEFAULT_RELAY_CHECK_MS}. */
	checkMs?: number;
	/** Default {@link DEFAULT_RELAY_MIN_BACKOFF_MS}. */
	minBackoffMs?: number;
	/** Default {@link DEFAULT_RELAY_MAX_BACKOFF_MS}. */
	maxBackoffMs?: number;
	/** Default {@link DEFAULT_RELAY_POLL_MS}. */
	pollMs?: number;
	/** Default {@link DEFAULT_RELAY_RENEW_MS}; each interval is jittered by {@link RELAY_RENEW_JITTER}. */
	renewMs?: number;
}

/** A running supervisor for one node and one relay. Obtained from {@link superviseRelayReservation}. */
export interface RelayReservationSupervisor {
	readonly relay: SupervisedRelay;
	/**
	 * Settles once the first drive has: `null` when the reservation was held, otherwise the reason
	 * it was not. Also settles on {@link stop}, so an awaiting caller is never left hanging.
	 */
	readonly firstDrive: Promise<string | null>;
	/** Whether the node currently advertises a circuit address through this relay. Read live. */
	readonly held: boolean;
	/** True while a drive is in flight. */
	readonly driving: boolean;
	/** Epoch ms of the next scheduled check or retry; `null` while driving or once stopped. */
	readonly retryAtMs: number | null;
	/** Reason the last drive produced no reservation; `null` once one is held. */
	readonly lastError: string | null;
	/**
	 * Idempotent. Clears the pending timer, removes both event listeners, aborts an in-flight dial,
	 * and discards the result of an in-flight reservation request without starting anything after it.
	 */
	stop(): void;
}

/**
 * Keep asking `relay` for a reservation until one is held, then keep watching that it still is.
 *
 * Drives run on: the first tick, right away; libp2p's `self:peer:update` (the listener withdrew or
 * added addresses); `peer:connect` for this relay (a dial by anything on this node reconnected it,
 * which turns a partner's dial through the relay into an immediate re-reserve, and resets the
 * backoff); a liveness poll every `checkMs` while held; and a doubling backoff from `minBackoffMs`
 * to `maxBackoffMs` after a failed drive. Drives and renewals are serialized per relay: a trigger
 * that arrives mid-drive does nothing by itself, because every drive ends with the same re-check
 * and reschedule.
 *
 * "Held" is judged locally, from the addresses the node advertises, and a relay can forget a
 * reservation while the connection to it stays open. So while held, the supervisor also renews the
 * reservation every `renewMs`, jittered ({@link forceReservationRenewal}): the renewal is what
 * checks "held" against the relay. The renewal clock starts when a drive lands the reservation or a
 * tick first finds it held, and restarts after every renewal. A renewal the relay refuses withdraws
 * the address, and the supervisor drives again at once rather than after a backoff.
 *
 * `HadEnoughRelaysError` from the reservation store means this node's pending slot was already
 * filled with a reservation on a different relay (libp2p's relay discovery, see the accepted
 * tradeoff in `libp2p-node-base.ts`); it is logged once per episode and retried at the backoff cap, since it
 * recovers on its own only if that other reservation drops.
 */
export function superviseRelayReservation(
	node: Libp2p,
	relay: SupervisedRelay,
	opts: RelayReservationSupervisorOptions = {}
): RelayReservationSupervisor {
	return new RelayReservationLoop(node, relay, opts);
}

/** Every supervisor a node runs, with the two operations the node factory needs. */
export interface RelayReservationSupervisors {
	readonly supervisors: readonly RelayReservationSupervisor[];
	/** Resolves once every first drive held its reservation; rejects naming every relay that did not. */
	awaitFirstDrives(): Promise<void>;
	/** Stops every supervisor. Idempotent. */
	stop(): void;
}

/** One {@link superviseRelayReservation} per relay, started immediately. */
export function superviseRelayReservations(
	node: Libp2p,
	relays: readonly SupervisedRelay[],
	opts: RelayReservationSupervisorOptions = {}
): RelayReservationSupervisors {
	const supervisors = relays.map(relay => superviseRelayReservation(node, relay, opts));
	return {
		supervisors,
		async awaitFirstDrives(): Promise<void> {
			const outcomes = await Promise.all(supervisors.map(async s => ({ relay: s.relay, reason: await s.firstDrive })));
			const failed = outcomes.filter(o => o.reason !== null);
			if (failed.length === 0) return;
			throw new Error(failed.map(f => `could not reserve a circuit on relay ${f.relay.dialAddr}: ${f.reason}`).join('; '));
		},
		stop(): void {
			for (const s of supervisors) s.stop();
		}
	};
}

/** Sentinel resolved by the deadline race around `addRelay`, which takes no signal. */
const DEADLINE_PASSED = Symbol('relay-reservation-deadline-passed');

/** Milliseconds left until `deadline`, never negative. */
const remaining = (deadline: number): number => Math.max(0, deadline - Date.now());

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resolve after `ms`, on an unref'd timer. */
function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		unrefTimer(setTimeout(resolve, ms));
	});
}

/**
 * Settle with `work`'s outcome, or with {@link DEADLINE_PASSED} at `deadline`, whichever is first.
 * For work that takes no signal: the abandoned promise stays handled — `Promise.race` attaches
 * handlers to it — and its later outcome is ignored.
 */
async function raceDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_PASSED> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<typeof DEADLINE_PASSED>(resolve => {
		timer = setTimeout(() => resolve(DEADLINE_PASSED), remaining(deadline));
		unrefTimer(timer);
	});
	try {
		return await Promise.race([work, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** `ms` scaled by a uniform factor in `1 ± jitter`. */
const jittered = (ms: number, jitter: number): number => ms * (1 + (Math.random() * 2 - 1) * jitter);

/** The self-rescheduling loop behind {@link superviseRelayReservation}. */
class RelayReservationLoop implements RelayReservationSupervisor {
	readonly firstDrive: Promise<string | null>;

	private readonly relayPeerId: PeerId;
	private readonly driveTimeoutMs: number;
	private readonly checkMs: number;
	private readonly minBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly pollMs: number;
	private readonly renewMs: number;
	private backoffMs: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private inFlight = false;
	private nextTickAtMs: number | null = null;
	/** When the held reservation is next renewed; `null` while none is held. */
	private nextRenewAtMs: number | null = null;
	private failure: string | null = null;
	private dialAbort: AbortController | null = null;
	private slotTakenLogged = false;
	private settleFirstDrive: (reason: string | null) => void = () => {};
	private firstDriveSettled = false;

	constructor(
		private readonly node: Libp2p,
		readonly relay: SupervisedRelay,
		opts: RelayReservationSupervisorOptions
	) {
		this.relayPeerId = peerIdFromString(relay.peerId);
		// Clamped away from 0: a caller-supplied 0 would spin the loop hot.
		this.driveTimeoutMs = Math.max(1, opts.driveTimeoutMs ?? DEFAULT_RELAY_DRIVE_TIMEOUT_MS);
		this.checkMs = Math.max(1, opts.checkMs ?? DEFAULT_RELAY_CHECK_MS);
		this.minBackoffMs = Math.max(1, opts.minBackoffMs ?? DEFAULT_RELAY_MIN_BACKOFF_MS);
		this.maxBackoffMs = Math.max(this.minBackoffMs, opts.maxBackoffMs ?? DEFAULT_RELAY_MAX_BACKOFF_MS);
		this.pollMs = Math.max(1, opts.pollMs ?? DEFAULT_RELAY_POLL_MS);
		this.renewMs = Math.max(1, opts.renewMs ?? DEFAULT_RELAY_RENEW_MS);
		this.backoffMs = this.minBackoffMs;
		this.firstDrive = new Promise(resolve => {
			this.settleFirstDrive = resolve;
		});
		node.addEventListener('self:peer:update', this.onSelfPeerUpdate);
		node.addEventListener('peer:connect', this.onPeerConnect);
		void this.tick('start');
	}

	get held(): boolean {
		return this.node.getMultiaddrs().some(addr => routesThroughRelay(addr.toString(), this.relay.peerId, log));
	}

	get driving(): boolean {
		return this.inFlight;
	}

	get retryAtMs(): number | null {
		return this.nextTickAtMs;
	}

	get lastError(): string | null {
		return this.failure;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.clearTimer();
		this.nextTickAtMs = null;
		this.node.removeEventListener('self:peer:update', this.onSelfPeerUpdate);
		this.node.removeEventListener('peer:connect', this.onPeerConnect);
		this.dialAbort?.abort();
		this.settleFirst('the relay reservation supervisor was stopped before its first drive settled');
	}

	private readonly onSelfPeerUpdate = (): void => {
		this.wake('self:peer:update', false);
	};

	private readonly onPeerConnect = (evt: CustomEvent<PeerId>): void => {
		if (!evt.detail.equals(this.relayPeerId)) return;
		this.wake('peer:connect', true);
	};

	/**
	 * Something may have changed the reservation: re-check now. Mid-drive, only the backoff reset
	 * takes effect — the drive's own tail re-checks and reschedules, so nothing is lost.
	 */
	private wake(trigger: string, resetBackoff: boolean): void {
		if (this.stopped) return;
		if (resetBackoff) this.backoffMs = this.minBackoffMs;
		if (this.inFlight) return;
		this.clearTimer();
		void this.tick(trigger);
	}

	private async tick(trigger: string): Promise<void> {
		if (this.stopped || this.inFlight) return;
		this.nextTickAtMs = null;
		if (!this.held) {
			await this.driveAndSettle(trigger);
			return;
		}
		if (!this.renewalDue()) {
			this.onHeld();
			return;
		}
		await this.renewOnce();
		// A trigger that ran in the gap after the renewal already re-checked and owns the loop now.
		if (this.stopped || this.inFlight) return;
		if (this.held) {
			this.onHeld();
			return;
		}
		// The relay refused the renewal and libp2p withdrew the address. The refusal is already the
		// evidence a backoff would wait for, so ask again at once.
		await this.driveAndSettle('renew-failed');
	}

	private async driveAndSettle(trigger: string): Promise<void> {
		// Whatever this drive lands is a fresh reservation, whose renewal clock starts when it lands.
		this.nextRenewAtMs = null;
		await this.driveOnce(trigger);
		if (this.stopped) return;
		// A drive that landed the reservation resumes the healthy cadence at once; backing off here
		// would leave the first liveness check after a long outage a fully grown backoff away.
		if (this.held) {
			this.onHeld();
			return;
		}
		this.scheduleBackoff();
	}

	/** Healthy tick: nothing to request, so only reset and re-check later, or renew when that is sooner. */
	private onHeld(): void {
		this.backoffMs = this.minBackoffMs;
		this.failure = null;
		// Once held, a later slot-taken episode is a new event and deserves its own log line.
		this.slotTakenLogged = false;
		this.settleFirst(null);
		const renewAtMs = this.nextRenewAtMs ?? this.armRenewal();
		this.schedule(Math.min(this.checkMs, Math.max(0, renewAtMs - Date.now())));
	}

	private renewalDue(): boolean {
		return this.nextRenewAtMs !== null && Date.now() >= this.nextRenewAtMs;
	}

	/** Start the renewal clock over from now; returns when the next renewal is due. */
	private armRenewal(): number {
		const renewAtMs = Date.now() + jittered(this.renewMs, RELAY_RENEW_JITTER);
		this.nextRenewAtMs = renewAtMs;
		return renewAtMs;
	}

	/** One renewal, logged; the renewal clock restarts after it whatever the outcome. */
	private async renewOnce(): Promise<void> {
		this.inFlight = true;
		try {
			const reason = await this.renew();
			if (this.stopped) return;
			if (reason === null) {
				log('relay-reservation:renewed relay=%s', this.relay.dialAddr);
			} else {
				log.error('relay-reservation:renew-failed relay=%s reason=%s', this.relay.dialAddr, reason);
			}
		} catch (err) {
			// `renew` is fail-soft by contract; as in `driveOnce`, the loop survives it breaking.
			log.error('relay-reservation:renew-failed relay=%s reason=%s', this.relay.dialAddr, errorMessage(err));
		} finally {
			this.inFlight = false;
			if (!this.stopped) this.armRenewal();
		}
	}

	/** One renewal under one deadline. Never throws; returns `null` when the store renewed the reservation. */
	private async renew(): Promise<string | null> {
		const transport = findCircuitRelayTransport(this.node);
		if (transport === null) {
			return 'the node has no circuit-relay transport — add circuitRelayTransport() to transports';
		}
		const deadline = Date.now() + this.driveTimeoutMs;
		clearRelayFilterEntry(transport.reservationStore, this.relayPeerId);
		const outcome = await raceDeadline(forceReservationRenewal(transport.reservationStore, this.relayPeerId), deadline);
		if (outcome === DEADLINE_PASSED) {
			return `the renewal request did not complete within ${this.driveTimeoutMs}ms`;
		}
		return outcome;
	}

	private async driveOnce(trigger: string): Promise<void> {
		this.inFlight = true;
		log('relay-reservation:drive relay=%s trigger=%s', this.relay.dialAddr, trigger);
		try {
			const reason = await this.drive();
			if (this.stopped) return;
			this.failure = reason;
			if (reason === null) {
				log('relay-reservation:held relay=%s', this.relay.dialAddr);
			} else {
				log.error('relay-reservation:failed relay=%s reason=%s', this.relay.dialAddr, reason);
			}
		} catch (err) {
			// `drive` is fail-soft by contract, so reaching here means that contract broke. The loop
			// must survive it anyway: an escaping rejection would leave `firstDrive` pending forever
			// and schedule no further attempt, which is the failure this supervisor exists to prevent.
			const message = errorMessage(err);
			log.error('relay-reservation:drive-threw relay=%s err=%s', this.relay.dialAddr, message);
			if (!this.stopped) this.failure = message;
		} finally {
			this.inFlight = false;
			if (!this.stopped) this.settleFirst(this.failure);
		}
	}

	/** One attempt under one deadline. Never throws; returns `null` when the address is held afterwards. */
	private async drive(): Promise<string | null> {
		const transport = findCircuitRelayTransport(this.node);
		if (transport === null) {
			return 'the node has no circuit-relay transport — add circuitRelayTransport() to transports';
		}
		const deadline = Date.now() + this.driveTimeoutMs;
		clearRelayFilterEntry(transport.reservationStore, this.relayPeerId);
		const dialFailure = await this.dialRelay(deadline);
		if (dialFailure !== null) return dialFailure;
		if (this.stopped) return 'stopped';
		const requestFailure = await this.requestReservation(transport.reservationStore, deadline);
		if (requestFailure !== null) return requestFailure;
		if (await this.waitUntilHeld(deadline)) return null;
		return `relay ${this.relay.dialAddr} granted a reservation but no circuit address through it was published within ${this.driveTimeoutMs}ms`;
	}

	/**
	 * Dial the relay, or return why that failed. An explicit controller rather than
	 * `AbortSignal.timeout`, which is unreliable on Hermes; {@link stop} aborts it too.
	 */
	private async dialRelay(deadline: number): Promise<string | null> {
		const controller = new AbortController();
		this.dialAbort = controller;
		const timer = setTimeout(() => controller.abort(), remaining(deadline));
		unrefTimer(timer);
		try {
			await this.node.dial(multiaddr(this.relay.dialAddr), { signal: controller.signal });
			return null;
		} catch (err) {
			return `dial to relay ${this.relay.dialAddr} failed: ${errorMessage(err)}`;
		} finally {
			clearTimeout(timer);
			this.dialAbort = null;
		}
	}

	/**
	 * Ask the store for a `discovered` reservation on the relay, raced against the deadline because
	 * `addRelay` takes no signal. `'discovered'`, never `'configured'`: only a `discovered`
	 * reservation is published by the bare listener the plan gave libp2p. A concurrent `addRelay`
	 * for the same relay from libp2p's own discovery joins the same queue job, so there is no
	 * double reservation.
	 */
	private async requestReservation(store: RelayReservationStoreLike, deadline: number): Promise<string | null> {
		try {
			const outcome = await raceDeadline(store.addRelay(this.relayPeerId, 'discovered'), deadline);
			if (outcome === DEADLINE_PASSED) {
				return `reservation request to relay ${this.relay.dialAddr} did not complete within ${this.driveTimeoutMs}ms`;
			}
			return null;
		} catch (err) {
			return this.describeReservationFailure(err);
		}
	}

	/** Turn the store's rejection into a reason that names the cause, and apply its consequence. */
	private describeReservationFailure(err: unknown): string {
		const name = err instanceof Error ? err.name : '';
		switch (name) {
			case 'HadEnoughRelaysError': {
				// The pending slot the bare listener registered is already filled, by a reservation on
				// some other relay. Nothing this supervisor does frees it, so retry only at the cap.
				this.backoffMs = this.maxBackoffMs;
				const reason = `this node's pending circuit slot is already filled by a reservation on another relay, so relay ${this.relay.dialAddr} was not asked; retrying every ${this.maxBackoffMs}ms until that reservation drops`;
				if (!this.slotTakenLogged) {
					this.slotTakenLogged = true;
					log.error('relay-reservation:slot-taken relay=%s', this.relay.dialAddr);
				}
				return reason;
			}
			case 'UnsupportedProtocolError':
				return `the peer at ${this.relay.dialAddr} does not serve the circuit-relay hop protocol, so it is not a relay`;
			default:
				return `reservation request to relay ${this.relay.dialAddr} failed: ${errorMessage(err)}`;
		}
	}

	/** `addRelay` resolving means the relay accepted; the listener publishes the address a tick later. */
	private async waitUntilHeld(deadline: number): Promise<boolean> {
		for (;;) {
			if (this.held) return true;
			if (this.stopped || Date.now() >= deadline) return false;
			await delay(Math.min(this.pollMs, remaining(deadline)));
		}
	}

	private scheduleBackoff(): void {
		const wait = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
		this.schedule(wait);
	}

	private schedule(ms: number): void {
		if (this.stopped) return;
		this.clearTimer();
		this.nextTickAtMs = Date.now() + ms;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick('timer');
		}, ms);
		unrefTimer(this.timer);
	}

	private clearTimer(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
	}

	private settleFirst(reason: string | null): void {
		if (this.firstDriveSettled) return;
		this.firstDriveSettled = true;
		this.settleFirstDrive(reason);
	}
}
