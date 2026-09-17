import { Collection } from "../../collection/collection.js";
import type { ITransactor, Action, BlockId, BlockStore, IBlock, CollectionInitOptions, CollectionId, WriteDurability } from "../../index.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
import { DiaryHeaderBlockType } from "./struct.js";

/** A diary keeps every entry in the log itself, so the header block is the whole structure
 *  and the "append" handler has no blocks to touch. */
function diaryInit<TEntry>(): CollectionInitOptions<TEntry> {
	return {
		modules: {
			"append": async (_action, _trx) => {
				// Append-only diary doesn't need to modify any blocks
				// All entries are stored in the log
			}
		},
		createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
			header: store.createBlockHeader(DiaryHeaderBlockType, id)
		})
	};
}

export class Diary<TEntry> {
    private constructor(
			private readonly collection: Collection<TEntry>
		) {
    }

    /** Open an existing diary, or stage a fresh empty one when nothing has ever been committed
     *  under this id. Attach-or-create — see {@link Collection.createOrOpen}. */
    static async createOrOpen<TEntry>(network: ITransactor, id: CollectionId): Promise<Diary<TEntry>> {
        const collection = await Collection.createOrOpen(network, id, diaryInit<TEntry>());
        return new Diary<TEntry>(collection);
    }

    /** Open an EXISTING diary, or resolve to `undefined` when no header block has ever been
     *  committed under this id. Never brings a diary into existence — see {@link Collection.open}. */
    static async open<TEntry>(network: ITransactor, id: CollectionId): Promise<Diary<TEntry> | undefined> {
        const collection = await Collection.open(network, id, diaryInit<TEntry>());
        return collection ? new Diary<TEntry>(collection) : undefined;
    }

    /** Append one entry and flush it. Forwards the collection's answer verbatim — see
     *  {@link Collection.sync} for what `undefined` means. This layer never interprets the value.
     *  An append that throws leaves nothing staged (see {@link Collection.actAndSync}), so a caller
     *  that appends it again records it once, not twice. */
    async append(data: TEntry): Promise<WriteDurability | undefined> {
        const action: Action<TEntry> = {
            type: "append",
            data: data
        };

        return await this.collection.actAndSync([action]);
    }

    /** Fetch the latest state from the network */
    async update(): Promise<void> {
        await this.collection.update();
    }

    async *select(forward = true): AsyncIterableIterator<TEntry> {
        for await (const entry of this.collection.selectLog(forward)) {
            yield entry.data;
        }
    }
}

registerCollectionType({
	blockType: DiaryHeaderBlockType,
	name: "Diary",
	createOrOpen: (transactor, id) => Collection.createOrOpen(transactor, id, diaryInit<unknown>()),
});
