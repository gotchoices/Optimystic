import type { LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';

/** The database handle `LevelDBRawStorage` and `LevelDBKVStore` take; see `classic-level.mjs`. */
export type LevelDBHandle = ConstructorParameters<typeof LevelDBRawStorage>[0];

export function openClassicLevel(path: string): Promise<LevelDBHandle>;
