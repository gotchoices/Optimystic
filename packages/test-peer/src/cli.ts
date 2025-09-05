#!/usr/bin/env node
import { Command } from 'commander';
import { getNetworkManager, createLibp2pNode, StorageRepo, BlockStorage, MemoryRawStorage, FileRawStorage, Libp2pKeyPeerNetwork, RepoClient } from '@optimystic/db-p2p';
import { Diary, NetworkTransactor, BTree, ITransactor, BlockGets, GetBlockResults, TrxBlocks, BlockTrxStatus, PendRequest, PendResult, CommitRequest, CommitResult } from '@optimystic/db-core';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'node:crypto';

// Simple local transactor for single-node scenarios
class LocalTransactor implements ITransactor {
	constructor(private storageRepo: any) { }

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		return await this.storageRepo.get(blockGets);
	}

	async getStatus(trxRefs: TrxBlocks[]): Promise<BlockTrxStatus[]> {
		throw new Error("Method not implemented.");
	}

	async pend(blockTrx: PendRequest): Promise<PendResult> {
		return await this.storageRepo.pend(blockTrx);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		return await this.storageRepo.commit(request);
	}

	async cancel(trxRef: TrxBlocks): Promise<void> {
		return await this.storageRepo.cancel(trxRef);
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

class TestPeerSession {
	private session: NetworkSession | null = null;
	private rl: readline.Interface | null = null;

	private async waitForFirstConnection(node: any, timeoutMs: number): Promise<void> {
		if (node.getConnections().length > 0) return;
		await new Promise<void>((resolve) => {
			const onConnect = (_evt: any) => {
				cleanup();
				resolve();
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, timeoutMs);
			const add = (node.addEventListener ?? node.connectionManager?.addEventListener)?.bind(node.addEventListener ? node : node.connectionManager);
			const remove = (node.removeEventListener ?? node.connectionManager?.removeEventListener)?.bind(node.removeEventListener ? node : node.connectionManager);
			const cleanup = () => {
				clearTimeout(timer);
				try { remove?.('peer:connect', onConnect as any); } catch { /* ignore */ }
			};
			try { add?.('peer:connect', onConnect as any); } catch { /* ignore */ }
		});
	}

	private async warmUpKadDHT(node: any): Promise<void> {
		try {
			const hadConn = node.getConnections().length > 0;
			if (!hadConn) {
				return; // no peers to warm up against
			}
    const keys: Uint8Array[] = [
        node.peerId.toMultihash().bytes,
        randomBytes(32),
        randomBytes(32),
        randomBytes(32)
      ];
			const budgetMs = 15000;
			await Promise.all(keys.map(async (key) => {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), budgetMs);
				try {
          for await (const _peer of node.peerRouting.getClosestPeers(key, { signal: ctl.signal, useCache: true })) {
						break; // only need first result to seed the table
					}
				} catch (error) {
					if (error instanceof Error && error.name === 'AbortError') {
						console.log('🧭 DHT warm-up: timed out (non-fatal)');
					} else {
						console.warn('⚠️ DHT warm-up issue:', error);
					}
				}
				finally { clearTimeout(t); }
			}));
		} catch (error) {
			console.warn('⚠️ DHT warm-up wrapper issue:', error);
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
		bootstrap?: string;
		bootstrapFile?: string;
		id?: string;
		relay?: boolean;
		network?: string;
		storage?: 'memory' | 'file';
		storagePath?: string;
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
				const contents = fs.readFileSync(filePath, 'utf-8');
				const json = JSON.parse(contents) as { multiaddrs?: string[] } | { nodes?: { multiaddrs: string[] }[] };
				if (Array.isArray((json as any).nodes)) {
					for (const n of (json as any).nodes) {
						if (Array.isArray(n.multiaddrs)) bootstrapNodes.push(...n.multiaddrs);
					}
				} else if (Array.isArray((json as any).multiaddrs)) {
					bootstrapNodes.push(...(json as any).multiaddrs);
				}
			} catch (err) {
				console.error('❌ Failed to read bootstrap file:', (err as Error).message);
			}
		}

		// Create libp2p node
		const node = await createLibp2pNode({
			port: parseInt(options.port || '0'),
			bootstrapNodes,
			id: options.id,
			relay: options.relay || false,
			networkName: options.network || 'optimystic-test',
			storageType: options.storage || 'memory',
			storagePath: options.storagePath,
			// CLI should default to server-mode DHT with kBucketSize tuned for overlap
			dhtClientMode: false,
			dhtKBucketSize: 20
		});

		console.log(`✅ Node started with ID: ${node.peerId.toString()}`);
		console.log(`📡 Listening on:`);
		const addrs: string[] = [];
		node.getMultiaddrs().forEach((ma: any) => {
			const s = ma.toString();
			addrs.push(s);
			console.log(`   ${s}`);
		});

		// Set up storage layer
		const rawStorage = options.storage === 'file'
			? new FileRawStorage(options.storagePath!)
			: new MemoryRawStorage();
		const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));

		// Create key network implementation using libp2p
		const keyNetwork = new Libp2pKeyPeerNetwork(node);

    // Create peer network implementation
    const peerNetwork = {
      async connect(peerId: any, protocol: string, options: any) {
        return node.dialProtocol(peerId, [protocol], { ...(options ?? {}), runOnLimitedConnection: true, negotiateFully: false });
      }
    };

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
						? storageRepo
						: RepoClient.create(peerId, keyNetwork);
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

		// Network manager readiness (service-based)
		const nm = getNetworkManager(node);
		await nm.ready();
		if (bootstrapNodes.length > 0 && (nm as any).awaitHealthy) {
			const ok = await (nm as any).awaitHealthy(1, 5000);
			console.log(`🧭 Network ${ok ? 'healthy' : 'not healthy yet'} (remotes in peerStore=${ok ? '>=1' : '0'})`);
		} else {
			console.log('🧭 Network ready');
		}

		// Optionally announce node info to a file for launchers/mesh setups
		if (options.announceFile) {
			try {
				const info = {
					peerId: node.peerId.toString(),
					multiaddrs: addrs,
					port: parseInt(options.port || '0'),
					networkName: options.network || 'optimystic-test',
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
		const session = this.requireSession();

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
const session = new TestPeerSession();

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
	.name('optimystic-test-peer')
	.description('Optimystic P2P Database Test Client')
	.version('0.0.1');

// Interactive mode - network-first approach
program
	.command('interactive')
	.description('Start interactive mode (default behavior)')
	.option('-p, --port <number>', 'Port to listen on', '0')
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic-test')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
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
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('--bootstrap-file <path>', 'Path to JSON containing bootstrap multiaddrs or node list')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic-test')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
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
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name', 'optimystic-test')
	.option('-s, --storage <type>', 'Storage type: memory or file', 'memory')
	.option('--storage-path <path>', 'Path for file storage')
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
