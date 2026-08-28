import type { ComponentLogger, Connection, Startable } from '@libp2p/interface';
import { buildSyncProtocol, type SyncRequest, type SyncResponse } from './protocol.js';
import { pipe } from 'it-pipe';
import { toString as u8ToString } from 'uint8arrays/to-string';
import * as lp from 'it-length-prefixed';
import { MAX_CONTROL_MESSAGE_BYTES } from '../protocol-limits.js';
import type { Uint8ArrayList } from 'uint8arraylist';
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js';
import { serveBlockArchive, type ArchiveServingRepo } from '../storage/block-archive.js';
import type { BlockArchive } from '../storage/struct.js';

export interface SyncServiceInit extends InboundStreamAuthorizationInit {
	protocolPrefix?: string;
}

export interface SyncServiceComponents {
	logger: ComponentLogger;
	registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> };
	/**
	 * The local store this node answers repair fetches out of. Declared as `ArchiveServingRepo`
	 * rather than bare `IRepo` so the seam SAYS that the served archive's commit proof is read off
	 * this object: a wiring that hands over a delegating proxy without the accessor serves every
	 * archive proof-less, which is invisible to any test that reads a real `StorageRepo` directly.
	 * The accessor stays optional — a plain `IRepo` embedder serves the pre-proof archive, which
	 * every consumer still handles.
	 */
	repo: ArchiveServingRepo;
}

type Logger = ReturnType<ComponentLogger['forComponent']>;

/**
 * Service for handling incoming sync requests from other cluster peers.
 *
 * Listens on the sync protocol and responds to block requests by:
 * 1. Extracting the block from local storage
 * 2. Building a BlockArchive with requested revisions
 * 3. Sending the response back to the requester
 *
 * This is the server-side of the block restoration mechanism.
 */
export class SyncService implements Startable {
	private running = false;
	private readonly log: Logger;
	private readonly protocol: string;
	private readonly repo: ArchiveServingRepo;
	private readonly registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> };
	/** Optional embedder authorization gate; `undefined` (the default) means no check runs. */
	private readonly authorization: InboundStreamAuthorization | undefined;

	constructor(
		components: SyncServiceComponents,
		init: SyncServiceInit = {}
	) {
		this.log = components.logger.forComponent('db-p2p:sync-service');
		this.protocol = buildSyncProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
		this.authorization = createInboundStreamAuthorization(init, this.protocol, (msg, ...args) => this.log.error(msg, ...args));
	}

	async start(): Promise<void> {
		if (this.running) return;

		await this.registrar.handle(this.protocol, this.handleSyncRequest.bind(this));

		this.running = true;
		this.log('Sync service started on protocol %s', this.protocol);
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.registrar.unhandle(this.protocol);
		this.running = false;
		this.log('Sync service stopped');
	}

	/**
	 * Handle an incoming sync request stream.
	 * Uses a streaming pipeline (like the repo service) to process the
	 * request and yield a response immediately — avoids a read/write deadlock.
	 */
	private handleSyncRequest(stream: any, connection?: Connection): void {
		const self = this;
		// The registrar handler receives the stream (or, in an older shape, a `{ stream }`
		// wrapper) directly; resolve it once so the authorization abort, the pipeline and the
		// error path all act on the same object.
		const actualStream = stream.stream ?? stream;
		void (async () => {
			try {
				// Authorization runs before ANY decoding or execution. Guarded on the field so a
				// node without a predicate keeps the original path untouched.
				if (self.authorization && await self.authorization.deny(actualStream, connection?.remotePeer?.toString())) return;
				const processStream = async function* (source: AsyncIterable<Uint8ArrayList> | Iterable<Uint8ArrayList>) {
					for await (const msg of source) {
						const json = u8ToString(msg.subarray(), 'utf8');
						const request = JSON.parse(json) as SyncRequest;

						self.log(
							'[Ring Zulu] Received sync request for block %s revision %s',
							request.blockId,
							request.rev ?? 'latest'
						);

						const archive = await self.buildArchive(
							request.blockId,
							request.rev,
							request.includePending,
							request.maxRevisions
						);

						const response: SyncResponse = archive
							? { success: true, archive, responderId: stream.id ?? stream.stream?.id }
							: { success: false, error: 'Block not found in local storage' };

						self.log(
							'[Ring Zulu] %s sync request for block %s',
							response.success ? 'Fulfilled' : 'Failed',
							request.blockId
						);

						yield new TextEncoder().encode(JSON.stringify(response));
						return;
					}
				};

				// Use the same streaming pipeline pattern as the repo service.
				const responses = pipe(
					actualStream,
					(source: any) => lp.decode(source, { maxDataLength: MAX_CONTROL_MESSAGE_BYTES }),
					processStream,
					(source: any) => lp.encode(source)
				);
				for await (const chunk of responses) {
					actualStream.send(chunk);
				}
				await actualStream.close();
			} catch (error) {
				self.log.error('Error handling sync request:', error);
				try { actualStream.abort(error instanceof Error ? error : new Error(String(error))); } catch { /* ignore */ }
			}
		})();
	}

	/**
	 * Build a block archive from local storage — what a repair fetch on the other side receives.
	 * Shape and repo read both live in `storage/block-archive.ts`, shared with every other site that
	 * serves or fakes one, so a peer's answer cannot mean one thing here and another there.
	 *
	 * @param blockId - Block to retrieve
	 * @param rev - Optional specific revision
	 * @param includePending - Whether to include pending transactions
	 * @param maxRevisions - Maximum number of revisions to include
	 * @returns BlockArchive if found, undefined otherwise
	 */
	private async buildArchive(
		blockId: string,
		rev?: number,
		_includePending?: boolean,
		_maxRevisions?: number
	): Promise<BlockArchive | undefined> {
		try {
			return await serveBlockArchive(this.repo, blockId, rev);
		} catch (error) {
			this.log.error('Error building archive for block %s:', blockId, error);
			return undefined;
		}
	}
}

/**
 * Factory function for creating a SyncService.
 * Follows the libp2p service pattern.
 */
export const syncService = (init: SyncServiceInit = {}) =>
	(components: SyncServiceComponents) => new SyncService(components, init);

