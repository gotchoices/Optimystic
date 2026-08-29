/**
 * The single place in `db-p2p` that registers a libp2p protocol handler.
 *
 * The mirror image of `./open-protocol-stream.ts`. Opening a stream over a *limited* (circuit-relay)
 * connection needs BOTH sides to opt in, and libp2p checks each side against its own options:
 *
 * - the dialer's `newStream` / `dialProtocol` options (`libp2p/src/connection.ts`, outbound path), and
 * - the options the *answering* peer passed when it registered the handler
 *   (`libp2p/src/connection.ts`, incoming path — it reads back
 *   `registrar.getHandler(protocol).options.runOnLimitedConnection`).
 *
 * Miss either one and libp2p throws `LimitedConnectionError`. On the answering side it does so
 * *after* multistream-select has already acknowledged the protocol, so the dialer's stream open
 * appears to succeed and the stream is then reset with no reply — indistinguishable, from the
 * dialer's seat, from a peer that simply does not hold the data. Every peer reachable only through
 * a capped relay (phones, browsers, machines behind a home router) silently drops out.
 *
 * `openProtocolStream` fixed the dialling half; this fixes the answering half. As there, the flag is
 * deliberately NOT an option: a new protocol gets relay support without its author needing to know
 * the flag exists, and `test/dial-options-single-site.spec.ts` fails the build if a second source
 * file calls `.handle(...)` directly.
 *
 * Accepting the stream is necessary but not sufficient. A stock relay also caps the *whole* relayed
 * connection — `applyDefaultLimit: true` stamps `Limit { data: 128 KiB, duration: 2 min }` on every
 * reservation — so a relay-only peer now answers, but the circuit is reset once either cap is hit,
 * which one cohort frame (`DEFAULT_STREAM_MAX_BYTES`, 512 KiB) can do on its own. Lifting that is
 * the relay operator's knob, not this one: see `NodeOptions.relayServerInit` in `libp2p-node-base.ts`.
 *
 * Imports here are type-only on purpose: this module is reachable from the react-native entry
 * (`src/rn.ts`), which must not pull node-specific code.
 */

import type { StreamHandler, StreamHandlerOptions, StreamMiddleware } from "@libp2p/interface";

/**
 * Anything that can register a libp2p protocol handler.
 *
 * Both shapes in this package satisfy it: a `Libp2p` node (`node.handle(...)`) and the `registrar`
 * component the service classes are constructed with (`components.registrar.handle(...)`).
 */
export interface ProtocolRegistrar {
	handle(protocol: string, handler: StreamHandler, options?: StreamHandlerOptions): Promise<void>;
}

/**
 * The per-protocol settings that legitimately vary. `runOnLimitedConnection` is absent on purpose —
 * it is a constant of this helper, not a caller's choice.
 */
export interface RegisterProtocolHandlerOptions {
	/** Concurrent inbound streams allowed per connection. Omit for libp2p's default (32). */
	maxInboundStreams?: number;
	/** Concurrent outbound streams allowed per connection. Omit for libp2p's default (64). */
	maxOutboundStreams?: number;
	/** Stream middleware, run around the handler. Omit for none. */
	middleware?: StreamMiddleware[];
	/** Replace an existing registration for this protocol instead of rejecting. */
	force?: true;
	/** Forwarded to libp2p so a caller's deadline cancels the registration. */
	signal?: AbortSignal;
}

/**
 * Register `handler` for `protocol`, accepting streams over limited (relay) connections.
 *
 * Rejects if the registrar rejects — a duplicate protocol id, or an aborted signal. Callers that
 * register fire-and-forget (`void registerProtocolHandler(...)`) keep that behaviour; see the NOTE
 * in `libp2p-node-base.ts` about the reactivity handlers.
 */
export async function registerProtocolHandler(
	target: ProtocolRegistrar,
	protocol: string,
	handler: StreamHandler,
	options?: RegisterProtocolHandlerOptions,
): Promise<void> {
	// Keys are OMITTED rather than set to `undefined` when the caller did not supply them, so
	// libp2p applies its own defaults instead of seeing an explicit `undefined`.
	await target.handle(protocol, handler, {
		runOnLimitedConnection: true,
		...(options?.maxInboundStreams !== undefined ? { maxInboundStreams: options.maxInboundStreams } : {}),
		...(options?.maxOutboundStreams !== undefined ? { maxOutboundStreams: options.maxOutboundStreams } : {}),
		...(options?.middleware !== undefined ? { middleware: options.middleware } : {}),
		...(options?.force !== undefined ? { force: options.force } : {}),
		...(options?.signal !== undefined ? { signal: options.signal } : {}),
	});
}
