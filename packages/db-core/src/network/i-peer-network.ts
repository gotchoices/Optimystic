import type { AbortOptions, PeerId, Stream } from "./types.js";

export type IPeerNetwork = {
  /**
   * Dial a peer and establish a protocol stream
   */
  connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;

  /**
   * Optionally teach the dialer how to reach `peerId`, from addresses carried by an
   * application-level message (a cluster record's peer map, a redirect payload).
   *
   * This exists because libp2p only propagates a peer's addresses to peers it is
   * DIRECTLY connected to. A cohort here is chosen by key position, so a member
   * routinely shares a cohort with a relay-only peer it has never met and holds an
   * empty address list for it — a dial by peer id alone then fails immediately. Our
   * own protocol messages already carry the addresses; this is the seam that lets a
   * recipient keep them.
   *
   * Addresses are multiaddr strings (matching `ClusterPeers` / `RedirectPayload`), so
   * db-core needs no multiaddr dependency. Implementations without an address book
   * omit this method.
   */
  recordPeerAddresses?(peerId: PeerId, multiaddrs: string[]): void;
}
