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
    'packages/test-peer/dist/cli.js',
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

  // Start first node
  const port1 = basePort
  const file1 = files[0]!
  children.push(startNode({ port: port1, bootstrap: undefined, announceFile: file1 }))
  await waitForFile(file1, 10000)
  const info1 = await readNodeInfo(file1)

  // Build bootstrap list
  const bootstrapList = info1.multiaddrs.join(',')

  // Start remaining nodes
  for (let i = 1; i < n; i++) {
    const port = basePort + i
    const file = files[i]!
    children.push(startNode({ port, bootstrap: bootstrapList, announceFile: file }))
    await waitForFile(file, 10000)
  }

  console.log('Mesh started. Press Ctrl+C to stop.')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})


