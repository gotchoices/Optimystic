import type { AbortOptions, PeerId, Stream } from "@libp2p/interface";

export type IPeerNetwork = {
  /**
   * Dial a peer and establish a protocol stream
   */
  connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;
}
