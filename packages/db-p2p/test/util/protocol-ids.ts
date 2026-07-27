/**
 * Shared protocol-id well-formedness assertion, for every spec that spawns a node.
 *
 * Background: `@libp2p/identify` builds its own protocol id as `/${protocolPrefix}/id/1.0.0` —
 * it always prepends the leading slash — so handing it the already-slash-prefixed
 * `/optimystic/<net>` produced `//optimystic/<net>/id/1.0.0` (gotchoices/Optimystic#6). That
 * malformed id shipped for several releases because every existing assertion was
 * `expect(protocols).to.include(<an id the author already thought of>)`: you can only catch a
 * bad id that way if you already suspected it.
 *
 * This helper is the generalization — it looks at the WHOLE advertised list and rejects any id
 * that is not `/`-rooted or that contains an empty path segment, whether or not anyone named it.
 * Call it from every spec that boots a node; it costs one line and catches ids nobody listed.
 */
import { expect } from 'chai';

/**
 * The ids in `protocols` that violate the shape rule: a libp2p protocol id is a `/`-rooted path
 * with no empty segment (so no leading `//`, no `//` in the middle, no trailing `/`).
 */
export function findMalformedProtocolIds(protocols: readonly string[]): string[] {
	return protocols.filter(p => !p.startsWith('/') || p.slice(1).split('/').some(seg => seg === ''));
}

/**
 * Assert that every id in `protocols` is well-formed. `context` is folded into the failure
 * message so a shared-helper failure still says which node shape produced it.
 */
export function expectWellFormedProtocolIds(protocols: readonly string[], context = 'spawned node'): void {
	const malformed = findMalformedProtocolIds(protocols);
	expect(malformed, `${context}: malformed protocol ids advertised: ${JSON.stringify(malformed)}`).to.deep.equal([]);
}
