import type { Libp2p } from '@libp2p/interface';
import type { IKeyNetwork } from '@optimystic/db-core';
import { Libp2pKeyPeerNetwork } from '@optimystic/db-p2p';
import { createLibp2pNode } from '@optimystic/db-p2p';
import type { LibP2PNodeOptions, CustomImplementationRegistry } from '../types.js';

/**
 * Global registry for custom implementations
 */
const customRegistry: CustomImplementationRegistry = {
  transactors: new Map(),
  keyNetworks: new Map(),
};

/**
 * Register a custom key network implementation
 */
export function registerKeyNetwork(name: string, implementation: new (...args: any[]) => IKeyNetwork): void {
  customRegistry.keyNetworks.set(name, implementation);
}

/**
 * Register a custom transactor implementation
 */
export function registerTransactor(name: string, implementation: new (...args: any[]) => any): void {
  customRegistry.transactors.set(name, implementation);
}

/**
 * Create a key network instance based on configuration
 */
export async function createKeyNetwork(
  type: 'libp2p' | 'test' | string,
  libp2p?: Libp2p,
  libp2pOptions?: LibP2PNodeOptions
): Promise<IKeyNetwork> {
  switch (type) {
    case 'libp2p':
      return await createLibp2pKeyNetwork(libp2p, libp2pOptions);

    case 'test':
      return await createTestKeyNetwork();

    default:
      return await createCustomKeyNetwork(type);
  }
}

/**
 * Create a libp2p-based key network
 */
async function createLibp2pKeyNetwork(
  existingLibp2p?: Libp2p,
  options?: LibP2PNodeOptions
): Promise<IKeyNetwork> {
  let libp2p: Libp2p;

  if (existingLibp2p) {
    libp2p = existingLibp2p;
  } else {
    // Create a new libp2p node with default options
    const nodeOptions = {
      port: options?.port ?? 0, // Use random port if not specified
      networkName: options?.networkName ?? 'optimystic',
      bootstrapNodes: options?.bootstrapNodes ?? [],
    };

    libp2p = await createLibp2pNode(nodeOptions);
  }

  return new Libp2pKeyPeerNetwork(libp2p);
}

/**
 * Create a test key network (for testing purposes)
 */
async function createTestKeyNetwork(): Promise<IKeyNetwork> {
  // Provide a local stub to avoid build-time dependency on non-existent test utilities
  return {
    async findCoordinator() {
      throw new Error('Test key network is not available in this build.');
    },
    async findCluster() {
      throw new Error('Test key network is not available in this build.');
    },
  };
}

/**
 * Create a custom key network implementation
 */
async function createCustomKeyNetwork(name: string): Promise<IKeyNetwork> {
  const CustomKeyNetwork = customRegistry.keyNetworks.get(name);
  if (!CustomKeyNetwork) {
    throw new Error(`Custom key network '${name}' not found. Register it first using registerKeyNetwork().`);
  }

  return new CustomKeyNetwork();
}

/**
 * Get the custom implementation registry (for testing/debugging)
 */
export function getCustomRegistry(): CustomImplementationRegistry {
  return customRegistry;
}
