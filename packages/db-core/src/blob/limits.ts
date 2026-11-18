/** Leaf size the builder writes (256 KiB). */
export const BLOB_PIECE_BYTES = 262_144;
/** Children per list piece the builder writes (kubo's balanced layout). */
export const BLOB_LIST_LINKS = 174;
/** Largest piece a reader accepts, from any tool. */
export const MAX_BLOB_PIECE_BYTES = 1_048_576;
/** Most children a reader follows in one list piece. 1024 is the default of the JavaScript IPFS importer (Helia), so blobs it made with defaults are readable; a 1 MiB piece could hold about 20,000 links, so this limit, not the piece size, is the one that binds. */
export const MAX_BLOB_LIST_LINKS = 1024;
/** Most levels of list pieces a reader follows, the root counting as one. The builder needs 3 for 1.3 TiB at 256 KiB leaves; 8 leaves room for trees other tools build with smaller leaves, at one extra request per level per range edge. */
export const MAX_BLOB_LIST_DEPTH = 8;
