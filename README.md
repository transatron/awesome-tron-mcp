# TRON MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for interacting with the TRON blockchain. Exposes ~38 read-only tools over stdio transport covering balance queries, TRX transfers, smart contract interaction, energy estimation, contract analytics, account analytics, market data, and more.

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

### Account & Wallet (10)
- **get_balance** — Get TRX balance for an address
- **get_account_resources** — Get bandwidth, energy, and staking info
- **get_account_overview** — Comprehensive account overview (balance, resources, activity)
- **get_account_tokens** — Tokens held by an account (TRC10/TRC20/TRC721)
- **get_account_votes** — Voting info for a voter or SR candidate
- **get_account_approvals** — Token approval list for an account
- **get_account_approval_changes** — Approval change history for a contract
- **get_account_analysis** — Analytical data for an account
- **get_account_defi** — DeFi project participation
- **get_account_token_overview** — Token asset overview

### Transactions & Blocks (5)
- **get_transaction** — Look up a transaction by hash
- **get_transactions_by_address** — List transactions for an address
- **get_trc20_transfers_by_address** — List TRC20 token transfers
- **get_block** — Get block details by number or hash
- **get_current_block_number** — Get the latest block number

### Smart Contracts (10)
- **contract_call** — Call a smart contract method
- **estimate_energy** — Estimate energy for a contract call (supports callerAddress, callValue, feeLimit)
- **estimate_contract_deploy** — Estimate energy/bandwidth for deploying a smart contract
- **get_contract_info** — Combined contract info from TronGrid + TronScan (ABI, energy economics, metadata)
- **get_contract_energy_stats** — Energy consumption statistics for a contract
- **get_contract_call_stats** — Top call statistics for a contract
- **get_contract_callers** — Callers of a smart contract
- **get_contract_daily_activity** — Daily trigger/call activity statistics
- **get_contract_analysis** — Analytical data for a contract
- **get_contract_events** — Recent smart contract trigger events

### Market & Network Data (8)
- **get_trx_price** — Current TRX price
- **get_trx_market_data** — Detailed market data (via CoinGecko)
- **get_network_statistics** — TRON network stats
- **get_energy_consumption** — Network energy consumption
- **get_defi_tvl** — DeFi total value locked on TRON
- **get_staking_info** — Staking rates and info
- **get_chain_parameters** — On-chain governance parameters
- **get_energy_prices** — Current energy prices

### Documentation (2)
- **search_tron_docs** — Search TRON documentation
- **get_tron_reference** — Get reference info on a TRON topic

### Raw API Access (3)
- **trongrid_api_call** — Make a raw TronGrid API request
- **tronscan_api_call** — Make a raw TronScan API request
- **get_trongrid_account** — Get account data via TronGrid

## Development

```bash
# Type-check
npm run typecheck

# Build (compile TypeScript)
npm run build
```

## Related MCP Servers

- **[JustLend MCP](https://github.com/justlend/mcp-server-justlend)** — MCP server for interacting with the JustLend DAO lending protocol on TRON.
- **[TronGrid MCP](https://developers.tron.network/reference/mcp-api)** — Official full TronGrid API exposed as MCP. Covers the entire TronGrid API surface. Note: this server registers a large number of tools, which will consume a significant portion of the context window (all tool schemas are injected into every request). Recommended only if the tools provided here are not sufficient for your use case.

## Architecture

The server uses a fallback strategy: requests are tried via TronWeb first, then TronGrid, then TronScan — returning the first successful result. The primary API source can be swapped via `PRIMARY_API` env variable (`TRONGRID` or `TRONSCAN`, default `TRONGRID`).

**Rate limiting:** The server proactively enforces rate limits for both TronGrid and TronScan APIs. All outgoing calls are tracked in a sliding 1-second window and automatically delayed when the configured limit (`TRONGRID_API_RATE_LIMIT` / `TRONSCAN_API_RATE_LIMIT`, default 3 req/s each) would be exceeded. If a 429 response is received, the server parses the cooldown duration from the response and blocks further requests to that API until the cooldown expires. This prevents cascading failures and avoids API bans during heavy tool usage.

## License

MIT
