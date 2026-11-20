/**
 * Whether a peer runs the blob protocol, as far as this node knows from the peer's protocol list
 * (docs/blobs.md §Moving pieces between machines). A sender of `announce` and `held` asks before it
 * dials, so a peer on an older build (docs/blobs.md §Compatibility) is skipped with a typed reason
 * rather than met as a failed protocol negotiation.
 *
 * Imports here are type-only: this module is reachable from the react-native entry (`src/rn.ts`)
 * through `blob-protocol-client.ts`.
 */

import type { Libp2pKeyPeerNetwork } from '../libp2p-key-network.js';

/** What this node knows about whether a peer runs the blob protocol, from its protocol list. */
export type BlobAcceptance = 'accepts' | 'refuses' | 'unknown';

/**
 * Thrown, before dialing, for a peer whose protocol list says it does not run the blob protocol (an
 * older build: docs/blobs.md §Compatibility). Not `BlobPeerRefusedError` (`blob-protocol.ts`), one
 * letter away, which a peer that DOES run it raises by answering `refused` to one request.
 */
export class BlobPeerRefusesError extends Error {
	constructor(readonly peer: string) {
		super(`peer ${peer} does not run the blob protocol`);
		this.name = 'BlobPeerRefusesError';
	}
}

/**
 * Each of `peerIds` (this node left out) as `accepts` when its peerStore record lists `blobProtocol`,
 * `refuses` when the record holds a protocol list without it, and `unknown` when the peer has not been
 * identified (`Libp2pKeyPeerNetwork.protocolSupport`). A peer that opened a blob stream to this node
 * has the protocol merged into its record by libp2p and reads `accepts`, which is right: it runs it.
 *
 * NOTE: a peer of this network whose identify has not landed yet can hold a partial list — the
 * protocol of a stream it opened to this node, merged by libp2p — and so reads `refuses` for that
 * moment, as `membershipOf` reads it `foreign`. Harmless while a refusal only skips one attempt. If
 * a caller ever remembers `refuses` until the peer reconnects (as the owed-copies drain remembers
 * `declined`), clear that memory on `peer:identify` too, or such a peer is skipped for a whole
 * connection.
 *
 * That "only skips one attempt" condition no longer holds: `BlobCopyDrain.accepts`
 * (`blob-copy-drain.ts`) also leaves a `refuses` member out of the denominator a blob's durability is
 * counted over, so a misread inside the window can report `full` and release the writer's `owed`
 * hold. Backlog `debt-a-peer-read-as-refusing-may-only-be-unidentified` carries that.
 */
export async function blobAcceptanceOf(
	keyNetwork: Pick<Libp2pKeyPeerNetwork, 'protocolSupport'>,
	blobProtocol: string,
	peerIds: readonly string[],
): Promise<Record<string, BlobAcceptance>> {
	const support = await keyNetwork.protocolSupport(blobProtocol, peerIds);
	const acceptance: Record<string, BlobAcceptance> = {};
	for (const [id, listed] of Object.entries(support)) {
		acceptance[id] = listed === 'listed' ? 'accepts' : listed === 'unlisted' ? 'refuses' : 'unknown';
	}
	return acceptance;
}
