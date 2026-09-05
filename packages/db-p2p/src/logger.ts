import { base32 } from 'multiformats/bases/base32'
import { base58btc } from 'multiformats/bases/base58'
import { base64 } from 'multiformats/bases/base64'
import debug from 'debug'
import type { PeerId } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { CID } from 'multiformats/cid'

const BASE_NAMESPACE = 'optimystic:db-p2p'

/*
 * Format specifiers, ported from `@libp2p/logger`'s `src/index.ts` (MIT, same license as this
 * repo). Call sites in this package log lines like `'error handling X from %p - %e'`; those used
 * to reach libp2p's own logger, which registers these. Without the port they would print the
 * literal text `%p` / `%e`.
 *
 * NOTE: these are registered on the `debug` module instance THIS file imports. libp2p's own
 * loggers use `weald` (via @libp2p/logger) and carry their own copy — the two registries are
 * independent, and enabling one from test code does not enable the other.
 *
 * `%k` (`interface-datastore`'s `Key`) is deliberately NOT ported: `interface-datastore` is not a
 * declared dependency of this package and no call site formats one. Add it if that changes.
 */

// Add a formatter for converting to a base58 string
debug.formatters['b'] = (v?: Uint8Array): string => {
	return v == null ? 'undefined' : base58btc.baseEncode(v)
}

// Add a formatter for converting to a base32 string
debug.formatters['t'] = (v?: Uint8Array): string => {
	return v == null ? 'undefined' : base32.baseEncode(v)
}

// Add a formatter for converting to a base64 string
debug.formatters['m'] = (v?: Uint8Array): string => {
	return v == null ? 'undefined' : base64.baseEncode(v)
}

// Add a formatter for stringifying peer ids
debug.formatters['p'] = (v?: PeerId): string => {
	return v == null ? 'undefined' : v.toString()
}

// Add a formatter for stringifying CIDs
debug.formatters['c'] = (v?: CID): string => {
	return v == null ? 'undefined' : v.toString()
}

// Add a formatter for stringifying Multiaddrs
debug.formatters['a'] = (v?: Multiaddr): string => {
	return v == null ? 'undefined' : v.toString()
}

function notEmpty(str?: string): string | undefined {
	if (str == null) {
		return
	}

	str = str.trim()

	if (str.length === 0) {
		return
	}

	return str
}

function formatError(v: Error, indent = ''): string {
	const message = notEmpty(v.message)
	const stack = notEmpty(v.stack)

	// some browser errors (mostly from Firefox) have no message or no stack,
	// sometimes both, sometimes neither. Sometimes the message is in the stack,
	// sometimes it isn't so try to do *something* useful
	if (message != null && stack != null) {
		if (stack.includes(message)) {
			return `${stack.split('\n').join(`\n${indent}`)}`
		}

		return `${message}\n${indent}${stack.split('\n').join(`\n${indent}`)}`
	}

	if (stack != null) {
		return `${stack.split('\n').join(`\n${indent}`)}`
	}

	if (message != null) {
		return `${message}`
	}

	return `${v.toString()}`
}

function isAggregateError(err?: any): err is AggregateError {
	return err instanceof AggregateError || (err?.name === 'AggregateError' && Array.isArray(err.errors))
}

function printError(err: Error, indent = ''): string {
	if (isAggregateError(err)) {
		let output = formatError(err, indent)

		if (err.errors.length > 0) {
			indent = `${indent}    `

			output += `\n${indent}${err.errors
				.map(err => `${printError(err, `${indent}`)}`)
				.join(`\n${indent}`)
			}`
		} else {
			output += `\n${indent}[Error list was empty]`
		}

		return output.trim()
	}

	return formatError(err, indent)
}

// Add a formatter for stringifying Errors.
//
// A call site can hand `%e` anything — `catch (err)` binds `unknown`, and this package's `%e` sites
// are all in catch blocks. This must never throw: a logger that throws turns a caught error into an
// uncaught one at exactly the site that was trying to report it.
//
// The try/catch is a deliberate deviation from the upstream `@libp2p/logger` port. `formatError`'s
// last resort is `${v.toString()}`, which raises for the two values that have no usable primitive
// conversion — a null-prototype object (`throw Object.create(null)`) and a symbol. Upstream has the
// same hole; here the stated contract is "never throw", so the fallback is explicit.
debug.formatters['e'] = (v?: Error): string => {
	if (v == null) {
		return 'undefined'
	}

	try {
		return printError(v)
	} catch {
		return '[unformattable error]'
	}
}

/**
 * A `debug` channel plus the severity sub-channels libp2p's own `Logger` exposes, so a call site
 * can be moved between the two factories without changing what it calls.
 *
 * `error` and `trace` are ordinary child namespaces (`<namespace>:error`), so a wildcard filter
 * the operator already uses — `optimystic:db-p2p:*` — keeps matching them. An EXACT-match filter
 * (`DEBUG=optimystic:db-p2p:repo-service`) does not; that is the same caveat the peer-id suffix
 * already carries, and `docs/debugging.md` already documents it.
 *
 * Unlike libp2p we do NOT conditionally stub out `trace`: libp2p builds a no-op unless a `:trace`
 * namespace is explicitly enabled, but a disabled `debug` channel is already near-free, and the
 * conditional version reads its enablement once at construction — wrong for anything built before
 * `DEBUG` is set. `newScope` is deliberately omitted; `createLogger('parent:child')` says the same
 * thing and nothing calls it.
 */
export interface Logger extends debug.Debugger {
	error: debug.Debugger
	trace: debug.Debugger
}

/**
 * Build a `debug` logger under `optimystic:db-p2p:<subNamespace>`, optionally suffixed with the
 * owning node's peer id (`:<first 12 chars>`) so lines from several nodes sharing one process —
 * every integration test — are attributable. Omit `peerId` and the namespace is byte-for-byte the
 * un-suffixed one, so callers that don't know their peer id are unaffected.
 *
 * NOTE: 12 chars matches the truncation the rest of this package already uses in log payloads, but
 * every Ed25519 peer id starts with the constant `12D3KooW`, so only ~4 base58 characters actually
 * distinguish nodes (~11M combinations — ample for the handful of nodes a test process runs).
 * Widen this only if a run ever needs to match a namespace against a full peer id.
 *
 * NOTE: only a few call sites pass a peer id today (`Libp2pKeyPeerNetwork`, `CoordinatorRepo`, and
 * the three `peer-address-book` sinks); the package's other ~30 `createLogger` call sites
 * still log under a flat namespace. Thread a peer id through any of them if a future diagnosis
 * needs per-node attribution from that subsystem — the mechanism is already here.
 *
 * The peer-id suffix goes BEFORE `:error` / `:trace` — those are children of the concrete channel,
 * so a two-node process gets `…:x:12D3KooWAb:error`, not `…:x:error:12D3KooWAb`.
 */
export function createLogger(subNamespace: string, peerId?: string): Logger {
	const suffix = peerId ? `:${peerId.substring(0, 12)}` : ''
	const namespace = `${BASE_NAMESPACE}:${subNamespace}${suffix}`
	// NOTE: `Object.assign` onto the Debugger, never a spread into a fresh object. `debug` defines
	// `enabled` as an accessor property on the function object it returns; assigning onto that
	// object preserves the accessor, whereas spreading would flatten it to a construction-time
	// snapshot boolean and silently break any `if (log.enabled)` guard.
	return Object.assign(debug(namespace), {
		error: debug(`${namespace}:error`),
		trace: debug(`${namespace}:trace`)
	})
}

export const verbose = typeof process !== 'undefined'
	&& (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
