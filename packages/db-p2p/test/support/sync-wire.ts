import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { SyncService } from '../../src/sync/service.js';
import { SyncClient } from '../../src/sync/client.js';
import type { SyncRequest, SyncResponse } from '../../src/sync/protocol.js';
import type { ArchiveServingRepo } from '../../src/storage/block-archive.js';
import { makeLinkedPair } from './linked-duplex-pair.js';

/**
 * A client whose every request reaches `repo`'s own `SyncService` through the service's registered
 * handler and a linked duplex pair: the real encode, frame and decode a sync response crosses.
 *
 * That round trip is the only way to observe what the two sides do to a response ON the way — the
 * server moving each commit proof into the response's own table and the client resolving it back
 * (`dedupeResponseProofs` / `hydrateResponseProofs`) — since both halves are invisible to a caller
 * that reads a response object directly.
 *
 * Shared rather than copied per spec for the same reason `commit-proof-fixtures.ts` is: a second
 * hand-rolled wire harness is how one spec ends up asserting against a response no real client reads.
 */
export const syncWire = async (
	repo: ArchiveServingRepo
): Promise<{ ask: (request: SyncRequest) => Promise<SyncResponse> }> => {
	let handler: ((stream: unknown) => void) | undefined;
	const registrar = {
		handle: async (_protocol: string, h: (stream: unknown) => void) => { handler = h; },
		unhandle: async () => { handler = undefined; }
	};
	await new SyncService({ registrar, repo }).start();
	const peerNetwork = {
		async connect() {
			const { clientStream, serverStream } = makeLinkedPair();
			handler!(serverStream);
			return clientStream;
		}
	};
	const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	const client = new SyncClient(peerId, peerNetwork as never);
	return { ask: request => client.requestBlock(request) };
};
