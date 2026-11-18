/**
 * `NodeBlobService.stat` with `probe` (docs/blobs.md §The node's blob service): the first peer that
 * holds the blob settles the probe as `elsewhere` without waiting for the rest, and a silent peer is
 * given up on after one response timeout, leaving `unknown`. The peers are stubs; the two-node spec
 * pins the probe over real nodes.
 */
import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import { buildBlob, type BlobRef, type ClusterPeers } from '@optimystic/db-core';
import { NodeBlobService } from '../src/blob/node-blob-service.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import type { BlobLocalHolding } from '../src/blob/blob-protocol.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';

const PROBE_TIMEOUT_MS = 100;

type Answer = BlobLocalHolding | 'silent';

/** A service whose cohort is `answers`' peers, each answering a stat as given; returns the peers whose request was aborted. */
async function probeOver(answers: readonly Answer[]): Promise<{ service: NodeBlobService; ref: BlobRef; aborted: Set<string> }> {
	const peers = await Promise.all(answers.map(async () => peerIdFromPrivateKey(await generateKeyPair('Ed25519'))));
	const answerOf = new Map(peers.map((peer, index) => [peer.toString(), answers[index]!]));
	const aborted = new Set<string>();
	const stat = (peer: PeerId, _refs: readonly BlobRef[], options: { signal?: AbortSignal } = {}): Promise<BlobLocalHolding[]> => {
		const answer = answerOf.get(peer.toString())!;
		return new Promise((resolve, reject) => {
			options.signal?.addEventListener('abort', () => {
				aborted.add(peer.toString());
				reject(options.signal!.reason);
			}, { once: true });
			if (answer !== 'silent') {
				setTimeout(() => resolve([answer]), 10);
			}
		});
	};
	const service = new NodeBlobService({
		local: new LocalBlobService({ pieces: new MemoryPieceStore(), kv: new MemoryKVStore(), setTimer: () => () => undefined }),
		fetcher: { start: () => { throw new Error('a probe starts no fetch'); }, onPieceStored: () => () => undefined },
		client: { stat, wireBytes: () => ({ sent: 0, received: 0 }) },
		holders: {
			selfPeerId: 'self',
			blobProtocol: '/test/blob',
			keyNetwork: {
				findCluster: async (): Promise<ClusterPeers> => Object.fromEntries(peers.map(peer => [peer.toString(), { multiaddrs: [], publicKey: '' }])),
				peersServing: async (_protocol: string, candidates: readonly string[]) => [...candidates],
			},
			membership: undefined,
			reputation: { isBanned: () => false, isDeprioritized: () => false },
			isConnected: () => true,
		},
		probeTimeoutMs: PROBE_TIMEOUT_MS,
	});
	const { ref } = await buildBlob(streamOf(new Uint8Array([1, 2, 3])), { put: async () => undefined });
	return { service, ref, aborted };
}

describe('NodeBlobService stat probe', () => {
	it('settles on the first holder and stops waiting for a silent peer', async () => {
		const { service, ref, aborted } = await probeOver(['silent', 'partial']);
		const startedAt = Date.now();
		expect((await service.stat(ref, { probe: true })).locality).to.equal('elsewhere');
		expect(Date.now() - startedAt).to.be.below(PROBE_TIMEOUT_MS);
		expect(aborted.size).to.equal(1);
	});

	it('leaves unknown when every peer answers none or stays silent past the response timeout', async () => {
		const { service, ref } = await probeOver(['none', 'silent']);
		const startedAt = Date.now();
		expect((await service.stat(ref, { probe: true })).locality).to.equal('unknown');
		expect(Date.now() - startedAt).to.be.at.least(PROBE_TIMEOUT_MS - 5);
	});
});
