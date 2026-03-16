# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server for TRON blockchain interaction. Exposes ~38 tools (balance queries, account analytics, TRX transfers, smart contract calls, contract analytics, energy estimation, market data, etc.) over stdio transport using `@modelcontextprotocol/sdk`.

## Commands

```bash
npm start          # Run server (tsx src/index.ts)
npm run dev        # Run with watch mode
npm run build      # Compile TypeScript (tsc)
npm run typecheck  # Type-check without emitting (tsc --noEmit)
```

No test suite is configured yet (the `test` script references `test/**/*.test.ts` but no test directory exists).

## Architecture

**Entry point:** `src/index.ts` — `TronMcpServer` class (~1500 lines). Registers all MCP tools in `setupHandlers()` via a `ListToolsRequestSchema` handler (tool definitions) and a `CallToolRequestSchema` handler (switch dispatch). Some tool implementations live directly in this class; others delegate to modules.

**Modules** (`src/modules/`): Domain-specific classes that handle groups of related tools:
- `AccountModule` — balance, resources, send TRX (receives `tronWeb`, API call functions, and `executeWithFallback` via constructor injection)
- `BlockchainModule` — blocks, transactions, TRC20 transfers (also receives rate limiters and `TronScanAPI`)
- `MarketModule` — TRX price and market data (wraps `PriceTracker`)

**Services** (top-level `src/`):
- `tronscan.ts` — `TronScanAPI` class for TronScan REST API calls (including contract analytics, account analytics, approvals, votes, DeFi participation)
- `price-tracker.ts` — `PriceTracker` fetches TRX price/market data from CoinGecko
- `network-monitor.ts` — `NetworkMonitor` for network stats
- `energy-estimator.ts` — `EnergyEstimator` for smart contract energy cost estimation
- `rate-limiter.ts` — `RateLimiter` with configurable per-second limits (separate instances for TronGrid and TronScan)
- `documentation.ts` — `TronDocumentation` with embedded TRON reference data (doc search and quick reference only; java-tron GitHub methods removed)

**Config:** `src/config/tron-config.ts` — network endpoints (mainnet/shasta/nile), known contract addresses (USDT, USDC, WTRX), fee defaults.

**Types:** `src/types.ts` — shared interfaces (`McpToolResponse`, `FallbackOperations`, API call function types). `src/tronweb.d.ts` — minimal type declarations for the `tronweb` package.

## Key Patterns

- **Fallback strategy:** `executeWithFallback()` tries TronWeb → TronGrid → TronScan in order, returning the first successful result with a `source` field.
- **Rate limiting:** Both TronGrid and TronScan have independent `RateLimiter` instances (default 3 req/s each, configurable via env).
- **All tool responses** return `McpToolResponse` (`{ content: [{ type: 'text', text: string }] }`).
- **ESM project:** `"type": "module"` in package.json; imports use `.js` extensions. TypeScript targets ES2022 with NodeNext module resolution.

## Environment

Copy `.env.example` to `.env`. Key variables: `TRONGRID_API_KEY`, `TRONSCAN_API_KEY`, `NETWORK` (mainnet/shasta/nile), `PRIVATE_KEY` (for transactions), `ENABLE_CACHE`, `DEBUG`.

## Cache

The `cache/` directory contains JSON files with scraped/fetched data (network stats, energy prices, staking rates, TRX price). These are gitignored.
