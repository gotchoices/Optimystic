# Quoomb Configuration Examples

This directory contains example configuration files for using the Optimystic plugin with [Quoomb](https://github.com/Digithought/quereus/tree/main/packages/quoomb-cli), the interactive SQL console for Quereus.

## Quick Start

### Single Node (Development)

For local development without networking:

```bash
quoomb --config examples/quoomb.config.dev.json
```

Then in the Quoomb console:

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) 
  USING optimystic('tree://app/users');

INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob');

SELECT * FROM users;
```

### Multi-Node Mesh

**Terminal 1 - Start first node:**

```bash
quoomb --config examples/quoomb.config.node1.json
```

Copy the listening address shown (e.g., `/ip4/127.0.0.1/tcp/8011/p2p/12D3KooW...`)

**Terminal 2 - Start second node:**

Edit `quoomb.config.node2.json` and replace `REPLACE_WITH_NODE1_MULTIADDR` with the address from node1, then:

```bash
quoomb --config examples/quoomb.config.node2.json
```

Or use environment variables:

```bash
BOOTSTRAP_ADDR=/ip4/127.0.0.1/tcp/8011/p2p/12D3KooW... \
  quoomb --config examples/quoomb.config.node2.env.json
```

**Test distributed queries:**

In Terminal 1:
```sql
CREATE TABLE products (id INT PRIMARY KEY, name TEXT, price REAL) 
  USING optimystic('tree://shop/products');

INSERT INTO products VALUES (1, 'Widget', 19.99);
```

In Terminal 2:
```sql
SELECT * FROM products;  -- Sees data from node 1!

INSERT INTO products VALUES (2, 'Gadget', 49.99);
```

Back in Terminal 1:
```sql
SELECT * FROM products;  -- Sees both rows!
```

## Configuration Files

| File | Description |
|------|-------------|
| `quoomb.config.dev.json` | Development mode - no networking, test transactor |
| `quoomb.config.node1.json` | First node in mesh - bootstrap node |
| `quoomb.config.node2.json` | Second node - connects to node1 |
| `quoomb.config.node2.env.json` | Second node using environment variables |
| `quoomb.config.web.json` | Browser-based Quoomb Web configuration |

## Config Format

```json
{
  "plugins": [
    {
      "source": "npm:@optimystic/quereus-plugin-optimystic",
      "config": {
        "default_transactor": "network",
        "default_key_network": "libp2p",
        "enable_cache": true,
        "port": 8011,
        "networkName": "my-network",
        "bootstrap": "/ip4/127.0.0.1/tcp/8011/p2p/..."
      }
    }
  ],
  "autoload": true
}
```

### Plugin Source Formats

- `npm:@scope/package@version` - Load from npm with specific version
- `npm:@scope/package` - Load latest version from npm
- `github:user/repo/path/to/plugin.js` - Load from GitHub
- `https://example.com/plugin.js` - Load from URL
- `file:///absolute/path/plugin.js` - Load from local file

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `default_transactor` | string | `"network"` | Transactor type: `"network"` or `"test"` |
| `default_key_network` | string | `"libp2p"` | Key network: `"libp2p"` or `"test"` |
| `enable_cache` | boolean | `true` | Enable collection caching |
| `port` | number | `0` | libp2p port (0 = auto-assign) |
| `networkName` | string | `"optimystic"` | Network name for isolation |
| `bootstrap` | string | `""` | Bootstrap multiaddr (comma-separated for multiple) |

### Environment Variable Interpolation

Use `${VAR_NAME}` or `${VAR_NAME:-default}` syntax:

```json
{
  "config": {
    "port": "${OPTIMYSTIC_PORT:-8011}",
    "networkName": "${NETWORK_NAME:-default}",
    "bootstrap": "${BOOTSTRAP_ADDR}"
  }
}
```

## Config Resolution

Quoomb looks for config in this order (highest priority first):

1. `--config <path>` CLI argument
2. `QUOOMB_CONFIG` environment variable
3. `./quoomb.config.json` (current directory)
4. `~/.quoomb/config.json` (user home)
5. Built-in defaults

## Using with Quoomb Web

1. Open [Quoomb Web](https://quoomb.quereus.dev) in your browser
2. Click **Settings** → **Import Config**
3. Upload `quoomb.config.web.json` or paste the JSON
4. Config is saved to browser localStorage
5. Plugins auto-load on page refresh

**Note:** Browser-based libp2p has limitations. For best results, use WebSocket-enabled bootstrap nodes.

## Advanced Usage

### Custom Network Name

Isolate your mesh from other Optimystic networks:

```json
{
  "config": {
    "networkName": "my-private-network"
  }
}
```

All nodes must use the same `networkName` to communicate.

### Multiple Bootstrap Nodes

```json
{
  "config": {
    "bootstrap": "/ip4/10.0.0.1/tcp/8011/p2p/12D3...,/ip4/10.0.0.2/tcp/8011/p2p/12D3..."
  }
}
```

### Disable Caching

For testing or debugging:

```json
{
  "config": {
    "enable_cache": false
  }
}
```

## Troubleshooting

### "Plugin not found" error

Make sure the plugin is published to npm:

```bash
npm install -g @optimystic/quereus-plugin-optimystic
```

Or use a local file path during development:

```json
{
  "source": "file:///absolute/path/to/quereus-plugin-optimystic/dist/plugin.js"
}
```

### "Failed to connect to bootstrap node"

1. Verify the bootstrap multiaddr is correct
2. Check that node1 is running and listening
3. Ensure both nodes use the same `networkName`
4. Check firewall settings

### "Table not found" on second node

1. Wait a few seconds for mesh synchronization
2. Check that both nodes are connected (use `.network status` if available)
3. Verify both nodes use the same `networkName`

## See Also

- [Quereus Documentation](https://github.com/Digithought/quereus)
- [Quoomb CLI](https://github.com/Digithought/quereus/tree/main/packages/quoomb-cli)
- [Quoomb Web](https://github.com/Digithought/quereus/tree/main/packages/quoomb-web)
- [Optimystic Plugin README](../README.md)

