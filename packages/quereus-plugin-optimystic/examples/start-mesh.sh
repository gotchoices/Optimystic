#!/bin/bash
# Simple script to start a 2-node Optimystic mesh for testing
# Usage: ./start-mesh.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Starting Optimystic Mesh Test Environment"
echo ""

# Check if quoomb is installed
if ! command -v quoomb &> /dev/null; then
    echo "❌ Error: quoomb is not installed"
    echo "Install with: npm install -g @quereus/quoomb-cli"
    exit 1
fi

# Start node 1 in background
echo "📡 Starting Node 1 (port 8011)..."
quoomb --config "$SCRIPT_DIR/quoomb.config.node1.json" > /tmp/quoomb-node1.log 2>&1 &
NODE1_PID=$!

# Wait for node 1 to start and extract multiaddr
echo "⏳ Waiting for Node 1 to start..."
sleep 3

# Extract multiaddr from log (this is a placeholder - actual implementation depends on quoomb output)
# For now, just show instructions
echo ""
echo "✅ Node 1 started (PID: $NODE1_PID)"
echo ""
echo "📋 Next steps:"
echo "1. Check Node 1 log: tail -f /tmp/quoomb-node1.log"
echo "2. Find the listening multiaddr (e.g., /ip4/127.0.0.1/tcp/8011/p2p/12D3KooW...)"
echo "3. Edit quoomb.config.node2.json and replace REPLACE_WITH_NODE1_MULTIADDR"
echo "4. Start Node 2: quoomb --config quoomb.config.node2.json"
echo ""
echo "Or use environment variable:"
echo "  BOOTSTRAP_ADDR=<multiaddr> quoomb --config quoomb.config.node2.env.json"
echo ""
echo "To stop Node 1: kill $NODE1_PID"
echo ""

