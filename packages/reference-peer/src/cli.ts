#!/usr/bin/env node
import { Command } from 'commander';
import debug from 'debug';
import { getNetworkManager, createLibp2pNode, StorageRepo, BlockStorage, MemoryRawStorage, Libp2pKeyPeerNetwork, RepoClient, ArachnodeFretAdapter, type IRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { Diary, NetworkTransactor, BTree, ITransactor, BlockGets, GetBlockResults, ActionBlocks, BlockActionStatus, PendRequest, PendResult, CommitRequest, CommitResult } from '@optimystic/db-core';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';

const logDebug = debug('optimystic:ref-peer');

// Simple local transactor for single-node scenarios
class LocalTransactor implements ITransactor {
	constructor(private storageRepo: any) { }

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		return await this.storageRepo.get(blockGets);
	}

	async getStatus(_actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]> {
		throw new Error("Method not implemented.");
	}

	async pend(blockAction: PendRequest): Promise<PendResult> {
		return await this.storageRepo.pend(blockAction);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		return await this.storageRepo.commit(request);
	}

	async cancel(actionRef: ActionBlocks): Promise<void> {
		return await this.storageRepo.cancel(actionRef);
	}
}

interface NetworkSession {
	node: any;
	transactor: NetworkTransactor | LocalTransactor;
	diaries: Map<string, Diary<any>>;
	trees: Map<string, BTree<any, any>>;
	isConnected: boolean;
	isSingleNode: boolean; // Track if we're in single-node mode
}

class PeerSession {
	private session: NetworkSession | null = null;
	private rl: readline.Interface | null = null;

	private parseStorageCapacity(options: { storageCapacity?: string }): number | undefined {
		if (!options.storageCapacity) return undefined;
		const parsed = Number(options.storageCapacity);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new Error('--storage-capacity must be a positive number of bytes');
		}
		return parsed;
	}

	private async waitForFretReady(node: any): Promise<void> {
		try {
			const fret = (node as any).services?.fret;
			if (!fret) {
				console.log('⚠️  FRET service not available');
				logDebug('FRET service missing on node');
				return;
			}

			const hadConn = node.getConnections().length > 0;
			if (!hadConn) {
				console.log('🔗 No connections yet, skipping FRET warm-up');
				logDebug('skipping FRET ready check - no connections');
				return;
			}

			if (typeof fret.ready !== 'function') {
				console.log('⚠️  FRET service does not expose ready()');
				logDebug('FRET ready() not present, skipping wait');
				return;
			}
			logDebug('waiting for FRET ready');
			await fret.ready();
			console.log('✅ FRET service ready');

			// Log FRET diagnostics
			const knownPeers = typeof fret.listPeers === 'function' ? fret.listPeers() : [];
			const netSize = typeof fret.getNetworkSizeEstimate === 'function' ? fret.getNetworkSizeEstimate() : undefined;
			logDebug('FRET diagnostics after ready', {
				knownPeers: knownPeers.map((p: any) => p.id ?? p.toString()),
				knownPeerCount: knownPeers.length,
				networkSizeEstimate: netSize
			});
			console.log(`📊 FRET knows ${knownPeers.length} peer(s)`);
		} catch (error) {
			console.warn('⚠️ FRET readiness check issue:', error);
			logDebug('FRET readiness check issue', error);
		}
	}

	private async waitForFretConvergence(node: any, minPeers: number, timeoutMs: number): Promise<boolean> {
		const fret = (node as any).services?.fret;
		if (!fret || typeof fret.listPeers !== 'function') {
			logDebug('FRET convergence check skipped - no listPeers method');
			return false;
		}

		const start = Date.now();
		let lastCount = 0;
		while (Date.now() - start < timeoutMs) {
			const peers = fret.listPeers();
			const count = Array.isArray(peers) ? peers.length : 0;
			if (count !== lastCount) {
				logDebug('FRET convergence progress', { peerCount: count, target: minPeers, peers: peers.map((p: any) => p.id) });
				lastCount = count;
			}
			if (count >= minPeers) {
				console.log(`✅ FRET discovered ${count} peer(s)`);
				return true;
			}
			await new Promise(r => setTimeout(r, 200));
		}

		const finalPeers = fret.listPeers();
		const finalCount = Array.isArray(finalPeers) ? finalPeers.length : 0;
		console.log(`✅ FRET discovered ${finalCount} peer(s)`);
		logDebug('FRET convergence completed', {
			finalPeerCount: finalCount,
			targetPeers: minPeers,
			elapsed: timeoutMs,
			peers: finalPeers.map((p: any) => p.id)
		});
		// Return true if we have at least some peers, even if not the target
		return finalCount > 0;
	}

	private logRingInfo(node: any, totalCapacityOverride?: number): void {
		const fret = (node as any).services?.fret;
		if (!fret) {
			logDebug('ring info unavailable (no FRET service)');
			return;
		}
		const adapter = new ArachnodeFretAdapter(fret);
		const myInfo = adapter.getMyArachnodeInfo();
		if (myInfo) {
			logDebug('local arachnode info', myInfo);
		} else {
			logDebug('no arachnode info published yet');
		}
		const rings = adapter.getKnownRings();
		const stats = adapter.getRingStats();
		logDebug('discovered ring depths', rings);
		if (stats.length) {
			logDebug('ring statistics', stats);
		}
		if (totalCapacityOverride) {
			logDebug('storage capacity override active', { bytes: totalCapacityOverride });
		}
	}

	private async ensureDiary(name: string): Promise<Diary<any>> {
		const session = this.requireSession();
		const existing = session.diaries.get(name);
		if (existing) return existing;
		// Diary.create uses Collection.createOrOpen under the hood, so this will
		// attach to an existing diary in the network or create it if missing.
		const diary = await Diary.create(session.transactor, name);
		session.diaries.set(name, diary);
		return diary;
	}

	async startNetwork(options: {
		port?: string;
		wsPort?: string;
		wsHost?: string;
		tcp?: boolean;
		bootstrap?: string;
		bootstrapFile?: string;
		id?: string;
		relay?: boolean;
		network?: string;
		fretProfile?: 'edge' | 'core';
		storage?: 'memory' | 'file';
		storagePath?: string;
		storageCapacity?: string;
		announceFile?: string;
		offline?: boolean;
	}): Promise<void> {
		if (this.session?.isConnected) {
			console.log('⚠️  Already connected to network');
			return;
		}

		console.log('🚀 Starting P2P node...');

		// Validate storage options
		if (options.storage === 'file' && !options.storagePath) {
			throw new Error('--storage-path is required when using file storage');
		}

		// Create storage directory if needed
		if (options.storage === 'file' && options.storagePath) {
			fs.mkdirSync(options.storagePath, { recursive: true });
		}

		// Resolve bootstrap nodes from CLI args and/or file
		let bootstrapNodes: string[] = options.bootstrap ? options.bootstrap.split(',') : [];
		if (options.bootstrapFile) {
			try {
				const filePath = path.resolve(options.bootstrapFile);
				const stat = fs.statSync(filePath);

				// If it's a directory, wait for mesh-ready.json and use it
				if (stat.isDirectory()) {
					const readyFile = path.join(filePath, 'mesh-ready.json');

					// Wait for mesh-ready.json (up to 30 seconds)
					console.log('⏳ Waiting for mesh to be ready...');
					const waitStart = Date.now();
					while (!fs.existsSync(readyFile) && Date.now() - waitStart < 30000) {
						await new Promise(r => setTimeout(r, 100));
					}

					if (fs.existsSync(readyFile)) {
						// Use mesh-ready.json which has current node info
						const readyContents = fs.readFileSync(readyFile, 'utf-8');
						const readyJson = JSON.parse(readyContents) as { ready: boolean; nodes: { peerId: string; multiaddrs: string[] }[] };
						logDebug('loading bootstrap from mesh-ready', { nodeCount: readyJson.nodes.length });

						for (const node of readyJson.nodes) {
							if (Array.isArray(node.multiaddrs) && node.multiaddrs.length > 0) {
								// Prefer localhost for same-machine testing
								const localAddr = node.multiaddrs.find(a => a.includes('/ip4/127.0.0.1/'));
								bootstrapNodes.push(localAddr ?? node.multiaddrs[0]!);
								logDebug('loaded bootstrap from mesh-ready', { peerId: node.peerId, addr: localAddr ?? node.multiaddrs[0] });
							}
						}
						console.log(`📋 Loaded ${bootstrapNodes.length} bootstrap address(es) from mesh-ready.json`);
					} else {
						console.warn('⚠️  Timeout waiting for mesh-ready.json, falling back to node-*.json files');
						// Fallback to old behavior
						const files = fs.readdirSync(filePath).filter(f => f.startsWith('node-') && f.endsWith('.json'));
						logDebug('loading bootstrap from directory (fallback)', { dir: filePath, files });
						for (const file of files) {
							const fullPath = path.join(filePath, file);
							try {
								const contents = fs.readFileSync(fullPath, 'utf-8');
								const json = JSON.parse(contents) as { multiaddrs?: string[]; peerId?: string };
								if (Array.isArray(json.multiaddrs) && json.multiaddrs.length > 0) {
									const localAddr = json.multiaddrs.find(a => a.includes('/ip4/127.0.0.1/'));
									bootstrapNodes.push(localAddr ?? json.multiaddrs[0]!);
									logDebug('loaded bootstrap from file', { file, peerId: json.peerId, addr: localAddr ?? json.multiaddrs[0] });
								}
							} catch (err) {
								logDebug('failed to read bootstrap file', { file: fullPath, error: (err as Error).message });
							}
						}
						console.log(`📋 Loaded ${bootstrapNodes.length} bootstrap address(es) from ${filePath}`);
					}
				} else {
					// Single file - existing logic
					const contents = fs.readFileSync(filePath, 'utf-8');
					const json = JSON.parse(contents) as { multiaddrs?: string[] } | { nodes?: { multiaddrs: string[] }[] };
					if (Array.isArray((json as any).nodes)) {
						for (const n of (json as any).nodes) {
							if (Array.isArray(n.multiaddrs)) bootstrapNodes.push(...n.multiaddrs);
						}
					} else if (Array.isArray((json as any).multiaddrs)) {
						bootstrapNodes.push(...(json as any).multiaddrs);
					}
				}
			} catch (err) {
				console.error('❌ Failed to read bootstrap file:', (err as Error).message);
			}
		}

		const storageCapacityBytes = this.parseStorageCapacity(options);
		if (storageCapacityBytes) {
			const humanReadable = storageCapacityBytes >= 1024 * 1024 * 1024 ? `${(storageCapacityBytes / (1024 * 1024 * 1024)).toFixed(2)} GB` : `${storageCapacityBytes} bytes`;
			console.log(`📦 Storage capacity override set to ${humanReadable}`);
			logDebug('storage capacity override set', { bytes: storageCapacityBytes, human: humanReadable });
		}
		logDebug('starting libp2p node', {
			port: options.port,
			bootstrapCount: bootstrapNodes.length,
			storage: options.storage,
			storagePath: options.storagePath,
			storageCapacityBytes,
			mode: options.offline ? 'offline' : 'distributed'
		});

		// Create storage provider based on options
		const createStorage = (): IRawStorage => {
			if (options.storage === 'file') {
				return new FileRawStorage(options.storagePath!);
			}
			return new MemoryRawStorage();
		};

		const wsPortNum = options.wsPort !== undefined ? parseInt(options.wsPort, 10) : undefined;
		if (wsPortNum !== undefined && (!Number.isFinite(wsPortNum) || wsPortNum < 0)) {
			throw new Error('--ws-port must be a non-negative integer');
		}
		const disableTcp = options.tcp === false;

		const node = await createLibp2pNode({
			port: parseInt(options.port || '0'),
			wsPort: wsPortNum,
			wsHost: options.wsHost,
			disableTcp,
			bootstrapNodes,
			id: options.id,
			relay: options.relay || false,
			networkName: options.network || 'optimystic',
			fretProfile: options.fretProfile,
			storage: createStorage,
			arachnode: {
				enableRingZulu: true,
				storage: storageCapacityBytes ? { totalBytes: storageCapacityBytes } : undefined
			}
		});

		console.log(`✅ Node started with ID: ${node.peerId.toString()}`);
		console.log(`📡 Listening on:`);
		const addrs: string[] = [];
		node.getMultiaddrs().forEach((ma: any) => {
			const s = ma.toString();
			addrs.push(s);
			console.log(`   ${s}`);
		});

		// Set up storage layer for local transactor (uses same storage as node)
		const rawStorage = createStorage();
		const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));

		// Create key network implementation using libp2p
		const keyNetwork = new Libp2pKeyPeerNetwork(node);

		// Get the coordinated repo that includes cluster consensus
		const coordinatedRepo = (node as any).coordinatedRepo;
		if (!coordinatedRepo) {
			throw new Error('coordinatedRepo not available on node');
		}

		// Determine operating mode
		const isOffline = Boolean(options.offline);
		console.log(`🔧 Mode: ${isOffline ? 'Offline (LocalTransactor)' : 'Distributed (NetworkTransactor)'}`);

		// Create appropriate transactor based on mode
		let transactor: NetworkTransactor | LocalTransactor;
		if (isOffline) {
			transactor = new LocalTransactor(storageRepo);
		} else {
			transactor = new NetworkTransactor({
				timeoutMs: 30000,
				abortOrCancelTimeoutMs: 10000,
				keyNetwork,
				getRepo: (peerId) => {
					return peerId.toString() === node.peerId.toString()
						? coordinatedRepo  // Use coordinated repo for self to enable cluster consensus
						: RepoClient.create(peerId, keyNetwork, `/optimystic/${options.network || 'optimystic'}`);
				}
			});
		}

		this.session = {
			node,
			transactor,
			diaries: new Map(),
			trees: new Map(),
			isConnected: true,
			isSingleNode: isOffline
		};

		console.log('✅ Distributed transaction system initialized');
		logDebug('session initialized', { peerId: node.peerId.toString(), offline: isOffline, bootstrap: bootstrapNodes });

		// Network manager readiness (service-based)
		const nm = getNetworkManager(node);
		await nm.ready();
		if (bootstrapNodes.length > 0 && (nm as any).awaitHealthy) {
			// Require at least 2 connections when multiple bootstrap nodes available
			// This ensures better mesh connectivity before operations begin
			const minConnections = Math.min(2, bootstrapNodes.length);
			const ok = await (nm as any).awaitHealthy(minConnections, 10000);
			console.log(`🧭 Network ${ok ? 'healthy' : 'not healthy yet'} (active connections=${ok ? `>=${minConnections}` : '<' + minConnections})`);
			logDebug('network manager status', { healthy: ok, status: nm.getStatus?.() });
		} else {
			console.log('🧭 Network ready');
			logDebug('network manager ready', { status: nm.getStatus?.() });
		}

		// Wait for FRET to be ready
		await this.waitForFretReady(node);
		this.logRingInfo(node, storageCapacityBytes);

		// Optionally announce node info to a file for launchers/mesh setups
		if (options.announceFile) {
			try {
				const info = {
					peerId: node.peerId.toString(),
					multiaddrs: addrs,
					port: parseInt(options.port || '0'),
					networkName: options.network || 'optimystic',
					timestamp: Date.now(),
					pid: process.pid
				};
				fs.mkdirSync(path.dirname(options.announceFile), { recursive: true });
				fs.writeFileSync(options.announceFile, JSON.stringify(info, null, 2), 'utf-8');
				console.log(`📝 Announced node info to ${options.announceFile}`);
			} catch (err) {
				console.error('❌ Failed to write announce file:', (err as Error).message);
			}
		}

		// Wait for network bootstrap if we have bootstrap nodes
		if (bootstrapNodes.length > 0) {
			console.log('🔄 Bootstrapping to network...');
			await new Promise(resolve => setTimeout(resolve, 2000));
			console.log('✅ Network bootstrap complete');
			this.logRingInfo(node, storageCapacityBytes);

			// Wait for FRET to discover peers (best effort, non-blocking)
			// FRET neighbor announcements happen asynchronously and take time to propagate
			const minPeers = 1;  // At least discover one peer
			if (bootstrapNodes.length > 0) {
				console.log(`🔍 Waiting for FRET to discover peers...`);
				await this.waitForFretConvergence(node, minPeers, 8000);
			}
		}
	}

	async stopNetwork(): Promise<void> {
		if (!this.session?.isConnected) {
			console.log('⚠️  Not connected to network');
			return;
		}

		console.log('🛑 Stopping network...');
		await this.session.node.stop();
		this.session.isConnected = false;
		console.log('✅ Network stopped');
	}

	private requireSession(): NetworkSession {
		if (!this.session?.isConnected) {
			throw new Error('Not connected to network. Start network first.');
		}
		return this.session;
	}

	async createDiary(name: string): Promise<void> {
		const session = this.requireSession();

		if (session.diaries.has(name)) {
			throw new Error(`Diary '${name}' already exists`);
		}

		console.log(`📝 Creating diary: ${name}`);
		const diary = await Diary.create(session.transactor, name);
		session.diaries.set(name, diary);
		console.log(`✅ Successfully created diary: ${name}`);
	}

	async addEntry(diaryName: string, content: string): Promise<void> {
		const session = this.requireSession();

		const diary = await this.ensureDiary(diaryName);

		console.log(`📝 Adding entry to diary ${diaryName}: ${content}`);
		const entry = {
			content,
			timestamp: new Date().toISOString(),
			author: session.node.peerId.toString()
		};

		await diary.append(entry);
		console.log(`✅ Successfully added entry to diary: ${diaryName}`);
	}

	async listDiaries(): Promise<void> {
		const session = this.requireSession();

		if (session.diaries.size === 0) {
			console.log('📁 No diaries created yet');
			return;
		}

		console.log('📚 Created diaries:');
		for (const [name, _] of session.diaries) {
			console.log(`  - ${name}`);
		}
	}

	async readDiary(diaryName: string): Promise<void> {
		this.requireSession();

		const diary = await this.ensureDiary(diaryName);

		console.log(`📖 Reading entries from diary: ${diaryName}`);
		let entryCount = 0;

		for await (const entry of diary.select()) {
			entryCount++;
			console.log(`📄 Entry ${entryCount}:`);
			console.log(`   Content: ${entry.content}`);
			console.log(`   Timestamp: ${entry.timestamp}`);
			if (entry.author) {
				console.log(`   Author: ${entry.author}`);
			}
			console.log('');
		}

		if (entryCount === 0) {
			console.log('📁 No entries found in this diary');
		} else {
			console.log(`📊 Total entries: ${entryCount}`);
		}
	}

	async showStatus(): Promise<void> {
		if (!this.session?.isConnected) {
			console.log('❌ Not connected to network');
			return;
		}

		const session = this.session;
		console.log('🌐 Network Status:');
		console.log(`   Node ID: ${session.node.peerId.toString()}`);
		console.log(`   Connected: ${session.isConnected}`);
		console.log(`   Diaries: ${session.diaries.size}`);
		console.log(`   Trees: ${session.trees.size}`);

		const multiaddrs = session.node.getMultiaddrs();
		console.log(`   Addresses (${multiaddrs.length}):`);
		multiaddrs.forEach((ma: any) => {
			console.log(`     ${ma.toString()}`);
		});
	}

	async startInteractive(): Promise<void> {
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: 'optimystic> '
		});

		console.log('\n🎮 Interactive mode started. Type "help" for commands, "exit" to quit.');
		this.rl.prompt();

		this.rl.on('line', async (line) => {
			const args = line.trim().split(/\s+/);
			const command = args[0];

			try {
				switch (command) {
					case 'help':
						this.showHelp();
						break;
					case 'status':
						await this.showStatus();
						break;
					case 'create-diary':
						if (args.length < 2) {
							console.log('Usage: create-diary <name>');
						} else {
							await this.createDiary(args[1]!);
						}
						break;
					case 'add-entry':
						if (args.length < 3) {
							console.log('Usage: add-entry <diary-name> <content>');
						} else {
							const content = args.slice(2).join(' ');
							await this.addEntry(args[1]!, content);
						}
						break;
					case 'list-diaries':
						await this.listDiaries();
						break;
					case 'read-diary':
						if (args.length < 2) {
							console.log('Usage: read-diary <name>');
						} else {
							await this.readDiary(args[1]!);
						}
						break;
					case 'exit':
					case 'quit':
						console.log('👋 Goodbye!');
						await this.stopNetwork();
						process.exit(0);
						break;
					case '':
						// Empty line, just re-prompt
						break;
					default:
						console.log(`Unknown command: ${command}. Type "help" for available commands.`);
						break;
				}
			} catch (error) {
				console.error(`❌ Error: ${error instanceof Error ? error.message : error}`);
			}

			this.rl?.prompt();
		});

		this.rl.on('SIGINT', async () => {
			console.log('\n👋 Shutting down...');
			await this.stopNetwork();
			process.exit(0);
		});
	}

	private showHelp(): void {
		console.log(`
🎮 Available Commands:
  help                    - Show this help message
  status                  - Show network and session status
  create-diary <name>     - Create a new diary collection
  add-entry <diary> <content> - Add an entry to a diary
  list-diaries           - List all created diaries
  read-diary <name>      - Read all entries from a diary
  exit/quit              - Exit interactive mode
`);
	}

	async cleanup(): Promise<void> {
		if (this.rl) {
			this.rl.close();
		}
		if (this.session && this.session.isConnected) {
			await this.stopNetwork();
		}
	}
}

const program = new Command();
const session = new PeerSession();

// Ensure cleanup on process exit
process.on('SIGINT', async () => {
	await session.cleanup();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await session.cleanup();
	process.exit(0);
});

program
	.name('optimystic-reference-peer')
	.description('Optimystic P2P Database Reference Peer')
	.version('0.0.1');

// Interactive mode - network-first approach
program
	.command('interactive')
	.description('Start interactive mode (default behavior)')
	.option('-p, --port <number>', 'Port to listen on', '0')
	.option('--ws-port <number>', 'WebSocket port to listen on (e.g. 9091); enables /ws listen for browser/RN peers')
	.option('--ws-host <ip>', 'Interface to bind the WS listener to', '0.0.0.0')
	.option('--no-tcp', 'Disable the default TCP listen (browser-only bootstrap)')
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic')
	.option('--fret-profile <profile>', "FRET profile: 'edge' or 'core'", 'edge')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
	.option('--storage-capacity <bytes>', 'Override storage capacity in bytes (for ring selection)')
	.option('--bootstrap-file <path>', 'Path to JSON containing bootstrap multiaddrs or node list')
	.option('--announce-file <path>', 'Write node info (peerId, multiaddrs) to this JSON file for mesh launchers')
	.action(async (options) => {
		try {
			await session.startNetwork(options);
			await session.startInteractive();
		} catch (error) {
			if (error instanceof Error) {
				console.error('❌ Error:', error.message);
				if (error.stack) console.error(error.stack);
			} else {
				console.error('❌ Error:', error);
			}
			process.exit(1);
		}
	});

// Headless service node (no REPL); useful for mesh nodes in launch profiles
program
	.command('service')
	.description('Start a headless service node (no interactive prompt)')
	.option('-p, --port <number>', 'Port to listen on', '0')
	.option('--ws-port <number>', 'WebSocket port to listen on (e.g. 9091); enables /ws listen for browser/RN peers')
	.option('--ws-host <ip>', 'Interface to bind the WS listener to', '0.0.0.0')
	.option('--no-tcp', 'Disable the default TCP listen (browser-only bootstrap)')
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('--bootstrap-file <path>', 'Path to JSON containing bootstrap multiaddrs or node list')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic')
	.option('--fret-profile <profile>', "FRET profile: 'edge' or 'core'", 'edge')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
	.option('--storage-capacity <bytes>', 'Override storage capacity in bytes (for ring selection)')
	.option('--announce-file <path>', 'Write node info (peerId, multiaddrs) to this JSON file for mesh launchers')
	.action(async (options) => {
		try {
			await session.startNetwork(options);
			// Keep process alive
			process.stdin.resume();
		} catch (error) {
			if (error instanceof Error) {
				console.error('❌ Error:', error.message);
				if (error.stack) console.error(error.stack);
			} else {
				console.error('❌ Error:', error);
			}
			process.exit(1);
		}
	});

// Single-action mode commands
program
	.command('run')
	.description('Connect to network, run a single action, optionally stay connected')
	.option('-p, --port <number>', 'Port to listen on', '0')
	.option('--ws-port <number>', 'WebSocket port to listen on (e.g. 9091); enables /ws listen for browser/RN peers')
	.option('--ws-host <ip>', 'Interface to bind the WS listener to', '0.0.0.0')
	.option('--no-tcp', 'Disable the default TCP listen (browser-only bootstrap)')
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic')
	.option('--fret-profile <profile>', "FRET profile: 'edge' or 'core'", 'edge')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
	.option('--storage-capacity <bytes>', 'Override storage capacity in bytes (for ring selection)')
	.option('--bootstrap-file <path>', 'Path to JSON containing bootstrap multiaddrs or node list')
	.option('--stay-connected', 'Stay connected after action completes')
	.option('--announce-file <path>', 'Write node info (peerId, multiaddrs) to this JSON file for mesh launchers')
	.requiredOption('-a, --action <action>', 'Action to perform: create-diary, add-entry, list-diaries, read-diary')
	.option('--diary <name>', 'Diary name (required for diary operations)')
	.option('--content <content>', 'Entry content (required for add-entry)')
	.action(async (options) => {
		try {
			await session.startNetwork(options);

			// Perform the requested action
			switch (options.action) {
				case 'create-diary':
					if (!options.diary) {
						throw new Error('--diary is required for create-diary action');
					}
					await session.createDiary(options.diary);
					break;
				case 'add-entry':
					if (!options.diary || !options.content) {
						throw new Error('--diary and --content are required for add-entry action');
					}
					await session.addEntry(options.diary, options.content);
					break;
				case 'list-diaries':
					await session.listDiaries();
					break;
				case 'read-diary':
					if (!options.diary) {
						throw new Error('--diary is required for read-diary action');
					}
					await session.readDiary(options.diary);
					break;
				default:
					throw new Error(`Unknown action: ${options.action}`);
			}

			if (options.stayConnected) {
				console.log('🔄 Staying connected. Starting interactive mode...');
				await session.startInteractive();
			} else {
				console.log('✅ Action completed. Disconnecting...');
				await session.stopNetwork();
			}

		} catch (error) {
			if (error instanceof Error) {
				console.error('❌ Error:', error.message);
				if (error.stack) console.error(error.stack);
			} else {
				console.error('❌ Error:', error);
			}
			await session.cleanup();
			process.exit(1);
		}
	});

// Default to interactive mode if no command specified
if (process.argv.length <= 2) {
	process.argv.push('interactive');
}

program.parse();
