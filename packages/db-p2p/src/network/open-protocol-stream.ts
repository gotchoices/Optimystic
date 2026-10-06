/**
 * The single place in `db-p2p` that opens a libp2p protocol stream.
 *
 * libp2p refuses to open a protocol stream over a *limited* (circuit-relay) connection unless the
 * caller opts in with `runOnLimitedConnection: true`. Omitting it produces no compile error and no
 * obvious failure — only "that peer never answers" — so every peer reachable only through a relay
 * (the steady state for browsers, phones, and NATed peers) silently drops out. The flag is
 * deliberately NOT an option here: a new call site gets relay support without its author needing to
 * know the flag exists, and `test/dial-options-single-site.spec.ts` fails the build if a second
 * source file calls `dialProtocol` / `newStream` directly.
 *
 * **One dead connection must not strand a peer** (GitHub #32). A *half-open* connection is one the
 * remote has already dropped while this side still lists it as `open` — routine with
 * `@libp2p/websockets` <= 10.1.21, whose reset on abort never reaches the far side. A stream open on
 * it sends the multistream-select proposal and waits for an acknowledgement that never comes, and
 * until libp2p's connection monitor pinged it out (ten seconds and more) every request that picked it
 * ran out its deadline, with a second, live connection to the same peer sitting unused beside it. So
 * {@link openProtocolStream} runs a race over an ordered list of *paths* — every open connection to
 * the peer, direct before relayed and newest first within each group, then a fresh dial — and:
 *
 * - **hedges**: when the open on the latest path has not completed within the hedge delay, the next
 *   path is started WITHOUT cancelling the earlier one, so a merely slow connection keeps its chance
 *   and a short hedge costs at most one extra stream negotiation, never a live connection. A path
 *   that fails outright (a reset, a refused pre-dial check, a failed dial) advances at once. The
 *   first stream to open wins; a stream a losing path opens later is closed, and a fresh dial still
 *   in flight is cancelled.
 * - **condemns**: a connection whose stream open stays pending for the whole dead-connection delay
 *   is aborted (`connection.abort`, never the graceful `close`, which would itself wait on the dead
 *   peer) and reported once as `open-stream:connection-dead`, so the next request does not choose
 *   it. The judgment runs on its own timer, never on the caller's signal: a caller's 1 s
 *   cohort-consult deadline is no evidence that a connection is dead, so an open on an existing
 *   connection keeps running for the dead-connection delay after the caller has its answer or has
 *   given up, and nothing outlives that delay. It is the judgment libp2p's connection monitor
 *   already makes (a ping unanswered within its timeout aborts the connection), made sooner and on
 *   evidence the request path holds anyway.
 *
 * Both delays come from the declared link round trip ({@link StreamOpenDeadlines} in
 * `rpc-deadline.ts`, which also records the slow-link residual). The common case — one healthy
 * connection — is one `newStream` call; the hedge and condemnation timers it arms are cleared the
 * moment it opens. The caller's signal keeps its contract: a signal already aborted rejects with its
 * reason before anything is touched, and one that fires later rejects the open with that reason.
 *
 * NOTE: accepted tradeoff — this duplicates FRET's `rpc/protocols.ts#openRpcStream` (exported since
 * `p2p-fret@1.0.0-beta.3`) rather than delegating to it. FRET's helper pins `negotiateFully: false`
 * with no way to opt out, and `cohort-topic/stream-util.ts` deliberately does not set that option
 * (see the NOTE at its call sites); adopting FRET's would silently reverse a decision a human
 * already made. It also has no hook for the pre-dial check `libp2p-key-network.ts#connect` runs,
 * and no fallback across connections. Revisit — and delete this module in favour of
 * `openRpcStream` — if FRET ever parameterizes `negotiateFully` and hedges the same way.
 *
 * Imports here are type-only or pure (`rpc-deadline.ts`, `unref-timer.ts`, `logger.ts`) on purpose:
 * this module is reachable from the react-native entry (`src/rn.ts`) via `libp2p-key-network.ts`,
 * which must not pull node-specific code.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { UNDECLARED_STREAM_OPEN_DEADLINES, type StreamOpenDeadlines } from "../rpc-deadline.js";
import { unrefTimer } from "../unref-timer.js";
import { createLogger } from "../logger.js";

/** Where {@link openProtocolStream} reports; `Libp2pKeyPeerNetwork` passes its peer-id-suffixed logger. */
export type StreamOpenLog = (fmt: string, ...args: unknown[]) => void;

const moduleLog: StreamOpenLog = createLogger("open-protocol-stream");

export interface OpenProtocolStreamOptions {
	/**
	 * The caller's deadline. One already aborted rejects the open with its reason before any
	 * connection is touched; one that fires while the open runs rejects it with that reason and
	 * cancels a fresh dial in flight. It does NOT end a stream open on an existing connection: that
	 * runs to the dead-connection delay on its own timer, because whether the connection is dead is
	 * not for the caller's deadline to say (see the module docblock).
	 */
	signal?: AbortSignal;
	/**
	 * Omit for libp2p's default (full multistream-select negotiation at stream-open).
	 * Pass `false` to ask libp2p not to wait for the remote's acknowledgement, accepting that an
	 * unsupported-protocol failure is deferred to the first read — only safe when the caller always
	 * reads a reply. `@libp2p/multistream-select@7` ignores it, so today the stream open costs one
	 * round trip either way (`test/stream-open-costs-a-round-trip.spec.ts`).
	 */
	negotiateFully?: boolean;
	/**
	 * Runs immediately before a FRESH dial, and never on the connection-reuse paths.
	 * Throwing fails the dial path, which fails the open once every connection path has failed too.
	 * This is the seam for checks that are only meaningful when no connection exists yet (see
	 * `libp2p-key-network.ts#assertNotSelfRelayOnly`).
	 */
	beforeDial?: () => Promise<void> | void;
	/**
	 * The hedge and dead-connection delays — a node's `LinkDeadlines` where the caller has them;
	 * {@link UNDECLARED_STREAM_OPEN_DEADLINES} when omitted.
	 */
	deadlines?: StreamOpenDeadlines;
	/** Receives `open-stream:connection-dead`; the module's own `open-protocol-stream` logger when omitted. */
	log?: StreamOpenLog;
}

/** `.code` on {@link DeadConnectionError}. */
export const DEAD_CONNECTION_ERROR_CODE = "CONNECTION_DEAD";

/**
 * The reason a connection is aborted when a stream open on it stayed pending for the whole
 * dead-connection delay, and what the open on that path rejects with. When every path fails and
 * the preferred connection was the dead one, this is what {@link openProtocolStream} rejects with.
 */
export class DeadConnectionError extends Error {
	readonly code = DEAD_CONNECTION_ERROR_CODE;
	constructor(peer: string, protocol: string, connectionId: string, pendingMs: number) {
		super(`stream open for ${protocol} on connection ${connectionId} to ${peer} stayed pending for ${pendingMs}ms: connection aborted as dead`);
		this.name = "DeadConnectionError";
	}
}

/** The reason a fresh dial still in flight is cancelled with once another path has opened the stream. */
class StreamOpenedElsewhereError extends Error {
	constructor(peer: string, protocol: string) {
		super(`stream for ${protocol} to ${peer} opened on another connection; this dial is no longer needed`);
		this.name = "StreamOpenedElsewhereError";
	}
}

/**
 * True for a circuit-relay ("limited") connection: libp2p stamps one with per-circuit `limits`
 * (data/duration caps); sniffing `/p2p-circuit` in the remote multiaddr covers transports and
 * versions that leave `limits` unpopulated.
 */
export function isLimitedConnection(c: Connection): boolean {
	if (c.limits != null) return true;
	return c.remoteAddr?.toString?.().includes("/p2p-circuit") ?? false;
}

/**
 * Open `protocol` to `peer`: on an existing open connection where one answers, else on a fresh dial.
 *
 * Skips connections libp2p has not yet evicted from its index but that are no longer open, prefers a
 * direct connection over a relayed one — a relayed connection can be reset once the relay's
 * per-circuit cap or reservation lapses, and after DCUtR upgrades a link to direct both briefly
 * coexist — and falls back across every open connection, then a fresh dial, as the module docblock
 * describes. Rejects with the caller's own abort reason when its signal fired first; otherwise, once
 * every path has failed, with the first path's error, since the preferred connection's failure says
 * the most about the peer (a later path's dial failure says only that no new connection could be
 * made either).
 */
export async function openProtocolStream(
	node: Libp2p,
	peer: PeerId,
	protocol: string,
	options?: OpenProtocolStreamOptions,
): Promise<Stream> {
	// Before touching connections: a caller that has already given up is owed its own reason,
	// not whatever libp2p would report several layers down.
	options?.signal?.throwIfAborted();
	return await new StreamOpenRace(node, peer, protocol, options).run();
}

type OpenPath =
	| { readonly kind: "connection"; readonly connection: Connection }
	| { readonly kind: "dial" };

/**
 * The paths to try, in order: every open connection to the peer, direct before limited, newest first
 * within each group, then a fresh dial. Newest first is a tie-break, not the fix: a re-dial usually
 * replaces a connection that failed, but a fresh connection can be the dead one too (the field case),
 * and the hedge is what covers that.
 */
function orderedPaths(node: Libp2p, peer: PeerId): OpenPath[] {
	const conns = node.getConnections?.(peer) ?? [];
	const open = conns.filter(c => c?.status === "open" && typeof c?.newStream === "function");
	const newestFirst = (a: Connection, b: Connection): number => (b.timeline?.open ?? 0) - (a.timeline?.open ?? 0);
	const direct = open.filter(c => !isLimitedConnection(c)).sort(newestFirst);
	const limited = open.filter(c => isLimitedConnection(c)).sort(newestFirst);
	return [
		...[...direct, ...limited].map(connection => ({ kind: "connection" as const, connection })),
		{ kind: "dial" as const },
	];
}

/** One path's stream open in flight. */
interface Attempt {
	readonly path: OpenPath;
	/** Aborts this path's stream open alone. */
	readonly controller: AbortController;
	readonly startedAt: number;
	settled: boolean;
	failure?: { readonly error: unknown };
	/** Armed on a connection path only: fires {@link StreamOpenRace.condemn}. */
	condemnTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The race one {@link openProtocolStream} call runs: paths started in order, each hedged by the next,
 * settled once by the first stream to open, the caller's abort, or the last path's failure.
 */
class StreamOpenRace {
	private readonly paths: OpenPath[];
	private readonly attempts: Attempt[] = [];
	private readonly deadlines: StreamOpenDeadlines;
	private readonly log: StreamOpenLog;
	private hedgeTimer?: ReturnType<typeof setTimeout>;
	private done = false;
	private settle!: { resolve(stream: Stream): void; reject(err: unknown): void };
	private readonly onCallerAbort = (): void => this.finish({ failed: this.options?.signal?.reason });

	constructor(
		private readonly node: Libp2p,
		private readonly peer: PeerId,
		private readonly protocol: string,
		private readonly options: OpenProtocolStreamOptions | undefined,
	) {
		this.paths = orderedPaths(node, peer);
		this.deadlines = options?.deadlines ?? UNDECLARED_STREAM_OPEN_DEADLINES;
		this.log = options?.log ?? moduleLog;
	}

	run(): Promise<Stream> {
		return new Promise<Stream>((resolve, reject) => {
			this.settle = { resolve, reject };
			this.options?.signal?.addEventListener("abort", this.onCallerAbort, { once: true });
			this.startNext();
		});
	}

	/** Start the next path, and hedge it: if it has not opened within the hedge delay, start the one after. */
	private startNext(): void {
		this.clearHedge();
		if (this.done) return;
		const path = this.paths[this.attempts.length];
		if (path === undefined) return;
		void this.attempt(path);
		if (this.attempts.length < this.paths.length) {
			this.hedgeTimer = setTimeout(() => this.startNext(), this.deadlines.hedgeDelayMs);
		}
	}

	private async attempt(path: OpenPath): Promise<void> {
		const attempt: Attempt = { path, controller: new AbortController(), startedAt: Date.now(), settled: false };
		this.attempts.push(attempt);
		try {
			const stream = await this.open(attempt);
			this.settled(attempt);
			// A stream opened after another path won is nobody's: close it.
			if (this.done) discardStream(stream);
			else this.finish({ won: stream });
		} catch (error) {
			this.settled(attempt);
			attempt.failure = { error };
			this.advanceAfterFailure(attempt);
		}
	}

	private async open(attempt: Attempt): Promise<Stream> {
		// `negotiateFully` is OMITTED rather than set to `undefined` when the caller did not supply it,
		// so libp2p applies its own default instead of seeing an explicit `undefined`. A signal is
		// always passed: without one libp2p runs its own negotiation timeout, which would judge the
		// connection on a deadline this module does not control.
		const streamOptions = {
			runOnLimitedConnection: true,
			...(this.options?.negotiateFully !== undefined ? { negotiateFully: this.options.negotiateFully } : {}),
			signal: attempt.controller.signal,
		};
		if (attempt.path.kind === "connection") {
			this.armCondemnation(attempt);
			return await attempt.path.connection.newStream([this.protocol], streamOptions);
		}
		await this.options?.beforeDial?.();
		// The caller may have given up, or another path may have won, while the pre-dial check ran.
		attempt.controller.signal.throwIfAborted();
		// `force`: without it libp2p's dialer hands back an existing connection — most likely the one
		// every connection path is already waiting on.
		return await this.node.dialProtocol(this.peer, [this.protocol], { ...streamOptions, force: true });
	}

	private settled(attempt: Attempt): void {
		attempt.settled = true;
		if (attempt.condemnTimer !== undefined) clearTimeout(attempt.condemnTimer);
	}

	/**
	 * A failed path advances at once rather than waiting out the hedge: when it was the latest path
	 * started, the hedge timer was guarding it against slowness, and there is nothing left to guard.
	 * An earlier path failing while a later one is pending changes nothing — the later one is already
	 * the hedge against it. When no path is left and every attempt has settled, the open has failed.
	 */
	private advanceAfterFailure(attempt: Attempt): void {
		if (this.done) return;
		const latest = attempt === this.attempts[this.attempts.length - 1];
		if (latest && this.attempts.length < this.paths.length) {
			this.startNext();
		} else if (this.attempts.every(a => a.settled)) {
			this.finish({ failed: this.firstFailure() });
		}
	}

	/** The error of the first path in order, which is the preferred connection's when one existed. */
	private firstFailure(): unknown {
		return this.attempts.find(a => a.failure !== undefined)?.failure?.error;
	}

	private armCondemnation(attempt: Attempt): void {
		// Unref'd: this timer deliberately outlives the request that armed it, and a process on its
		// way out owes a dead connection nothing.
		attempt.condemnTimer = unrefTimer(setTimeout(() => this.condemn(attempt), this.deadlines.deadConnectionDelayMs));
	}

	/**
	 * The stream open on this connection has been pending for the whole dead-connection delay: end
	 * the attempt and abort the connection, so the next open does not choose it. Reported once per
	 * connection — one that another race, or libp2p's own monitor, has already aborted is no longer
	 * `open` and is left alone.
	 */
	private condemn(attempt: Attempt): void {
		if (attempt.settled || attempt.path.kind !== "connection") return;
		const { connection } = attempt.path;
		const pendingMs = Date.now() - attempt.startedAt;
		const peer = this.peer.toString();
		const err = new DeadConnectionError(peer, this.protocol, connection.id, pendingMs);
		attempt.controller.abort(err);
		if (connection.status !== "open" || typeof connection.abort !== "function") return;
		connection.abort(err);
		this.log(
			"open-stream:connection-dead peer=%s protocol=%s connection=%s direction=%s limited=%s pendingMs=%d",
			peer.substring(0, 12), this.protocol, connection.id, connection.direction, isLimitedConnection(connection), pendingMs,
		);
	}

	/** Settle the open once: the winner, the caller's abort reason, or the first path's failure. */
	private finish(outcome: { won: Stream } | { failed: unknown }): void {
		if (this.done) return;
		this.done = true;
		this.clearHedge();
		this.options?.signal?.removeEventListener("abort", this.onCallerAbort);
		// A fresh dial still in flight is cancelled: nothing is learned by letting it finish. An open
		// on an existing connection is left to its own timer (see `condemn`).
		const cancelReason = "won" in outcome ? new StreamOpenedElsewhereError(this.peer.toString(), this.protocol) : outcome.failed;
		for (const attempt of this.attempts) {
			if (!attempt.settled && attempt.path.kind === "dial") attempt.controller.abort(cancelReason);
		}
		if ("won" in outcome) this.settle.resolve(outcome.won);
		else this.settle.reject(outcome.failed);
	}

	private clearHedge(): void {
		if (this.hedgeTimer === undefined) return;
		clearTimeout(this.hedgeTimer);
		this.hedgeTimer = undefined;
	}
}

/** Close a stream nobody will use (opened by a path that lost); a close that fails is aborted instead. */
function discardStream(stream: Stream): void {
	void stream.close().catch((err: unknown) => {
		stream.abort?.(err instanceof Error ? err : new Error(String(err)));
	});
}
