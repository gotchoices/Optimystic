/** One peer a redirect names, with the addresses the redirecting node may publish for it. */
export type RedirectPeer = { id: string, addrs: string[] }

export type RedirectPayload = {
  redirect: {
    peers: RedirectPeer[]
    reason: 'not_in_cluster'
  }
}

export function encodePeers(peers: RedirectPeer[]): RedirectPayload {
  return {
    redirect: {
      peers,
      reason: 'not_in_cluster'
    }
  }
}

/**
 * The peer a client follows a redirect to: the first the redirect names that is neither the peer just
 * asked nor this node. Following one back to the asked peer loops, and following one to this node dials
 * itself, which libp2p refuses, so the request would fail as if every peer were unreachable.
 *
 * Throws when the redirect names no other peer; to the caller's transactor that is a failed coordinator,
 * which it excludes before picking another. `localId` is absent when the peer network has no identity of
 * its own, and only the asked peer is then left out.
 */
export function pickRedirectTarget(peers: readonly RedirectPeer[], askedId: string, localId: string | undefined): RedirectPeer {
  const target = peers.find(peer => peer.id !== askedId && peer.id !== localId)
  if (!target) {
    throw new Error(`Redirect from ${askedId} named no peer other than the one asked and this node`)
  }
  return target
}
