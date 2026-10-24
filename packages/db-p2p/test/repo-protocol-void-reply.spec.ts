/**
 * GitHub #46. `IRepo.cancel` resolves `void`, and `RepoService` answers it with
 * `JSON.stringify(undefined)` — a zero-length reply frame. The client parsed every frame as JSON,
 * so a cancel the remote coordinator had carried out reached the writer as
 * `SyntaxError: Unexpected end of JSON input`, and the writer retried it after its back-off.
 *
 * A real `RepoClient` against a real `RepoService` over an in-memory stream pair: the repo behind
 * the service is the boundary, so it is a plain `IRepo` object.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { ActionBlocks, IPeerNetwork, IRepo } from '@optimystic/db-core';
import { RepoClient } from '../src/repo/client.js';
import { RepoService } from '../src/repo/service.js';
import { makeLinkedPair, type LinkedStream } from './support/linked-duplex-pair.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

const unused = async (): Promise<never> => { throw new Error('not used by this spec'); };

/** A repo whose `cancel` is `cancel`, counting the calls it receives. */
const makeRepo = (cancel: () => Promise<void>): { repo: IRepo, cancels: ActionBlocks[] } => {
	const cancels: ActionBlocks[] = [];
	const repo: IRepo = {
		get: unused,
		pend: unused,
		commit: unused,
		async cancel(actionRef: ActionBlocks) {
			cancels.push(actionRef);
			await cancel();
		}
	};
	return { repo, cancels };
};

/** A client whose every dial reaches `repo` through a real `RepoService` handler. */
const connectedClient = async (repo: IRepo): Promise<RepoClient> => {
	const servicePeer = await makePeerId();
	// No keyNetwork: the redirect check finds nobody to ask, so the service handles the request itself.
	const service = new RepoService({ registrar: { handle: async () => { }, unhandle: async () => { } }, repo, peerId: servicePeer });
	const handle = (service as unknown as { handleIncomingStream: (stream: LinkedStream) => void }).handleIncomingStream.bind(service);
	const network: IPeerNetwork = {
		async connect() {
			const { clientStream, serverStream } = makeLinkedPair();
			handle(serverStream);
			return clientStream;
		}
	};
	return RepoClient.create(servicePeer, network);
};

const actionRef: ActionBlocks = { actionId: 'action-1', blockIds: ['block-1'] };
const options = () => ({ expiration: Date.now() + 5_000 });

describe('repo protocol: an operation that answers void', () => {
	it('a remote cancel that succeeded resolves', async () => {
		const { repo, cancels } = makeRepo(async () => { });
		const client = await connectedClient(repo);

		await client.cancel(actionRef, options());

		expect(cancels).to.deep.equal([actionRef]);
	});

	it('a remote cancel that failed still rejects', async () => {
		const { repo, cancels } = makeRepo(async () => { throw new Error('cancel refused'); });
		const client = await connectedClient(repo);

		let failure: Error | undefined;
		try {
			await client.cancel(actionRef, options());
		} catch (err) {
			failure = err as Error;
		}

		expect(failure, 'the failure reaches the caller').to.be.instanceOf(Error);
		// The client's own deadline also rejects; the failure must arrive as the service's abort, not by waiting it out.
		expect(failure!.message).to.not.equal('RepoClient timeout');
		expect(cancels).to.have.length(1);
	});
});
