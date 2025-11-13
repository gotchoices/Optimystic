import { sha256 } from 'multiformats/hashes/sha2'
import { Chain, entryAt, nameof } from "../index.js";
import type { IBlock, BlockId, ActionId, CollectionId, ChainPath, ActionRev, ActionContext, ChainInitOptions, BlockStore } from "../index.js";
import type { ChainHeaderBlockType, ChainDataNode } from '../chain/chain-nodes.js';
import type { LogEntry, ActionEntry } from "./index.js";
import { LogDataBlockType, LogHeaderBlockType } from "./index.js";
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import type { GetFromResult } from './struct.js';

export type LogBlock<TAction> = ChainDataNode<LogEntry<TAction>>
	& {
		/** Base64url encoded Sha256 hash of the next block - present on every block except the head */
		priorHash?: string,
	};

export const priorHash$ = nameof<LogBlock<any>>("priorHash");

export class Log<TAction> {
	protected constructor(
		private readonly chain: Chain<LogEntry<TAction>>,
	) {
	}

	get id() {
		return this.chain.id;
	}

	/** Opens a presumably existing log. */
	static async open<TAction>(store: BlockStore<IBlock>, id: BlockId): Promise<Log<TAction> | undefined> {
		const chain = await Chain.open<LogEntry<TAction>>(store, id, Log.getChainOptions(store));
		return chain ? new Log<TAction>(chain) : undefined;
	}

	/** Creates a new log. */
	static async create<TAction>(store: BlockStore<IBlock>, newId?: BlockId) {
		return new Log<TAction>(await Chain.create<LogEntry<TAction>>(store, { ...Log.getChainOptions(store), newId }));
	}

	/** Adds a new entry to the log. */
	async addActions(actions: TAction[], actionId: ActionId, rev: number, getBlockIds: () => BlockId[], collectionIds: CollectionId[] = [], timestamp: number = Date.now()) {
		const entry = { timestamp, rev, action: { actionId, actions, blockIds: [], collectionIds } } as LogEntry<TAction>;
		const tailPath = await this.chain.add(entry);
		const entryWithBlockIds = { ...entry, action: { ...entry.action!, blockIds: getBlockIds() } };
		this.chain.updateAt(tailPath, entryWithBlockIds);
		return { entry: entryWithBlockIds, tailPath };
	}

	/** Adds a checkpoint to the log. */
	async addCheckpoint(pendings: ActionRev[], rev: number, timestamp: number = Date.now()) {
		const entry = { timestamp, rev, checkpoint: { pendings } };
		const tailPath = await this.chain.add(entry);
		return { entry, tailPath };
	}

	/** Gets the action context of the log. */
	async getActionContext(): Promise<ActionContext | undefined> {
		const tailPath = await this.chain.getTail();
		if (!tailPath) {
			return undefined;
		}
		const checkpoint = await this.findCheckpoint(tailPath);
		return {
			committed:
				checkpoint

					? [...checkpoint.pendings, ...await this.pendingFrom(checkpoint.path)]
					: [],
			rev: checkpoint?.rev ?? 0,
		};
	}

	/** Gets the actions from startRev (exclusive), to latest in the log. */
	async getFrom(startRev: number | undefined): Promise<GetFromResult<TAction>> {
		const entries: ActionEntry<TAction>[] = [];
		const pendings: ActionRev[] = [];
		let rev: number | undefined;
		let checkpointPath: ChainPath<LogEntry<TAction>> | undefined;
		// Step through collecting both pending and entries until a checkpoint is found
		for await (const path of this.chain.select(undefined, false)) {
			const entry = entryAt<LogEntry<TAction>>(path)!;
			rev = rev ?? entry.rev;
			if (entry.checkpoint) {
				checkpointPath = path;
				pendings.unshift(...entry.checkpoint.pendings);
				break;
			}
			pendings.unshift({ actionId: entry.action!.actionId, rev: entry.rev });
			if (startRev !== undefined && entry.rev > startRev) {
				entries.unshift(entry.action!);
			}	// Can't stop at rev, because we need to collect all pending actions for the context
		}
		// Continue stepping past the checkpoint until the given rev is reached
		if (checkpointPath) {
			for await (const path of this.chain.select(checkpointPath, false)) {
				const entry = entryAt<LogEntry<TAction>>(path)!;
				if (startRev !== undefined && entry.rev > startRev) {
					if (entry.action) {
						entries.unshift(entry.action!);
					}
				} else {
					break;
				}
			}
		}
		return { context: rev ? { committed: pendings, rev } : undefined, entries };
	}

	/** Enumerates log entries from the given starting path or end if undefined, in forward (from tail to head) or reverse (from head to tail) order. */
	async *select(starting?: ChainPath<LogEntry<TAction>>, forward = true) {
		for await (const path of this.chain.select(starting, forward)) {
			yield entryAt<LogEntry<TAction>>(path)!;
		}
	}

	/** Returns the set of pending transactions in the most recent checkpoint, at or preceding the given path. */
	private async findCheckpoint(starting: ChainPath<LogEntry<TAction>>) {
		let lastPath: ChainPath<LogEntry<TAction>> | undefined;
		let rev: number | undefined;
		for await (const path of this.chain.select(starting, false)) {
			const entry = entryAt<LogEntry<TAction>>(path)!;
			rev = rev ?? entry.rev;
			if (entry.checkpoint) {
				return { path, pendings: entry.checkpoint.pendings, rev };
			}
			lastPath = path;
		}
		return lastPath ? { path: lastPath, pendings: [], rev } : undefined;
	}

	/** Returns the set of pending actions following, the given checkpoint path. */
	private async pendingFrom(starting: ChainPath<LogEntry<TAction>>) {
		const pendings: ActionRev[] = [];
		for await (const actionPath of this.chain.select(starting)) {
			const entry = entryAt<LogEntry<TAction>>(actionPath);
			if (entry?.action) {
				pendings.push({ actionId: entry.action.actionId, rev: entry.rev });
			}
		}
		return pendings;
	}

	private static getChainOptions<TAction>(store: BlockStore<IBlock>) {
		return {
			createDataBlock: () => ({ header: store.createBlockHeader(LogDataBlockType) }),
			createHeaderBlock: (id?: BlockId) => ({ header: store.createBlockHeader(LogHeaderBlockType, id) }),
			newBlock: async (newTail: LogBlock<TAction>, oldTail: LogBlock<TAction> | undefined) => {
				if (oldTail) {
					const hash = await sha256.digest(new TextEncoder().encode(JSON.stringify(oldTail)));
					newTail.priorHash = uint8ArrayToString(hash.digest, 'base64url');
				}
			},
		} as ChainInitOptions<LogEntry<TAction>>;

	}
}
