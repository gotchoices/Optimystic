import { sha256 } from 'multiformats/hashes/sha2'
import type { BlockId } from '../index.js'

export async function blockIdToBytes(blockId: BlockId): Promise<Uint8Array> {
    const input = new TextEncoder().encode(blockId)
    const mh = await sha256.digest(input)
    return mh.digest
}
