import type { Startable, Stream } from '@libp2p/interface';
import type { IRepo, PeerId, IPeerNetwork, ActionId, ActionRev, IBlock, BlockId } from '@optimystic/db-core';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { ProtocolClient } from '../protocol-client.js';
import { MAX_BLOCK_MESSAGE_BYTES } from '../protocol-limits.js';
import { createLogger } from '../logger.js';

const log = createLogger('block-transfer-service');

/** Protocol path */
const BLOCK_TRANSFER_PREFIX = '/db-p2p/block-transfer/';
const BLOCK_TRANSFER_VERSION = '1.0.0';

export const buildBlockTransferProtocol = (protocolPrefix: string = ''): string =>
	`${protocolPrefix}${BLOCK_TRANSFER_PREFIX}${BLOCK_TRANSFER_VERSION}`;

/** Request to transfer blocks */
export interface BlockTransferRequest {
	type: 'pull' | 'push';
	/** Block IDs being transferred */
	blockIds: string[];
	/** Reason for transfer */
	reason: 'rebalance' | 'replication' | 'recovery';
	/** For push: base64-encoded block data per block ID */
	blockData?: Record<string, string>;
	/**
	 * For push: the source's revision metadata per block ID. Carries the sender's
	 * `state.latest` so the replica's `latest` matches the source instead of being
	 * fabricated. Optional: an older sender omits it and the receiver falls back to a
	 * deterministic rev-1 replica (see {@link IBlockStorage.saveReplica}).
	 */
	blockMeta?: Record<string, { rev: number; actionId: ActionId }>;
}

/** Response with block data */
export interface BlockTransferResponse {
	/** Blocks successfully transferred: blockId → base64-encoded data */
	blocks: Record<string, string>;
	/** Block IDs that couldn't be found/transferred */
	missing: string[];
}

// --- Service (server-side handler) ---

/**
 * Repo capability the service needs: read access for `handlePull` plus a local
 * "save replica" path for `handlePush`. The replica path must land in the node's
 * *local* storage (not the cluster-coordinated repo), so it is a distinct method
 * from the `IRepo` commit funnel. `StorageRepo` implements this.
 */
export interface IBlockReplicaStore extends IRepo {
	/**
	 * Persist a replica of a block received out-of-band (churn re-replication).
	 * Seeds metadata if absent, advances `latest` monotonically, and makes the block
	 * durably servable via `get`. Idempotent for a fixed `(rev, actionId)`; a no-op
	 * (still durable) when an equal-or-newer revision is already present.
	 */
	saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev): Promise<void>;
}

export interface BlockTransferServiceInit {
	protocolPrefix?: string;
}

export interface BlockTransferServiceComponents {
	registrar: { handle: (...args: any[]) => Promise<void>; unhandle: (...args: any[]) => Promise<void> };
	repo: IBlockReplicaStore;
}

/**
 * Libp2p service that handles incoming block transfer requests.
 *
 * Responds to pull requests by reading blocks from local storage.
 * Handles push requests by accepting block data and storing it locally.
 */
export class BlockTransferService implements Startable {
	private running = false;
	private readonly protocol: string;
	private readonly repo: IBlockReplicaStore;
	private readonly registrar: BlockTransferServiceComponents['registrar'];

	constructor(
		components: BlockTransferServiceComponents,
		init: BlockTransferServiceInit = {}
	) {
		this.protocol = buildBlockTransferProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
	}

	async start(): Promise<void> {
		if (this.running) return;
		await this.registrar.handle(this.protocol, async (data: any) => {
			// libp2p invokes the stream handler with the Stream as the FIRST positional argument
			// (see cluster/repo/dispute services, which all use `(stream, connection)`). The block-
			// transfer handler previously read `data.stream`, which is `undefined` for the positional
			// shape — so `readRequest` ran `pipe(undefined, ...)` → "Empty pipeline", the receiver
			// never replied, and every push/pull dialled this service hung with no response. Unwrap
			// defensively (older shape passed `{ stream }`), mirroring sync/service.ts.
			const stream = data?.stream ?? data;
			await this.handleRequest(stream);
		});
		this.running = true;
		log('started on %s', this.protocol);
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.registrar.unhandle(this.protocol);
		this.running = false;
		log('stopped');
	}

	private async handleRequest(stream: Stream): Promise<void> {
		const self = this;
		try {
			// Read the request, process it, and write the response on ONE continuous duplex
			// pipe (mirrors cluster/repo/dispute services). The earlier read-to-end-then-write
			// design deadlocked over a real stream: the client sends one length-prefixed request
			// and holds its write side open awaiting the reply, so a receiver that drained the
			// source until end-of-stream blocked forever — and the reply, written only after
			// teardown, hit a closed stream. Yielding the response as soon as the request is read
			// keeps both sides live.
			const responses = pipe(
				stream,
				(source) => lp.decode(source, { maxDataLength: MAX_BLOCK_MESSAGE_BYTES }),
				async function* (source) {
					for await (const msg of source) {
						const request = JSON.parse(u8ToString(msg.subarray(), 'utf8')) as BlockTransferRequest;
						log('request type=%s blocks=%d reason=%s', request.type, request.blockIds.length, request.reason);
						let response: BlockTransferResponse;
						try {
							response = request.type === 'pull'
								? await self.handlePull(request)
								: await self.handlePush(request);
						} catch (error) {
							log('error: %s', (error as Error).message);
							response = { blocks: {}, missing: [] };
						}
						log('response blocks=%d missing=%d', Object.keys(response.blocks).length, response.missing.length);
						yield u8FromString(JSON.stringify(response), 'utf8');
						return; // one request → one response per stream
					}
				},
				(source) => lp.encode(source)
			);
			for await (const chunk of responses) {
				stream.send(chunk);
			}
			await stream.close();
		} catch (err) {
			log('error: %s', (err as Error).message);
			try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* ignore */ }
		}
	}

	private async handlePull(request: BlockTransferRequest): Promise<BlockTransferResponse> {
		const blocks: Record<string, string> = {};
		const missing: string[] = [];

		const result = await this.repo.get({ blockIds: request.blockIds });

		for (const blockId of request.blockIds) {
			const blockResult = result[blockId];
			if (blockResult?.block) {
				blocks[blockId] = Buffer.from(JSON.stringify(blockResult.block)).toString('base64');
			} else {
				missing.push(blockId);
			}
		}

		return { blocks, missing };
	}

	/**
	 * Persist pushed blocks into local storage so the new owner holds a durable
	 * replica after churn. A block is reported `accepted` only if it was both
	 * received (parseable) AND successfully persisted; a parse or persist failure
	 * surfaces it as `missing` so the sender does not falsely treat it as replicated.
	 */
	private async handlePush(request: BlockTransferRequest): Promise<BlockTransferResponse> {
		const blocks: Record<string, string> = {};
		const missing: string[] = [];

		if (!request.blockData) {
			return { blocks: {}, missing: request.blockIds };
		}

		for (const blockId of request.blockIds) {
			const data = request.blockData[blockId];
			if (!data) {
				missing.push(blockId);
				continue;
			}

			// Decode + parse the wire payload into an IBlock.
			let block: IBlock;
			try {
				block = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as IBlock;
			} catch {
				missing.push(blockId);
				continue;
			}

			// `JSON.parse` accepts `null`/primitives as valid JSON. Persisting a falsy or
			// header-less "block" would seed metadata with no materialization, making every
			// later `get` throw. Reject such payloads as missing rather than poison storage.
			if (block === null || typeof block !== 'object' || (block as IBlock).header === undefined) {
				log('push:invalid block=%s (not a structurally valid block)', blockId);
				missing.push(blockId);
				continue;
			}

			// Persist locally. Only a received-AND-persisted block is reported accepted.
			try {
				const source = request.blockMeta?.[blockId];
				await this.repo.saveReplicatedBlock(blockId, block, source);
				blocks[blockId] = data;
			} catch (error) {
				log('persist:fail block=%s err=%s', blockId, (error as Error).message);
				missing.push(blockId);
			}
		}

		return { blocks, missing };
	}
}

/** Factory for creating BlockTransferService following the libp2p service pattern. */
export const blockTransferService = (init: BlockTransferServiceInit = {}) =>
	(components: BlockTransferServiceComponents) => new BlockTransferService(components, init);

// --- Client ---

/**
 * Client for sending block transfer requests to remote peers.
 */
export class BlockTransferClient extends ProtocolClient {
	private readonly protocol: string;

	constructor(
		peerId: PeerId,
		peerNetwork: IPeerNetwork,
		protocolPrefix: string = ''
	) {
		super(peerId, peerNetwork);
		this.protocol = buildBlockTransferProtocol(protocolPrefix);
	}

	/**
	 * Pull blocks from the remote peer.
	 *
	 * @param options Optional per-call deadlines/cancellation forwarded to the
	 *   underlying request. `dialTimeoutMs` bounds connecting; `responseTimeoutMs`
	 *   bounds waiting for the reply once connected; `signal` cancels the whole
	 *   request. Omitting all of them preserves the previous uncapped behavior.
	 */
	async pullBlocks(
		blockIds: string[],
		reason: BlockTransferRequest['reason'] = 'rebalance',
		options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }
	): Promise<BlockTransferResponse> {
		const request: BlockTransferRequest = { type: 'pull', blockIds, reason };
		return await this.processMessage<BlockTransferResponse>(request, this.protocol, { ...options, maxDataLength: MAX_BLOCK_MESSAGE_BYTES });
	}

	/**
	 * Push blocks to the remote peer.
	 *
	 * @param blockMeta Optional per-block source revision metadata (the sender's
	 *   `state.latest`). When provided, the receiver replicates at the source's
	 *   `(rev, actionId)`; when omitted, it falls back to a deterministic rev-1 replica.
	 * @param options Optional per-call deadlines/cancellation forwarded to the
	 *   underlying request. `dialTimeoutMs` bounds connecting; `responseTimeoutMs`
	 *   bounds waiting for the reply once connected (so a peer that connects but goes
	 *   silent throws {@link ResponseTimeoutError} instead of hanging); `signal`
	 *   cancels the whole request. Omitting all of them preserves the previous
	 *   uncapped behavior.
	 */
	async pushBlocks(
		blockIds: string[],
		blockDataBuffers: Uint8Array[],
		reason: BlockTransferRequest['reason'] = 'rebalance',
		blockMeta?: Record<string, { rev: number; actionId: ActionId }>,
		options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }
	): Promise<BlockTransferResponse> {
		const blockData: Record<string, string> = {};
		for (let i = 0; i < blockIds.length; i++) {
			blockData[blockIds[i]!] = Buffer.from(blockDataBuffers[i]!).toString('base64');
		}
		const request: BlockTransferRequest = { type: 'push', blockIds, reason, blockData, ...(blockMeta ? { blockMeta } : {}) };
		return await this.processMessage<BlockTransferResponse>(request, this.protocol, { ...options, maxDataLength: MAX_BLOCK_MESSAGE_BYTES });
	}
}
