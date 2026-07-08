import { runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';

// Prove the shared kernel end-to-end here, against the in-memory driver, before any
// real (LevelDB / SQLite / IndexedDB / filesystem) driver exists. The suite includes
// the BlockStorage parity slice, so pend→commit→getBlock and saveReplica→saveDeletion
// run through BlockStorage on top of the kernel too.
runRawStorageConformance('KvRawStorage over MemoryStoreDriver', async () => ({
	storage: new MemoryRawStorage(),
	cleanup: async () => { /* in-memory: nothing to release */ }
}));
