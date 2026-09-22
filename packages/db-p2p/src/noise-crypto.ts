// Re-exported so an app can build a `NodeOptions.noiseCrypto` without depending on
// `@chainsafe/libp2p-noise` itself at the major this package is built against.
export type { ICryptoInterface as NoiseCryptoInterface } from '@chainsafe/libp2p-noise';
export { pureJsCrypto as noisePureJsCrypto } from '@chainsafe/libp2p-noise';
