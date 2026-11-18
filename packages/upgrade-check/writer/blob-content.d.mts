/** 600 KiB: three data pieces at the 256 KiB piece size, and the list piece naming them; see `blob-content.mjs`. */
export const BLOB_BYTES: number;

/** `size` bytes of xorshift32 output from `seed`, a nonzero integer; see `blob-content.mjs`. */
export function blobContent(seed: number, size?: number): Uint8Array;
