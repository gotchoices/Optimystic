import type { Libp2p } from 'libp2p'
import type { NetworkManagerService } from './network-manager-service.js'
import { createLogger } from '../logger.js'

const log = createLogger('network:get-manager')

export function getNetworkManager(node: Libp2p): NetworkManagerService {
  const svc = (node as any).services?.networkManager
  if (svc == null) {
    throw new Error('networkManager service is not registered on this libp2p node')
  }
  // Provide libp2p reference early to avoid MissingServiceError from components accessor
  try { (svc as any).setLibp2p?.(node) } catch (err) { log('getNetworkManager setLibp2p failed - %o', err) }
  return svc as NetworkManagerService
}


