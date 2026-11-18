/** 300 KiB: two data pieces at the 256 KiB piece size, and the list piece naming them; see `blob-content.mjs`. */
export const BLOB_BYTES: number;

/** `size` bytes of numbered ASCII lines naming `seed`; see `blob-content.mjs`. */
export function blobContent(seed: number, size?: number): Uint8Array;
