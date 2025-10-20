import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

type NodeInfo = {
  peerId: string
  multiaddrs: string[]
  port: number
  networkName: string
  timestamp: number
  pid: number
}

async function waitForFile(file: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Timeout waiting for ${file}`)
}

function startNode({ port, bootstrap, announceFile, extraArgs = [] as string[] }: { port: number, bootstrap?: string, announceFile?: string, extraArgs?: string[] }) {
  const args = [
    'packages/test-peer/dist/src/cli.js',
    'service',
    '--port', String(port),
    '--network', 'optimystic-test',
    ...(bootstrap ? ['--bootstrap', bootstrap] : []),
    '--storage', 'memory',
    ...(announceFile ? ['--announce-file', announceFile] : [])
  ].filter(Boolean)

  const child = spawn('node', args, { stdio: 'inherit' })
  return child
}

async function readNodeInfo(file: string): Promise<NodeInfo> {
  const text = await fs.promises.readFile(file, 'utf-8')
  return JSON.parse(text)
}

async function main() {
	const n = parseInt(process.env.MESH_NODES || '2', 10)
	const basePort = parseInt(process.env.MESH_BASE_PORT || '8011', 10)
	const workDir = path.join(process.cwd(), '.mesh')
	fs.mkdirSync(workDir, { recursive: true })

	const files = Array.from({ length: n }, (_, i) => path.join(workDir, `node-${i + 1}.json`))
	const children: ReturnType<typeof spawn>[] = []
	const readyFile = path.join(workDir, 'mesh-ready.json')

	// Delete old ready file to signal mesh is starting
	if (fs.existsSync(readyFile)) {
		fs.unlinkSync(readyFile)
	}

	// Check if we should reuse peer IDs (default: false for clean starts)
	const reusePeerIds = process.env.MESH_REUSE_IDS === 'true'
	const existingPeerIds: (string | undefined)[] = []

	if (reusePeerIds) {
		// Try to load existing peer IDs from previous runs
		for (let i = 0; i < n; i++) {
			const file = files[i]!
			try {
				if (fs.existsSync(file)) {
					const info = await readNodeInfo(file)
					existingPeerIds[i] = info.peerId
					console.log(`Reusing peer ID from ${path.basename(file)}: ${info.peerId}`)
				} else {
					existingPeerIds[i] = undefined
				}
			} catch {
				existingPeerIds[i] = undefined
			}
		}
	} else {
		// Clean start - delete old node files to prevent stale peer ID pollution
		for (let i = 0; i < n; i++) {
			const file = files[i]!
			if (fs.existsSync(file)) {
				fs.unlinkSync(file)
				console.log(`Deleted old ${path.basename(file)} for clean start`)
			}
			existingPeerIds[i] = undefined
		}
	}

	// Start nodes sequentially, each bootstrapping to all previous nodes
	const allBootstraps: string[] = []

	for (let i = 0; i < n; i++) {
		const port = basePort + i
		const file = files[i]!
		const id = existingPeerIds[i]

		// Use accumulated bootstrap list (empty for first node)
		const bootstrap = allBootstraps.length > 0 ? allBootstraps.join(',') : undefined

		children.push(startNode({
			port,
			bootstrap,
			announceFile: file,
			extraArgs: id ? ['--id', id] : []
		}))
		await waitForFile(file, 10000)

		// Read node info and add to bootstrap list for next nodes
		const nodeInfo = await readNodeInfo(file)
		// Prefer localhost for same-machine testing
		const localAddr = nodeInfo.multiaddrs.find(a => a.includes('/ip4/127.0.0.1/'))
		if (localAddr) {
			allBootstraps.push(localAddr)
		} else if (nodeInfo.multiaddrs.length > 0) {
			allBootstraps.push(nodeInfo.multiaddrs[0]!)
		}
	}

	// Write ready file with all node info for clients to bootstrap from
	const allNodes = await Promise.all(files.map(f => readNodeInfo(f)))
	fs.writeFileSync(readyFile, JSON.stringify({
		ready: true,
		timestamp: Date.now(),
		nodes: allNodes.map(n => ({ peerId: n.peerId, multiaddrs: n.multiaddrs }))
	}, null, 2))

	console.log('---- Mesh started. Press Ctrl+C to stop.')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})


