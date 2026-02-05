import type { ComponentLogger, Startable, Stream } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import { buildSyncProtocol, type SyncRequest, type SyncResponse } from './protocol.js';
import { pipe } from 'it-pipe';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import * as lp from 'it-length-prefixed';

export interface SyncServiceInit {
	protocolPrefix?: string;
}

export interface SyncServiceComponents {
	logger: ComponentLogger;
	registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> };
	repo: IRepo;
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
	private readonly repo: IRepo;
	private readonly registrar: { handle: (...args: any[]) => Promise<void>, unhandle: (...args: any[]) => Promise<void> };

	constructor(
		private readonly components: SyncServiceComponents,
		init: SyncServiceInit = {}
	) {
		this.log = components.logger.forComponent('db-p2p:sync-service');
		this.protocol = buildSyncProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
	}

	async start(): Promise<void> {
		if (this.running) return;

		await this.registrar.handle(this.protocol, async (data: any) => {
			await this.handleSyncRequest(data.stream);
		});

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
	 */
	private async handleSyncRequest(stream: Stream): Promise<void> {
		try {
			// Read request using length-prefixed protocol
			const request = await this.readRequest(stream);

			this.log(
				'[Ring Zulu] Received sync request for block %s revision %s',
				request.blockId,
				request.rev ?? 'latest'
			);

			// Build archive from local storage
			const archive = await this.buildArchive(
				request.blockId,
				request.rev,
				request.includePending,
				request.maxRevisions
			);

			// Send response
			const response: SyncResponse = archive
				? {
					success: true,
					archive,
					responderId: stream.id
				}
				: {
					success: false,
					error: 'Block not found in local storage'
				};

			await this.sendResponse(stream, response);

			this.log(
				'[Ring Zulu] %s sync request for block %s',
				response.success ? 'Fulfilled' : 'Failed',
				request.blockId
			);
		} catch (error) {
			this.log.error('Error handling sync request:', error);

			// Try to send error response
			try {
				const errorResponse: SyncResponse = {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error'
				};
				await this.sendResponse(stream, errorResponse);
			} catch (sendError) {
				this.log.error('Failed to send error response:', sendError);
			}
		} finally {
			try {
				await stream.close();
			} catch (closeError) {
				// Ignore close errors
			}
		}
	}

	/**
	 * Read and parse a sync request from the stream.
	 */
	private async readRequest(stream: Stream): Promise<SyncRequest> {
		const messages: Uint8Array[] = [];

		// Stream is now directly AsyncIterable in libp2p v3
		await pipe(
			stream,
			lp.decode,
			async (source) => {
				for await (const msg of source) {
					messages.push(msg.subarray());
				}
			}
		);

		if (messages.length === 0) {
			throw new Error('No request received');
		}

		const json = u8ToString(messages[0]!, 'utf8');
		return JSON.parse(json) as SyncRequest;
	}

	/**
	 * Send a sync response to the stream.
	 */
	private async sendResponse(stream: Stream, response: SyncResponse): Promise<void> {
		const json = JSON.stringify(response);
		const bytes = u8FromString(json, 'utf8');

		// Use stream.send() instead of piping to stream.sink in libp2p v3
		const encoded = pipe([bytes], lp.encode);
		for await (const chunk of encoded) {
			stream.send(chunk);
		}
	}

	/**
	 * Build a block archive from local storage.
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
	): Promise<import('../storage/struct.js').BlockArchive | undefined> {
		try {
			// Get the block from local storage
			const context = rev !== undefined
				? { rev, committed: [], pending: [] }
				: undefined;

			const result = await this.repo.get({
				blockIds: [blockId],
				context
			});

			const blockResult = result[blockId];
			if (!blockResult || !blockResult.state.latest) {
				return undefined;
			}

			const latest = blockResult.state.latest;

			// Return minimal archive with just the requested block
			const archive: import('../storage/struct.js').BlockArchive = {
				blockId,
				revisions: {
					[latest.rev]: {
						action: {
							actionId: latest.actionId,
							transform: { insert: blockResult.block }
						},
						block: blockResult.block
					}
				},
				range: [latest.rev, latest.rev + 1]
			};

			return archive;
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

