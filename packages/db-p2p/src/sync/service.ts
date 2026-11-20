import type { Connection, Startable } from '@libp2p/interface';
import type { BlockId, BlockLineage } from '@optimystic/db-core';
import { buildSyncProtocol, type SyncBlockAnswer, type SyncRequest, type SyncResponse } from './protocol.js';
import { pipe } from 'it-pipe';
import { toString as u8ToString } from 'uint8arrays/to-string';
import * as lp from 'it-length-prefixed';
import { CONSULT_RESPONSE_CONTENT_BUDGET_BYTES, CONSULT_RESPONSE_PROOF_BUDGET_BYTES, MAX_BLOCK_MESSAGE_BYTES, MAX_CONSULT_BATCH_BLOCKS, MAX_CONTROL_MESSAGE_BYTES } from '../protocol-limits.js';
import type { Uint8ArrayList } from 'uint8arraylist';
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js';
import { dedupeResponseProofs, fitConsultContent, serveBlockArchive, serveConsultAnswer, serveLineageAnswer, type ArchiveServingRepo } from '../storage/block-archive.js';
import { isActionRev } from '../repo/stated-holdings.js';
import { registerProtocolHandler } from '../network/register-protocol-handler.js';
import type { BlockArchive } from '../storage/struct.js';
import { createLogger, type Logger } from '../logger.js';

export interface SyncServiceInit extends InboundStreamAuthorizationInit {
	protocolPrefix?: string;
}

export interface SyncServiceComponents {
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
		this.log = createLogger('sync-service');
		this.protocol = buildSyncProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
		this.authorization = createInboundStreamAuthorization(init, this.protocol, (msg, ...args) => this.log.error(msg, ...args));
	}

	async start(): Promise<void> {
		if (this.running) return;

		await registerProtocolHandler(this.registrar, this.protocol, this.handleSyncRequest.bind(this));

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

						const response = request.held !== undefined || request.lineageOf !== undefined
							? await self.answerConsult(request, stream.id ?? stream.stream?.id)
							: await self.answerArchive(request, stream.id ?? stream.stream?.id);

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
					// An archive carries block bytes: the cap `SyncClient` reads it under, not the encoder's
					// own 4 MiB default.
					(source: any) => lp.encode(source, { maxDataLength: MAX_BLOCK_MESSAGE_BYTES })
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

	/** The original single-archive answer, for a request that did not say what the asker holds. */
	private async answerArchive(request: SyncRequest, responderId: string | undefined): Promise<SyncResponse> {
		const archive = await this.buildArchive(
			request.blockId,
			request.rev,
			request.includePending,
			request.maxRevisions
		);
		// Deduped too, though a single-archive answer carries at most one proof: one response shape for
		// both answers, so neither this service nor the asker's hydration pass has a second shape to
		// keep in step. The first proof is always admitted, so this only relocates it.
		//
		// NOTE: accepted tradeoff — the relocation costs an asker on a build that reads a revision
		// entry's `proof` but not its `proofRef`, which sees a proof-less archive here and falls back
		// to corroboration (the degradation the pre-proof path already defines). A narrow window:
		// reading a proof off the repair wire at all is recent, and this request shape asks for no
		// field a pre-reference build would not send. Weighed against two divergent answer shapes and
		// kept; revisit if this protocol ever has to interoperate across a wider span of builds.
		return archive
			? dedupeResponseProofs({ success: true, archive, responderId }, CONSULT_RESPONSE_PROOF_BUDGET_BYTES)
			: { success: false, error: 'Block not found in local storage' };
	}

	/**
	 * The answer to a request that said what the asker holds (`SyncRequest.held`), asked the lineage
	 * question (`SyncRequest.lineageOf`), or both: always `success`, with each asked block's answer in
	 * `answers`. With `held`, an answer without an archive is this node holding nothing, and the bytes
	 * ride only when this node is ahead of the asker (`serveConsultAnswer`) and fit the response's
	 * content budget (`fitConsultContent`); without it no archive is served. A block the request asked
	 * the lineage question about also carries this node's `lineage`. `rev` is ignored: a consult is
	 * always unpinned.
	 *
	 * Each distinct commit proof the answers carry rides ONCE, in the response's own table rather than
	 * inside each revision entry that needs it (`dedupeResponseProofs`) — a proof's size grows with
	 * its commit's block count, so a batched answer about several blocks of one large commit used to
	 * repeat megabytes and could exceed the frame the response is sent under.
	 *
	 * The blocks are served one after another. A consult names a handful at most, each a local read.
	 */
	private async answerConsult(request: SyncRequest, responderId: string | undefined): Promise<SyncResponse> {
		const served: Array<[BlockId, SyncBlockAnswer]> = [];
		for (const blockId of consultedBlockIds(request)) {
			const claim = request.held !== undefined ? await this.buildConsultAnswer(blockId, request) : {};
			const lineage = await this.buildLineageAnswer(blockId, request);
			served.push([blockId, lineage === undefined ? claim : { ...claim, lineage }]);
		}
		const answers = Object.fromEntries(fitConsultContent(served, CONSULT_RESPONSE_CONTENT_BUDGET_BYTES));
		// NOTE: the content budget above measured each archive with its proof still INSIDE it, so a
		// response carrying a large proof fits less content than it strictly could. Deliberate
		// ordering: dedupe after the fit leaves `withoutContent` and `latestClaimFromArchive` seeing
		// inline proofs, and over-counting errs the safe way — a block answered without its bytes is
		// simply asked for again ('size' is documented as a reason the asker must follow up on),
		// whereas an over-full frame loses the whole response.
		return dedupeResponseProofs({ success: true, answers, responderId }, CONSULT_RESPONSE_PROOF_BUDGET_BYTES);
	}

	/** One block's consult answer; a local serve fault reads as "holds nothing", as {@link buildArchive}'s does. */
	private async buildConsultAnswer(blockId: BlockId, request: SyncRequest): Promise<SyncBlockAnswer> {
		try {
			return await serveConsultAnswer(this.repo, blockId, request.held?.[blockId]);
		} catch (error) {
			this.log.error('Error building consult answer for block %s:', blockId, error);
			return {};
		}
	}

	/**
	 * This node's answer to the lineage question for one block, or `undefined` when the request did not
	 * ask a usable one about it. A serve fault is logged and reads as no lineage, never as a lost claim:
	 * the asker counts an absent answer as `unknown`, which is what happened.
	 */
	private async buildLineageAnswer(blockId: BlockId, request: SyncRequest): Promise<BlockLineage | undefined> {
		const asked: unknown = request.lineageOf?.[blockId];
		if (!isActionRev(asked)) return undefined;
		try {
			// Copied field by field, so nothing else the asker attached reaches storage.
			return await serveLineageAnswer(this.repo, blockId, { rev: asked.rev, actionId: asked.actionId });
		} catch (error) {
			this.log.error('Error answering the lineage question for block %s:', blockId, error);
			return undefined;
		}
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
 * The blocks a consult asks about: `blockIds` when the asker sent a list, else `blockId` alone —
 * distinct, and only the first {@link MAX_CONSULT_BATCH_BLOCKS}. An honest asker never sends more,
 * and a block left unanswered reads to it as silence, never as "holds nothing".
 */
function consultedBlockIds(request: SyncRequest): BlockId[] {
	const asked = Array.isArray(request.blockIds) ? request.blockIds : [request.blockId];
	return [...new Set(asked.filter((id): id is BlockId => typeof id === 'string'))].slice(0, MAX_CONSULT_BATCH_BLOCKS);
}

/**
 * Factory function for creating a SyncService.
 * Follows the libp2p service pattern.
 */
export const syncService = (init: SyncServiceInit = {}) =>
	(components: SyncServiceComponents) => new SyncService(components, init);

