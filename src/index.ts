#!/usr/bin/env node
console.error('[TRON-MCP] Starting...');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import TronWeb from 'tronweb';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { TronDocumentation } from './documentation.js';
import { TronScanAPI } from './tronscan.js';
import { PriceTracker } from './price-tracker.js';
import { NetworkMonitor } from './network-monitor.js';
import { EnergyEstimator } from './energy-estimator.js';
import { RateLimiter } from './rate-limiter.js';

import { MarketModule } from './modules/market/index.js';
import { AccountModule } from './modules/account/index.js';
import { BlockchainModule } from './modules/blockchain/index.js';

import type { McpToolResponse, FallbackOperations } from './types.js';

console.error('[TRON-MCP] Imports completed');
dotenv.config();
console.error('[TRON-MCP] Environment loaded');

class TronMcpServer {
  private server: Server;
  private tronWeb: any;
  private documentation: TronDocumentation;
  private tronScanAPI: TronScanAPI;
  private trongridRateLimiter: RateLimiter;
  private tronscanRateLimiter: RateLimiter;
  private priceTracker: PriceTracker;
  private marketModule: MarketModule;
  private accountModule: AccountModule;
  private blockchainModule: BlockchainModule;
  private networkMonitor: NetworkMonitor | null;
  private energyEstimator: EnergyEstimator | null;
  private nodeAvailable: boolean | null;

  constructor() {
    console.error('[TRON-MCP] Creating server instance...');
    try {
      this.server = new Server(
        {
          name: 'mcp-tron-server',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );
      console.error('[TRON-MCP] Server instance created');

      this.setupHandlers();
      console.error('[TRON-MCP] Handlers setup complete');

      this.initializeTronWeb();
      console.error('[TRON-MCP] TronWeb initialized');

      this.documentation = new TronDocumentation();
      console.error('[TRON-MCP] Documentation module initialized');

      this.tronScanAPI = new TronScanAPI();
      console.error('[TRON-MCP] TronScan API initialized');

      this.trongridRateLimiter = new RateLimiter(
        'TronGrid',
        parseInt(process.env.TRONGRID_API_RATE_LIMIT || '') || 5
      );
      this.tronscanRateLimiter = new RateLimiter(
        'TronScan',
        parseInt(process.env.TRONSCAN_API_RATE_LIMIT || '') || 3
      );
      console.error('[TRON-MCP] Rate limiters initialized');

      this.tronScanAPI.setRateLimiter(this.tronscanRateLimiter);

      this.priceTracker = new PriceTracker();

      this.marketModule = new MarketModule(this.priceTracker);

      this.accountModule = new AccountModule(
        this.tronWeb,
        this.trongridApiCall.bind(this),
        this.tronscanApiCall.bind(this),
        this.executeWithFallback.bind(this)
      );

      this.blockchainModule = new BlockchainModule(
        this.tronWeb,
        this.trongridApiCall.bind(this),
        this.tronscanApiCall.bind(this),
        this.tronScanAPI,
        this.trongridRateLimiter,
        this.tronscanRateLimiter
      );
      console.error('[TRON-MCP] All modules initialized');

      this.networkMonitor = null;
      this.energyEstimator = null;
      this.nodeAvailable = null;
    } catch (error: any) {
      console.error('[TRON-MCP] Constructor error:', error.message);
      console.error('[TRON-MCP] Stack:', error.stack);
      throw error;
    }
  }

  private initializeTronWeb(): void {
    const HttpProvider = TronWeb.providers.HttpProvider;
    const fullNode = new HttpProvider(process.env.FULL_NODE_URL || 'https://api.trongrid.io');
    const solidityNode = new HttpProvider(process.env.SOLIDITY_NODE_URL || 'https://api.trongrid.io');
    const eventServer = new HttpProvider(process.env.EVENT_SERVER_URL || 'https://api.trongrid.io');

    this.tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

    if (process.env.TRONGRID_API_KEY) {
      this.tronWeb.setHeader({ 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY });
    }

    // Set a default address for read-only operations (no private key needed)
    this.tronWeb.setAddress('TSLbRevWFn3hktZmfDrzRbDLfEA6RQjNwK');

    try {
      setTimeout(() => {
        try {
          this.energyEstimator = new EnergyEstimator(this.tronWeb);
          console.error('[TRON-MCP] Energy estimator initialized successfully');
        } catch (error: any) {
          console.error('[TRON-MCP] Failed to initialize energy estimator:', error.message);
          this.energyEstimator = null;
        }
      }, 100);
    } catch (error: any) {
      console.error('[TRON-MCP] Failed to schedule energy estimator initialization:', error.message);
      this.energyEstimator = null;
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_balance',
          description: 'Get TRX balance for an address',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_resources',
          description: 'Get account resources (bandwidth and energy)',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_transaction',
          description: 'Get transaction details by hash',
          inputSchema: {
            type: 'object' as const,
            properties: {
              txHash: { type: 'string', description: 'Transaction hash' },
            },
            required: ['txHash'],
          },
        },
        {
          name: 'get_transactions_by_address',
          description: 'Get transactions for a TRON address with optional filtering for incoming/outgoing',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address to query transactions for' },
              direction: { type: 'string', description: 'Filter direction: "incoming", "outgoing", or "all" (default: "all")' },
              limit: { type: 'number', description: 'Maximum number of transactions to return (default: 20, max: 50)' },
              start: { type: 'number', description: 'Pagination offset (default: 0)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_trc20_transfers_by_address',
          description: 'Get TRC20 token transfers for a TRON address with optional contract and direction filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address to query TRC20 transfers for' },
              contract_address: { type: 'string', description: 'TRC20 contract address to filter (e.g., USDT: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t)' },
              direction: { type: 'string', description: 'Filter direction: "incoming", "outgoing", or "all" (default: "all")' },
              limit: { type: 'number', description: 'Maximum number of transfers to return (default: 20, max: 50)' },
              start: { type: 'number', description: 'Pagination offset (default: 0)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_block',
          description: 'Get block information with smart size management to prevent token overflow',
          inputSchema: {
            type: 'object' as const,
            properties: {
              blockNumber: { type: 'number', description: 'Block number (optional, returns latest if not provided)' },
              summary: { type: 'boolean', description: 'Return summary only without full transaction data (default: true)' },
              includeTransactions: { type: 'boolean', description: 'Include transactions in response (default: false)' },
              transactionLimit: { type: 'number', description: 'Maximum number of transactions to include (default: 10)' },
              saveToFile: { type: 'boolean', description: 'Save full block data to file and return file path (default: false)' },
              fullResponse: { type: 'boolean', description: 'Return full block data without limits - WARNING: may exceed token limit (default: false)' },
            },
          },
        },
        {
          name: 'get_current_block_number',
          description: 'Get current block number only (compact output)',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'contract_call',
          description: 'Call a smart contract function',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
              functionName: { type: 'string', description: 'Function name to call' },
              parameters: { type: 'array', description: 'Function parameters', items: {} },
              feeLimit: { type: 'number', description: 'Fee limit in SUN (optional)' },
            },
            required: ['contractAddress', 'functionName'],
          },
        },
        {
          name: 'estimate_energy',
          description: 'Estimate energy consumption for a contract call',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
              functionName: { type: 'string', description: 'Function name' },
              parameters: { type: 'array', description: 'Function parameters', items: {} },
              callerAddress: { type: 'string', description: 'Caller address for estimation (optional, falls back to default address)' },
              callValue: { type: 'number', description: 'TRX sent with call in SUN, for payable functions (default: 0)' },
              feeLimit: { type: 'number', description: 'Fee limit in SUN (default: 100000000)' },
            },
            required: ['contractAddress', 'functionName'],
          },
        },
        {
          name: 'search_tron_docs',
          description: 'Search TRON documentation and get relevant resources',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query' },
              topic: { type: 'string', description: 'Specific topic to search within' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_tron_reference',
          description: 'Get quick reference for TRON concepts',
          inputSchema: {
            type: 'object' as const,
            properties: {
              topic: { type: 'string', description: 'Reference topic (addresses, units, fees, limits)' },
            },
            required: ['topic'],
          },
        },
        {
          name: 'get_trx_price',
          description: 'Get current TRX price from CoinGecko',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_trx_market_data',
          description: 'Get detailed TRX market data',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_network_statistics',
          description: 'Get comprehensive TRON network statistics',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_energy_consumption',
          description: 'Get energy consumption statistics',
          inputSchema: {
            type: 'object' as const,
            properties: {
              limit: { type: 'number', description: 'Number of contracts to return (default: 10)' },
            },
          },
        },
        {
          name: 'get_defi_tvl',
          description: 'Get DeFi Total Value Locked data',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_staking_info',
          description: 'Get TRX staking rate and information',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_chain_parameters',
          description: 'Get current chain parameters',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_energy_prices',
          description: 'Get current energy and bandwidth prices',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'trongrid_api_call',
          description: 'Direct call to TronGrid API endpoint',
          inputSchema: {
            type: 'object' as const,
            properties: {
              endpoint: { type: 'string', description: 'API endpoint (e.g., "/wallet/getnowblock", "/wallet/getaccount")' },
              method: { type: 'string', description: 'HTTP method (GET or POST)', enum: ['GET', 'POST'] },
              data: { type: 'object', description: 'Request body data (for POST requests)' },
            },
            required: ['endpoint'],
          },
        },
        {
          name: 'tronscan_api_call',
          description: 'Direct call to TronScan API endpoint',
          inputSchema: {
            type: 'object' as const,
            properties: {
              endpoint: { type: 'string', description: 'API endpoint (e.g., "/api/block", "/api/account")' },
              params: { type: 'object', description: 'Query parameters' },
            },
            required: ['endpoint'],
          },
        },
        {
          name: 'get_trongrid_account',
          description: 'Get account information directly from TronGrid API',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'estimate_contract_deploy',
          description: 'Estimate energy and bandwidth cost for deploying a smart contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              bytecodeHex: { type: 'string', description: 'Compiled contract bytecode (hex string)' },
              ownerAddress: { type: 'string', description: 'Deployer address (optional, falls back to default)' },
              callValue: { type: 'number', description: 'TRX sent with deployment in SUN (default: 0)' },
            },
            required: ['bytecodeHex'],
          },
        },
        {
          name: 'get_contract_info',
          description: 'Get combined contract info from TronGrid (ABI, bytecode, energy economics) and TronScan (verification, metadata, tags)',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
            },
            required: ['contractAddress'],
          },
        },
        {
          name: 'get_contract_energy_stats',
          description: 'Get energy consumption statistics for a contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'Smart contract address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_contract_call_stats',
          description: 'Get top call statistics for a contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contract_address: { type: 'string', description: 'Smart contract address' },
            },
            required: ['contract_address'],
          },
        },
        {
          name: 'get_contract_callers',
          description: 'Get callers of a smart contract with optional time filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'Smart contract address' },
              day: { type: 'number', description: 'Number of days to look back (optional)' },
              start: { type: 'number', description: 'Pagination offset (optional)' },
              limit: { type: 'number', description: 'Number of results (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_contract_daily_activity',
          description: 'Get daily trigger/call activity statistics for a contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'Smart contract address' },
              start_timestamp: { type: 'number', description: 'Start timestamp in ms (optional)' },
              end_timestamp: { type: 'number', description: 'End timestamp in ms (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_contract_analysis',
          description: 'Get analytical data for a contract (callers, transactions, etc.)',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'Smart contract address' },
              type: { type: 'string', description: 'Analysis type (optional)' },
              start_timestamp: { type: 'number', description: 'Start timestamp in ms (optional)' },
              end_timestamp: { type: 'number', description: 'End timestamp in ms (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_contract_events',
          description: 'Get recent smart contract trigger events',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
              limit: { type: 'number', description: 'Number of events to return (default: 20)' },
            },
            required: ['contractAddress'],
          },
        },
        {
          name: 'get_account_overview',
          description: 'Get comprehensive account overview including balance, resources, and activity',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_tokens',
          description: 'Get tokens held by an account with optional type filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
              start: { type: 'number', description: 'Pagination offset (optional)' },
              limit: { type: 'number', description: 'Number of results (optional)' },
              type: { type: 'string', description: 'Token type filter: TRC10, TRC20, or TRC721 (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_votes',
          description: 'Get voting information for a voter or SR candidate',
          inputSchema: {
            type: 'object' as const,
            properties: {
              voter: { type: 'string', description: 'Voter TRON address (optional)' },
              candidate: { type: 'string', description: 'SR candidate TRON address (optional)' },
              start: { type: 'number', description: 'Pagination offset (optional)' },
              limit: { type: 'number', description: 'Number of results (optional)' },
            },
          },
        },
        {
          name: 'get_account_approvals',
          description: 'Get token approval list for an account',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
              type: { type: 'string', description: 'Approval type filter (optional)' },
              start: { type: 'number', description: 'Pagination offset (optional)' },
              limit: { type: 'number', description: 'Number of results (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_approval_changes',
          description: 'Get approval change history for a contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contract_address: { type: 'string', description: 'Contract address' },
              from_address: { type: 'string', description: 'Approver address (optional)' },
              to_address: { type: 'string', description: 'Spender address (optional)' },
              start: { type: 'number', description: 'Pagination offset (optional)' },
              limit: { type: 'number', description: 'Number of results (optional)' },
            },
            required: ['contract_address'],
          },
        },
        {
          name: 'get_account_analysis',
          description: 'Get analytical data for an account (transactions, transfers, etc.)',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
              type: { type: 'string', description: 'Analysis type (optional)' },
              start_timestamp: { type: 'number', description: 'Start timestamp in ms (optional)' },
              end_timestamp: { type: 'number', description: 'End timestamp in ms (optional)' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_defi',
          description: 'Get DeFi project participation for an account',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
        {
          name: 'get_account_token_overview',
          description: 'Get token asset overview for an account',
          inputSchema: {
            type: 'object' as const,
            properties: {
              address: { type: 'string', description: 'TRON address' },
            },
            required: ['address'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'get_balance':
            return await this.accountModule.getBalance(args as any);
          case 'get_account_resources':
            return await this.accountModule.getAccountResources(args as any);
          case 'get_transaction':
            return await this.blockchainModule.getTransaction(args as any);
          case 'get_transactions_by_address':
            return await this.blockchainModule.getTransactionsByAddress(args as any);
          case 'get_trc20_transfers_by_address':
            return await this.blockchainModule.getTRC20TransfersByAddress(args as any);
          case 'get_block':
            return await this.blockchainModule.getBlock(args as any);
          case 'get_current_block_number':
            return await this.blockchainModule.getCurrentBlockNumber();
          case 'contract_call':
            return await this.contractCall(args as any);
          case 'estimate_energy':
            return await this.estimateEnergy(args as any);
          case 'search_tron_docs':
            return await this.searchTronDocs(args as any);
          case 'get_tron_reference':
            return await this.getTronReference(args as any);
          case 'get_trx_price':
            return await this.marketModule.getTRXPrice();
          case 'get_trx_market_data':
            return await this.marketModule.getTRXMarketData();
          case 'get_network_statistics':
            return await this.getNetworkStatistics();
          case 'get_energy_consumption':
            return await this.getEnergyConsumption(args as any);
          case 'get_defi_tvl':
            return await this.getDefiTVL();
          case 'get_staking_info':
            return await this.getStakingInfo();
          case 'get_chain_parameters':
            return await this.getChainParameters();
          case 'get_energy_prices':
            return await this.getEnergyPrices();
          case 'trongrid_api_call':
            return await this.trongridApiCall(args as any);
          case 'tronscan_api_call':
            return await this.tronscanApiCall(args as any);
          case 'get_trongrid_account':
            return await this.getTrongridAccount(args as any);
          case 'estimate_contract_deploy':
            return await this.estimateContractDeploy(args as any);
          case 'get_contract_info':
            return await this.getContractInfo(args as any);
          case 'get_contract_energy_stats':
            return await this.getContractEnergyStats(args as any);
          case 'get_contract_call_stats':
            return await this.getContractCallStats(args as any);
          case 'get_contract_callers':
            return await this.getContractCallers(args as any);
          case 'get_contract_daily_activity':
            return await this.getContractDailyActivity(args as any);
          case 'get_contract_analysis':
            return await this.getContractAnalysis(args as any);
          case 'get_contract_events':
            return await this.getContractEvents(args as any);
          case 'get_account_overview':
            return await this.getAccountOverview(args as any);
          case 'get_account_tokens':
            return await this.getAccountTokens(args as any);
          case 'get_account_votes':
            return await this.getAccountVotes(args as any);
          case 'get_account_approvals':
            return await this.getAccountApprovals(args as any);
          case 'get_account_approval_changes':
            return await this.getAccountApprovalChanges(args as any);
          case 'get_account_analysis':
            return await this.getAccountAnalysis(args as any);
          case 'get_account_defi':
            return await this.getAccountDefi(args as any);
          case 'get_account_token_overview':
            return await this.getAccountTokenOverview(args as any);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Error executing tool: ${error.message}`);
      }
    });
  }

  private async contractCall({ contractAddress, functionName, parameters = [], feeLimit }: {
    contractAddress: string; functionName: string; parameters?: any[]; feeLimit?: number;
  }): Promise<McpToolResponse> {
    try {
      const result = await this.executeWithFallback({
        tronweb: async () => {
          const contract = await this.tronWeb.contract().at(contractAddress);
          const callResult = await contract[functionName](...parameters).send({
            feeLimit: feeLimit || 100000000,
          });
          return callResult;
        },
        trongrid: async () => {
          let functionSelector = functionName;
          if (functionName === 'balanceOf' && parameters.length === 1) {
            functionSelector = 'balanceOf(address)';
          } else if (functionName === 'transfer' && parameters.length === 2) {
            functionSelector = 'transfer(address,uint256)';
          } else if (functionName === 'approve' && parameters.length === 2) {
            functionSelector = 'approve(address,uint256)';
          }

          let parameter = '';
          if (parameters && parameters.length > 0) {
            if (functionName === 'balanceOf' && parameters.length === 1) {
              const encoded = this.tronWeb.utils.abi.encodeParams(['address'], [parameters[0]]);
              parameter = encoded.replace(/^0x/, '');
            } else {
              const encoded = this.encodeContractParameters(parameters);
              parameter = encoded.replace(/^0x/, '');
            }
          }

          const apiResult = await this.trongridApiCall({
            endpoint: '/wallet/triggerconstantcontract',
            method: 'POST',
            data: {
              owner_address: this.tronWeb.defaultAddress?.base58 || 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa',
              contract_address: contractAddress,
              function_selector: functionSelector,
              parameter,
              visible: true,
            },
          });
          return JSON.parse(apiResult.content[0]!.text).result;
        },
        tronscan: async () => {
          throw new Error('TronScan API does not support contract calls - read-only API');
        },
      }, 'contractCall');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            contractAddress,
            functionName,
            parameters,
            feeLimit: feeLimit || 100000000,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to call contract: ${error.message}`);
    }
  }

  private encodeContractParameters(parameters: any[]): string {
    try {
      if (!parameters || parameters.length === 0) return '';

      if (parameters.length === 2) {
        try {
          const toAddress = parameters[0];
          const amount = parameters[1];
          if (typeof toAddress === 'string' && toAddress.startsWith('T') && toAddress.length === 34) {
            return this.tronWeb.utils.abi.encodeParams(['address', 'uint256'], [toAddress, amount]);
          }
        } catch {
          // Fall through
        }
      }

      const types = parameters.map((param: any) => {
        if (typeof param === 'string' && param.startsWith('T') && param.length === 34) return 'address';
        if (typeof param === 'number' || (typeof param === 'string' && /^\d+$/.test(param))) return 'uint256';
        if (typeof param === 'string') return 'string';
        if (typeof param === 'boolean') return 'bool';
        return 'bytes';
      });

      return this.tronWeb.utils.abi.encodeParams(types, parameters);
    } catch (error: any) {
      console.error('Parameter encoding failed:', error.message);
      return '';
    }
  }

  private async estimateEnergy({ contractAddress, functionName, parameters = [], callerAddress, callValue = 0, feeLimit = 100000000 }: {
    contractAddress: string; functionName: string; parameters?: any[]; callerAddress?: string; callValue?: number; feeLimit?: number;
  }): Promise<McpToolResponse> {
    try {
      const result = await this.executeWithFallback({
        tronweb: async () => {
          if (!this.energyEstimator) {
            throw new Error('Energy estimator not initialized');
          }
          return await this.energyEstimator.estimateContractEnergy(
            contractAddress, functionName, parameters, callerAddress || null, feeLimit
          );
        },
        trongrid: async () => {
          const fromAddress = callerAddress || this.tronWeb.defaultAddress?.base58 || 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';

          let functionSelector = functionName;
          if (functionName === 'transfer' && parameters.length === 2) {
            functionSelector = 'transfer(address,uint256)';
          } else if (functionName === 'balanceOf' && parameters.length === 1) {
            functionSelector = 'balanceOf(address)';
          } else if (functionName === 'approve' && parameters.length === 2) {
            functionSelector = 'approve(address,uint256)';
          }

          let parameter_hex = '';
          if (parameters && parameters.length > 0) {
            try {
              const types = parameters.map((param: any) => {
                if (typeof param === 'string' && param.startsWith('T') && param.length === 34) return 'address';
                if (typeof param === 'number' || (typeof param === 'string' && /^\d+$/.test(param))) return 'uint256';
                return 'uint256';
              });
              const encoded = this.tronWeb.utils.abi.encodeParams(types, parameters);
              parameter_hex = encoded.replace(/^0x/, '');
            } catch {
              // Fall through with empty parameter
            }
          }

          const apiResult = await this.trongridApiCall({
            endpoint: '/wallet/triggerconstantcontract',
            method: 'POST',
            data: {
              owner_address: fromAddress,
              contract_address: contractAddress,
              function_selector: functionSelector,
              parameter: parameter_hex,
              call_value: callValue,
              visible: true,
            },
          });

          const parsed = JSON.parse(apiResult.content[0]!.text).result;
          const energyUsed = parsed.energy_used || 0;

          return {
            contractAddress, functionName, parameters,
            callerAddress: fromAddress,
            estimations: {
              trongrid: {
                energy: energyUsed, method: 'triggerconstantcontract',
                accuracy: energyUsed > 0 ? 'high' : 'low',
                api_response: parsed,
              },
            },
            recommended: energyUsed,
            timestamp: new Date().toISOString(),
          };
        },
        tronscan: async () => {
          throw new Error('TronScan does not support energy estimation');
        },
      }, 'estimateEnergy');

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to estimate energy: ${error.message}`);
    }
  }

  private async searchTronDocs({ query, topic }: { query: string; topic?: string }): Promise<McpToolResponse> {
    try {
      const results = await this.documentation.searchDocumentation(query, topic);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to search documentation: ${error.message}`);
    }
  }

  private async getTronReference({ topic }: { topic: string }): Promise<McpToolResponse> {
    try {
      const reference = await this.documentation.getQuickReference(topic);
      return { content: [{ type: 'text', text: JSON.stringify(reference, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get reference: ${error.message}`);
    }
  }

  private async getNetworkStatistics(): Promise<McpToolResponse> {
    try {
      const stats = await this.tronScanAPI.getTronStatistics();
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get network statistics: ${error.message}`);
    }
  }

  private async getEnergyConsumption({ limit = 10 }: { limit?: number }): Promise<McpToolResponse> {
    try {
      const energyData = await this.tronScanAPI.getEnergyConsumptionData(limit);
      return { content: [{ type: 'text', text: JSON.stringify(energyData, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get energy consumption data: ${error.message}`);
    }
  }

  private async getDefiTVL(): Promise<McpToolResponse> {
    try {
      const tvlData = await this.tronScanAPI.getDefiTVL();
      return { content: [{ type: 'text', text: JSON.stringify(tvlData, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get DeFi TVL data: ${error.message}`);
    }
  }

  private async getStakingInfo(): Promise<McpToolResponse> {
    try {
      const stakingData = await this.tronScanAPI.getStakingRate();
      return { content: [{ type: 'text', text: JSON.stringify(stakingData, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get staking info: ${error.message}`);
    }
  }

  private async getChainParameters(): Promise<McpToolResponse> {
    try {
      if (this.networkMonitor) {
        try {
          const parameters = this.networkMonitor.getChainParameters();
          if (parameters) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ ...parameters, source: 'network_monitor_cache' }, null, 2),
              }],
            };
          }
        } catch (error: any) {
          console.error('Network monitor error, falling back to direct API call:', error.message);
        }
      }

      const result = await this.executeWithFallback({
        tronweb: async () => {
          return await this.tronWeb.trx.getChainParameters();
        },
        trongrid: async () => {
          const apiResult = await this.trongridApiCall({
            endpoint: '/wallet/getchainparameters',
            method: 'POST',
            data: {},
          });
          return JSON.parse(apiResult.content[0]!.text).result;
        },
        tronscan: async () => {
          const apiResult = await this.tronscanApiCall({
            endpoint: '/api/system/parameters',
            params: {},
          });
          const scanData = JSON.parse(apiResult.content[0]!.text).result;
          return {
            chainParameter: scanData.map((param: any) => ({ key: param.key, value: param.value })),
          };
        },
      }, 'getChainParameters');

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get chain parameters: ${error.message}`);
    }
  }

  private async getEnergyPrices(): Promise<McpToolResponse> {
    try {
      const result = await this.executeWithFallback({
        tronweb: async () => {
          const chainParams = await this.tronWeb.trx.getChainParameters();
          return this.processChainParametersForEnergyPrices(chainParams);
        },
        trongrid: async () => {
          const apiResult = await this.trongridApiCall({
            endpoint: '/wallet/getchainparameters',
            method: 'POST',
            data: {},
          });
          const data = JSON.parse(apiResult.content[0]!.text).result;
          return this.processChainParametersForEnergyPrices(data.chainParameter || data || []);
        },
        tronscan: async () => {
          return await this.tronScanAPI.getEnergyPrices();
        },
      }, 'getEnergyPrices');

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      console.error('All energy price sources failed, using fallback values:', error.message);

      const fallbackPrices = {
        energy_price_sun: 210,
        bandwidth_price_sun: 1000,
        create_account_fee: 100000,
        transaction_fee: 1000,
        witness_create_fee: 9999000000,
        asset_issue_fee: 1024000000,
        last_updated: new Date().toISOString(),
        source: 'fallback_static_values',
        note: 'All API sources failed, using static fallback values',
      };

      return { content: [{ type: 'text', text: JSON.stringify(fallbackPrices, null, 2) }] };
    }
  }

  private processChainParametersForEnergyPrices(chainParams: any): any {
    const params = Array.isArray(chainParams) ? chainParams : chainParams.chainParameter || [];

    const result: any = {
      source: 'chain_parameters',
      last_updated: new Date().toISOString(),
      raw_parameters: {} as Record<string, any>,
    };

    params.forEach((param: any) => {
      if (param.key && param.value !== undefined) {
        result.raw_parameters[param.key] = param.value;
      }
    });

    const energyFee = result.raw_parameters.getEnergyFee || 210;
    const transactionFee = result.raw_parameters.getTransactionFee || 1000;
    const createAccountFee = result.raw_parameters.getCreateAccountFee || 100000;

    result.energy_price_sun = energyFee;
    result.bandwidth_price_sun = transactionFee;
    result.create_account_fee = createAccountFee;
    result.transaction_fee = transactionFee;

    if (result.raw_parameters.getAccountUpgradeCost) {
      result.witness_create_fee = result.raw_parameters.getAccountUpgradeCost;
    }
    if (result.raw_parameters.getAssetIssueFee) {
      result.asset_issue_fee = result.raw_parameters.getAssetIssueFee;
    }

    return result;
  }

  private async checkNodeAvailability(): Promise<boolean> {
    if (this.nodeAvailable !== null) return this.nodeAvailable;

    try {
      const startTime = Date.now();
      await this.tronWeb.trx.getCurrentBlock();
      const responseTime = Date.now() - startTime;
      this.nodeAvailable = responseTime < 5000;
      console.error(`[TRON-MCP] Local node availability: ${this.nodeAvailable ? 'Available' : 'Slow'} (${responseTime}ms)`);
      return this.nodeAvailable;
    } catch (error: any) {
      this.nodeAvailable = false;
      console.error('[TRON-MCP] Local node not available:', error.message);
      return false;
    }
  }

  private isTronScanPrimary(): boolean {
    const primaryApi = (process.env.PRIMARY_API || 'TRONGRID').toUpperCase();
    return primaryApi === 'TRONSCAN';
  }

  private async executeWithFallback<T>(operations: FallbackOperations<T>, operationName: string): Promise<T & { source?: string }> {
    const sources: string[] = [];
    const useTronScanFirst = this.isTronScanPrimary();

    const primaryOp = useTronScanFirst ? operations.tronscan : operations.trongrid;
    const fallbackOp = useTronScanFirst ? operations.trongrid : operations.tronscan;
    const primaryName = useTronScanFirst ? 'TronScan' : 'TronGrid';
    const fallbackName = useTronScanFirst ? 'TronGrid' : 'TronScan';
    const primarySource = useTronScanFirst ? 'tronscan_api' : 'trongrid_api';
    const fallbackSource = useTronScanFirst ? 'trongrid_api' : 'tronscan_api';

    try {
      const nodeAvailable = await this.checkNodeAvailability();

      if (!nodeAvailable) {
        console.error(`[TRON-MCP] Skipping local node for ${operationName}, going directly to ${primaryName}`);

        if (primaryOp) {
          try {
            const result = await primaryOp();
            return { ...result, source: primarySource } as T & { source?: string };
          } catch (primaryError: any) {
            sources.push(`${primaryName}: ${primaryError.message}`);
            console.error(`${primaryName} failed for ${operationName}, trying ${fallbackName} API:`, primaryError.message);
          }
        }

        if (fallbackOp) {
          try {
            const result = await fallbackOp();
            return { ...result, source: fallbackSource } as T & { source?: string };
          } catch (fallbackError: any) {
            sources.push(`${fallbackName}: ${fallbackError.message}`);
            throw new Error(`All API sources failed for ${operationName}: ${sources.join(', ')}`);
          }
        }

        throw new Error(`No fallback sources available for ${operationName}`);
      }

      try {
        const result = await operations.tronweb();
        return { ...result, source: 'tronweb_node' } as T & { source?: string };
      } catch (nodeError: any) {
        sources.push(`TronWeb: ${nodeError.message}`);
        console.error(`TronWeb failed for ${operationName}, trying ${primaryName} API:`, nodeError.message);
        this.nodeAvailable = false;

        if (primaryOp) {
          try {
            const result = await primaryOp();
            return { ...result, source: primarySource } as T & { source?: string };
          } catch (primaryError: any) {
            sources.push(`${primaryName}: ${primaryError.message}`);
            console.error(`${primaryName} failed for ${operationName}, trying ${fallbackName} API:`, primaryError.message);
          }
        }

        if (fallbackOp) {
          try {
            const result = await fallbackOp();
            return { ...result, source: fallbackSource } as T & { source?: string };
          } catch (fallbackError: any) {
            sources.push(`${fallbackName}: ${fallbackError.message}`);
            throw new Error(`All sources failed for ${operationName}: ${sources.join(', ')}`);
          }
        }

        throw nodeError;
      }
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `${operationName} failed: ${error.message}`);
    }
  }

  async trongridApiCall({ endpoint, method = 'POST', data = {} }: {
    endpoint: string; method?: string; data?: Record<string, any>;
  }): Promise<McpToolResponse> {
    try {
      const isV1Endpoint = endpoint.startsWith('/v1/');
      const baseUrl = isV1Endpoint
        ? (process.env.TRONGRID_API_URL || 'https://api.trongrid.io')
        : (process.env.FULL_NODE_URL || 'https://api.trongrid.io');
      const url = `${baseUrl}${endpoint}`;

      const isExternalApi = baseUrl.includes('trongrid.io') || baseUrl.includes('tronstack.io');
      if (isExternalApi) {
        await this.trongridRateLimiter.throttle();
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.TRONGRID_API_KEY) {
        headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
      }

      const options: any = { method: method.toUpperCase(), headers };
      if (method.toUpperCase() === 'POST') {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);

      if (response.status === 429 && isExternalApi) {
        const body = await response.text();
        this.trongridRateLimiter.handle429(response, body);
      }

      if (!response.ok) {
        throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            endpoint, method, data, result,
            timestamp: new Date().toISOString(),
            source: 'trongrid_api',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `TronGrid API call failed: ${error.message}`);
    }
  }

  async tronscanApiCall({ endpoint, params = {} }: {
    endpoint: string; params?: Record<string, any>;
  }): Promise<McpToolResponse> {
    try {
      const tronscanUrl = 'https://apilist.tronscanapi.com';
      const url = new URL(`${tronscanUrl}${endpoint}`);

      Object.keys(params).forEach(key => {
        url.searchParams.append(key, params[key]);
      });

      await this.tronscanRateLimiter.throttle();

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.TRONSCAN_API_KEY) {
        headers['TRON-PRO-API-KEY'] = process.env.TRONSCAN_API_KEY;
      }

      const response = await fetch(url.toString(), { method: 'GET', headers });

      if (response.status === 429) {
        const body = await response.text();
        this.tronscanRateLimiter.handle429(response, body);
      }

      if (!response.ok) {
        throw new Error(`TronScan API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            endpoint, params, result,
            timestamp: new Date().toISOString(),
            source: 'tronscan_api',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `TronScan API call failed: ${error.message}`);
    }
  }

  private async getTrongridAccount({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      return await this.trongridApiCall({
        endpoint: `/v1/accounts/${address}`,
        method: 'GET',
        data: {},
      });
    } catch (error: any) {
      try {
        return await this.trongridApiCall({
          endpoint: '/wallet/getaccount',
          method: 'POST',
          data: { address, visible: true },
        });
      } catch {
        throw new McpError(ErrorCode.InternalError, `TronGrid account request failed: ${error.message}`);
      }
    }
  }

  private async estimateContractDeploy({ bytecodeHex, ownerAddress, callValue = 0 }: {
    bytecodeHex: string; ownerAddress?: string; callValue?: number;
  }): Promise<McpToolResponse> {
    try {
      const fromAddress = ownerAddress || this.tronWeb.defaultAddress?.base58 || 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';

      const apiResult = await this.trongridApiCall({
        endpoint: '/wallet/triggerconstantcontract',
        method: 'POST',
        data: {
          owner_address: fromAddress,
          contract_address: '',
          data: bytecodeHex,
          call_value: callValue,
          visible: true,
        },
      });

      const parsed = JSON.parse(apiResult.content[0]!.text).result;
      const energyUsed = parsed.energy_used || 0;
      const bytecodeSize = bytecodeHex.length / 2;
      const bandwidthCost = bytecodeSize + 200;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ownerAddress: fromAddress,
            estimatedEnergy: energyUsed,
            estimatedBandwidth: bandwidthCost,
            bytecodeSize,
            callValue,
            note: 'Deploying to a new address incurs a 1 TRX account activation fee. Bandwidth cost is approximate.',
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to estimate contract deploy: ${error.message}`);
    }
  }

  private async getContractInfo({ contractAddress }: { contractAddress: string }): Promise<McpToolResponse> {
    try {
      let trongridData: any = null;
      let tronscanData: any = null;

      // TronGrid: getcontractinfo
      try {
        const apiResult = await this.trongridApiCall({
          endpoint: '/wallet/getcontractinfo',
          method: 'POST',
          data: { value: contractAddress, visible: true },
        });
        trongridData = JSON.parse(apiResult.content[0]!.text).result;
      } catch (err: any) {
        console.error('TronGrid getcontractinfo failed:', err.message);
      }

      // TronScan: contract enrichment
      try {
        tronscanData = await this.tronScanAPI.getContractInfo(contractAddress);
      } catch (err: any) {
        console.error('TronScan contract info failed:', err.message);
      }

      const merged: any = {
        contractAddress,
        timestamp: new Date().toISOString(),
      };

      if (trongridData) {
        merged.abi = trongridData.abi;
        merged.bytecode = trongridData.bytecode;
        merged.origin_address = trongridData.origin_address;
        merged.consume_user_resource_percent = trongridData.consume_user_resource_percent;
        merged.origin_energy_limit = trongridData.origin_energy_limit;
        merged.contract_state = trongridData.contract_state;
      }

      if (tronscanData) {
        merged.name = tronscanData.name;
        merged.verified = tronscanData.verify_status;
        merged.is_proxy = tronscanData.is_proxy;
        merged.token = tronscanData.token;
        merged.tag = tronscanData.tag1;
        merged.balance_in_usd = tronscanData.balance_in_usd;
      }

      if (!trongridData && !tronscanData) {
        throw new Error('Both TronGrid and TronScan failed to return contract info');
      }

      return { content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract info: ${error.message}`);
    }
  }

  private async getContractEnergyStats({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getContractEnergyStats(address);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract energy stats: ${error.message}`);
    }
  }

  private async getContractCallStats({ contract_address }: { contract_address: string }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getContractCallStats(contract_address);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract call stats: ${error.message}`);
    }
  }

  private async getContractCallers({ address, day, start, limit }: {
    address: string; day?: number; start?: number; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getContractCallers(address, { day, start, limit });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract callers: ${error.message}`);
    }
  }

  private async getContractDailyActivity({ address, start_timestamp, end_timestamp }: {
    address: string; start_timestamp?: number; end_timestamp?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getContractDailyActivity(address, { start_timestamp, end_timestamp });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract daily activity: ${error.message}`);
    }
  }

  private async getContractAnalysis({ address, type, start_timestamp, end_timestamp }: {
    address: string; type?: string; start_timestamp?: number; end_timestamp?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getContractAnalysis(address, { type, start_timestamp, end_timestamp });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract analysis: ${error.message}`);
    }
  }

  private async getContractEvents({ contractAddress, limit = 20 }: {
    contractAddress: string; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.postRequest('/contracts/smart-contract-triggers-batch', {
        contractAddress,
        limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get contract events: ${error.message}`);
    }
  }

  private async getAccountOverview({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountOverview(address);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account overview: ${error.message}`);
    }
  }

  private async getAccountTokens({ address, start, limit, type }: {
    address: string; start?: number; limit?: number; type?: string;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountTokens(address, { start, limit, type });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account tokens: ${error.message}`);
    }
  }

  private async getAccountVotes({ voter, candidate, start, limit }: {
    voter?: string; candidate?: string; start?: number; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountVotes({ voter, candidate, start, limit });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account votes: ${error.message}`);
    }
  }

  private async getAccountApprovals({ address, type, start, limit }: {
    address: string; type?: string; start?: number; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountApprovals(address, { type, start, limit });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account approvals: ${error.message}`);
    }
  }

  private async getAccountApprovalChanges({ contract_address, from_address, to_address, start, limit }: {
    contract_address: string; from_address?: string; to_address?: string; start?: number; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountApprovalChanges(contract_address, { from_address, to_address, start, limit });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get approval changes: ${error.message}`);
    }
  }

  private async getAccountAnalysis({ address, type, start_timestamp, end_timestamp }: {
    address: string; type?: string; start_timestamp?: number; end_timestamp?: number;
  }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountAnalysis(address, { type, start_timestamp, end_timestamp });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account analysis: ${error.message}`);
    }
  }

  private async getAccountDefi({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountDefi(address);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account DeFi data: ${error.message}`);
    }
  }

  private async getAccountTokenOverview({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      const data = await this.tronScanAPI.getAccountTokenOverview(address);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get account token overview: ${error.message}`);
    }
  }

  async run(): Promise<void> {
    try {
      console.error('[TRON-MCP] Creating transport...');
      const transport = new StdioServerTransport();
      console.error('[TRON-MCP] Connecting to transport...');
      await this.server.connect(transport);

      console.error('MCP TRON Server running on stdio');
      console.error('[TRON-MCP] Server ready to accept connections');

      this.networkMonitor = new NetworkMonitor(
        this.tronWeb,
        this.tronScanAPI,
        this.priceTracker
      );

      setImmediate(async () => {
        try {
          await this.networkMonitor!.initialize();
          console.error('Network monitor initialized successfully');
        } catch (error: any) {
          console.error('Failed to initialize network monitor:', error.message);
          console.error('Network monitor features will be limited');
        }
      });

      process.stdin.resume();

      const cleanup = () => {
        if (this.networkMonitor) {
          this.networkMonitor.stop();
        }
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      process.on('exit', cleanup);
    } catch (error: any) {
      console.error('Failed to start MCP TRON Server:', error.message);
      console.error('Stack trace:', error.stack);
      process.exit(1);
    }
  }
}

console.error('[TRON-MCP] Creating TronMcpServer instance...');
const server = new TronMcpServer();
console.error('[TRON-MCP] Starting server.run()...');
server.run().catch((error) => {
  console.error('[TRON-MCP] Fatal error:', error.message);
  console.error('[TRON-MCP] Stack:', error.stack);
  process.exit(1);
});
