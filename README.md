# TRON MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for interacting with the TRON blockchain. Exposes ~35 tools over stdio transport covering balance queries, TRX transfers, smart contract calls, energy estimation, market data, java-tron repository browsing, and more.

## Prerequisites

- **Node.js** 18+
- **npm**
- A **TronGrid API key** (free at [trongrid.io](https://www.trongrid.io/))
- Optionally a **TronScan API key** for enhanced data access

## Installation

```bash
git clone <repo-url>
cd tron-mcp
npm install
```

## Configuration

Copy the example environment file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env` with your API keys and desired settings. See the [environment parameters table](#claude-desktop) below for all options. Additional `.env`-only variables:

| Variable | Description | Default |
|---|---|---|
| `PRIVATE_KEY` | Wallet private key (needed for sending transactions) | *(optional)* |
| `ENABLE_CACHE` | Enable response caching | `true` |
| `CACHE_TTL` | Cache time-to-live in seconds | `300` |
| `DEBUG` | Enable debug logging | `false` |

## Running the Server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

The server communicates over **stdio** (stdin/stdout), which is the standard MCP transport for local tools.

## Connecting to an MCP Client

Build the project first so the compiled JS is available:

```bash
npm run build
```

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "tron": {
      "command": "node",
      "args": ["<full-path-to-repo>/dist/index.js"],
      "env": {
        "NETWORK": "mainnet",
        "FULL_NODE_URL": "https://api.trongrid.io",
        "TRONGRID_API_URL": "https://api.trongrid.io",
        "TRONGRID_API_KEY": "your-trongrid-api-key",
        "TRONSCAN_API_KEY": "your-tronscan-api-key",
        "TRONGRID_API_RATE_LIMIT": "5",
        "TRONSCAN_API_RATE_LIMIT": "3",
        "PRIMARY_API": "TRONGRID"
      }
    }
  }
}
```

**Environment parameters:**

| Parameter | Description | Default |
|---|---|---|
| `NETWORK` | Network to use: `mainnet`, `shasta`, or `nile` | `mainnet` |
| `FULL_NODE_URL` | TRON full node RPC endpoint | `https://api.trongrid.io` |
| `TRONGRID_API_URL` | TronGrid API base URL | `https://api.trongrid.io` |
| `TRONGRID_API_KEY` | Your TronGrid API key | *(required)* |
| `TRONSCAN_API_KEY` | Your TronScan API key | *(optional)* |
| `TRONGRID_API_RATE_LIMIT` | Max TronGrid requests per second | `5` |
| `TRONSCAN_API_RATE_LIMIT` | Max TronScan requests per second | `3` |
| `PRIMARY_API` | Preferred API source: `TRONGRID` or `TRONSCAN` | `TRONGRID` |

### Claude Code

Add to your Claude Code MCP settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "tron": {
      "command": "node",
      "args": ["<full-path-to-repo>/dist/index.js"],
      "env": {
        "NETWORK": "mainnet",
        "FULL_NODE_URL": "https://api.trongrid.io",
        "TRONGRID_API_URL": "https://api.trongrid.io",
        "TRONGRID_API_KEY": "your-trongrid-api-key",
        "TRONSCAN_API_KEY": "your-tronscan-api-key",
        "TRONGRID_API_RATE_LIMIT": "5",
        "TRONSCAN_API_RATE_LIMIT": "3",
        "PRIMARY_API": "TRONGRID"
      }
    }
  }
}
```

### Other MCP Clients

Any MCP-compatible client that supports stdio transport can connect. Point it at `node dist/index.js` from the project directory (or use the full path).

## Available Tools

### Account & Wallet
- **get_balance** — Get TRX balance for an address
- **get_account_resources** — Get bandwidth, energy, and staking info
- **send_trx** — Send TRX to an address (requires `PRIVATE_KEY`)

### Transactions & Blocks
- **get_transaction** — Look up a transaction by hash
- **get_transactions_by_address** — List transactions for an address
- **get_trc20_transfers_by_address** — List TRC20 token transfers
- **get_block** — Get block details by number or hash
- **get_current_block_number** — Get the latest block number

### Smart Contracts
- **contract_call** — Call a smart contract method
- **estimate_energy** — Estimate energy for a contract call
- **estimate_contract_energy** — Detailed energy estimation
- **batch_estimate_energy** — Estimate energy for multiple calls
- **analyze_contract_gas** — Analyze gas usage for a contract
- **clear_energy_cache** — Clear the energy estimation cache

### Market & Network Data
- **get_trx_price** — Current TRX price
- **get_trx_market_data** — Detailed market data (via CoinGecko)
- **get_network_statistics** — TRON network stats
- **get_energy_consumption** — Network energy consumption
- **get_defi_tvl** — DeFi total value locked on TRON
- **get_staking_info** — Staking rates and info
- **get_chain_parameters** — On-chain governance parameters
- **get_energy_prices** — Current energy prices

### java-tron Repository
- **get_java_tron_readme** — Fetch java-tron README
- **get_java_tron_file** — Read a file from the java-tron repo
- **search_java_tron** — Search code in java-tron
- **get_java_tron_structure** — Browse java-tron directory structure
- **get_java_tron_protos** — Get protobuf definitions
- **get_java_tron_issues** — Browse java-tron GitHub issues
- **get_java_tron_releases** — List java-tron releases

### Documentation
- **search_tron_docs** — Search TRON documentation
- **get_tron_reference** — Get reference info on a TRON topic

### Raw API Access
- **trongrid_api_call** — Make a raw TronGrid API request
- **tronscan_api_call** — Make a raw TronScan API request
- **get_trongrid_block** — Get block data via TronGrid
- **get_trongrid_account** — Get account data via TronGrid

## Development

```bash
# Type-check
npm run typecheck

# Build (compile TypeScript)
npm run build
```

## Architecture

The server uses a fallback strategy: requests are tried via TronWeb first, then TronGrid, then TronScan — returning the first successful result. Rate limiting is applied independently to TronGrid and TronScan APIs.

## License

MIT
