export type RedirectPayload = {
  redirect: {
    peers: Array<{ id: string, addrs: string[] }>
    reason: 'not_in_cluster'
  }
}

export function encodePeers(peers: Array<{ id: string, addrs: string[] }>): RedirectPayload {
  return {
    redirect: {
      peers,
      reason: 'not_in_cluster'
    }
  }
}


