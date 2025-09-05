import type { IRepo, GetBlockResults, PendSuccess, StaleFailure, TrxBlocks, MessageOptions, CommitResult,
	PendRequest, CommitRequest, BlockGets, IPeerNetwork} from "@optimystic/db-core";
import type { RepoMessage } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { ProtocolClient } from "../protocol-client.js";
import { peerIdFromString } from "@libp2p/peer-id";

export class RepoClient extends ProtocolClient implements IRepo {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork): RepoClient {
		return new RepoClient(peerId, peerNetwork);
	}

	async get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults> {
		return this.processRepoMessage<GetBlockResults>(
			[{ get: blockGets }],
			options
		);
	}

	async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure> {
		return this.processRepoMessage<PendSuccess | StaleFailure>(
			[{ pend: request }],
			options
		);
	}

	async cancel(trxRef: TrxBlocks, options: MessageOptions): Promise<void> {
		return this.processRepoMessage<void>(
			[{ cancel: { trxRef } }],
			options
		);
	}

	async commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult> {
		return this.processRepoMessage<CommitResult>(
			[{ commit: request }],
			options
		);
	}

  private async processRepoMessage<T>(
    operations: RepoMessage['operations'],
    options: MessageOptions,
    hop: number = 0
  ): Promise<T> {
		const message: RepoMessage = {
			operations,
			expiration: options.expiration,
		};
    const response = await super.processMessage<any>(
      message,
      (this.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0',
      { signal: options?.signal }
    );

    if (response?.redirect?.peers?.length) {
      if (hop >= 2) {
        throw new Error('Redirect loop detected in RepoClient (max hops reached)')
      }
      const currentIdStr = this.peerId.toString()
      const next = response.redirect.peers.find((p: any) => p.id !== currentIdStr) ?? response.redirect.peers[0]
      const nextId = peerIdFromString(next.id)
      if (next.id === currentIdStr) {
        throw new Error('Redirect loop detected in RepoClient (same peer)')
      }
      // cache hint
      this.recordCoordinatorForOpsIfSupported(operations, nextId)
      // single-hop retry against target peer using repo protocol
      const nextClient = RepoClient.create(nextId, this.peerNetwork)
      return await nextClient.processRepoMessage<T>(operations, options, hop + 1)
    }
    return response as T;
	}

  private extractKeyFromOperations(ops: RepoMessage['operations']): Uint8Array | undefined {
    const op = ops[0];
    if ('get' in op) {
      const id = op.get.blockIds[0];
      return id ? new TextEncoder().encode(id) : undefined;
    }
    if ('pend' in op) {
      const id = Object.keys(op.pend.transforms)[0];
      return id ? new TextEncoder().encode(id) : undefined;
    }
    if ('commit' in op) {
      return new TextEncoder().encode(op.commit.tailId);
    }
    return undefined;
  }

  private recordCoordinatorForOpsIfSupported(ops: RepoMessage['operations'], peerId: PeerId): void {
    const keyBytes = this.extractKeyFromOperations(ops)
    const pn: any = this.peerNetwork as any
    if (keyBytes != null && typeof pn?.recordCoordinator === 'function') {
      pn.recordCoordinator(keyBytes, peerId)
    }
  }

}
