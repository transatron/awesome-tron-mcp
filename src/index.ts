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
        parseInt(process.env.TRONGRID_API_RATE_LIMIT || '') || 3
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

    if (process.env.PRIVATE_KEY) {
      this.tronWeb.setPrivateKey(process.env.PRIVATE_KEY);
    } else {
      this.tronWeb.setAddress('TSLbRevWFn3hktZmfDrzRbDLfEA6RQjNwK');
    }

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
          name: 'send_trx',
          description: 'Send TRX to an address',
          inputSchema: {
            type: 'object' as const,
            properties: {
              to: { type: 'string', description: 'Recipient TRON address' },
              amount: { type: 'number', description: 'Amount in TRX' },
              privateKey: { type: 'string', description: 'Private key of sender (optional if set in env)' },
            },
            required: ['to', 'amount'],
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
            },
            required: ['contractAddress', 'functionName'],
          },
        },
        {
          name: 'get_java_tron_releases',
          description: 'Get latest java-tron releases from GitHub',
          inputSchema: {
            type: 'object' as const,
            properties: {
              limit: { type: 'number', description: 'Number of releases to fetch (default: 10)' },
            },
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
          name: 'get_java_tron_readme',
          description: 'Get java-tron README documentation',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_java_tron_file',
          description: 'Get content of a specific file from java-tron repository',
          inputSchema: {
            type: 'object' as const,
            properties: {
              path: { type: 'string', description: 'File path in the repository' },
            },
            required: ['path'],
          },
        },
        {
          name: 'search_java_tron',
          description: 'Search in java-tron repository',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query' },
              type: { type: 'string', description: 'Search type: code, issues, commits (default: code)' },
              limit: { type: 'number', description: 'Number of results (default: 20)' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_java_tron_structure',
          description: 'Get java-tron repository structure and modules',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_java_tron_protos',
          description: 'Get Protocol Buffer definitions from java-tron',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'get_java_tron_issues',
          description: 'Get recent issues from java-tron repository',
          inputSchema: {
            type: 'object' as const,
            properties: {
              state: { type: 'string', description: 'Issue state: open, closed, all (default: open)' },
              limit: { type: 'number', description: 'Number of issues (default: 20)' },
            },
          },
        },
        {
          name: 'estimate_contract_energy',
          description: 'Estimate energy consumption for smart contract interaction using TRON node',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
              functionName: { type: 'string', description: 'Function name to call' },
              parameters: { type: 'array', description: 'Function parameters', items: {} },
              callerAddress: { type: 'string', description: 'Address of the caller (optional)' },
              feeLimit: { type: 'number', description: 'Fee limit in SUN (optional, default: 100000000)' },
            },
            required: ['contractAddress', 'functionName'],
          },
        },
        {
          name: 'batch_estimate_energy',
          description: 'Batch estimate energy for multiple contract calls',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractCalls: {
                type: 'array',
                description: 'Array of contract call objects',
                items: {
                  type: 'object',
                  properties: {
                    contractAddress: { type: 'string' },
                    functionName: { type: 'string' },
                    parameters: { type: 'array' },
                    callerAddress: { type: 'string' },
                    feeLimit: { type: 'number' },
                  },
                  required: ['contractAddress', 'functionName'],
                },
              },
            },
            required: ['contractCalls'],
          },
        },
        {
          name: 'analyze_contract_gas',
          description: 'Analyze gas costs for all functions in a smart contract',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contractAddress: { type: 'string', description: 'Smart contract address' },
            },
            required: ['contractAddress'],
          },
        },
        {
          name: 'clear_energy_cache',
          description: 'Clear energy estimation cache',
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
          name: 'get_trongrid_block',
          description: 'Get block information directly from TronGrid API',
          inputSchema: {
            type: 'object' as const,
            properties: {
              blockNumber: { type: 'number', description: 'Block number (optional, returns latest if not provided)' },
              onlyNumber: { type: 'boolean', description: 'Return only block number (compact output)' },
            },
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
          case 'send_trx':
            return await this.accountModule.sendTrx(args as any);
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
          case 'get_java_tron_releases':
            return await this.getJavaTronReleases(args as any);
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
          case 'get_java_tron_readme':
            return await this.getJavaTronReadme();
          case 'get_java_tron_file':
            return await this.getJavaTronFile(args as any);
          case 'search_java_tron':
            return await this.searchJavaTron(args as any);
          case 'get_java_tron_structure':
            return await this.getJavaTronStructure();
          case 'get_java_tron_protos':
            return await this.getJavaTronProtos();
          case 'get_java_tron_issues':
            return await this.getJavaTronIssues(args as any);
          case 'estimate_contract_energy':
            console.error('[TRON-MCP] estimate_contract_energy called with args:', JSON.stringify(args, null, 2));
            return await this.estimateContractEnergy(args as any);
          case 'batch_estimate_energy':
            return await this.batchEstimateEnergy(args as any);
          case 'analyze_contract_gas':
            return await this.analyzeContractGas(args as any);
          case 'clear_energy_cache':
            return await this.clearEnergyCache();
          case 'trongrid_api_call':
            return await this.trongridApiCall(args as any);
          case 'tronscan_api_call':
            return await this.tronscanApiCall(args as any);
          case 'get_trongrid_block':
            return await this.getTrongridBlock(args as any);
          case 'get_trongrid_account':
            return await this.getTrongridAccount(args as any);
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

  private async estimateEnergy({ contractAddress, functionName, parameters = [] }: {
    contractAddress: string; functionName: string; parameters?: any[];
  }): Promise<McpToolResponse> {
    try {
      return await this.estimateContractEnergy({
        contractAddress,
        functionName,
        parameters,
        callerAddress: undefined,
        feeLimit: 100000000,
      });
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to estimate energy: ${error.message}`);
    }
  }

  private async getJavaTronReleases({ limit = 10 }: { limit?: number }): Promise<McpToolResponse> {
    try {
      const releases = await this.documentation.getJavaTronReleases(limit);
      return { content: [{ type: 'text', text: JSON.stringify(releases, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get java-tron releases: ${error.message}`);
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
          const response = await fetch('https://api.trongrid.io/wallet/getchainparameters', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '',
            },
            body: JSON.stringify({}),
          });

          if (!response.ok) {
            throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
          }

          const data: any = await response.json();
          return this.processChainParametersForEnergyPrices(data.chainParameter || []);
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

  private async getJavaTronReadme(): Promise<McpToolResponse> {
    try {
      const readme = await this.documentation.getJavaTronReadme();
      return { content: [{ type: 'text', text: readme.content }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get java-tron README: ${error.message}`);
    }
  }

  private async getJavaTronFile({ path }: { path: string }): Promise<McpToolResponse> {
    try {
      const file = await this.documentation.getJavaTronFileContent(path);
      return { content: [{ type: 'text', text: JSON.stringify(file, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get file content: ${error.message}`);
    }
  }

  private async searchJavaTron({ query, type = 'code', limit = 20 }: {
    query: string; type?: string; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const results = await this.documentation.searchJavaTronRepo(query, { type, limit });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to search java-tron: ${error.message}`);
    }
  }

  private async getJavaTronStructure(): Promise<McpToolResponse> {
    try {
      const structure = await this.documentation.getJavaTronStructure();
      return { content: [{ type: 'text', text: JSON.stringify(structure, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get java-tron structure: ${error.message}`);
    }
  }

  private async getJavaTronProtos(): Promise<McpToolResponse> {
    try {
      const protos = await this.documentation.getProtocolBuffers();
      return { content: [{ type: 'text', text: JSON.stringify(protos, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get Protocol Buffers: ${error.message}`);
    }
  }

  private async getJavaTronIssues({ state = 'open', limit = 20 }: {
    state?: string; limit?: number;
  }): Promise<McpToolResponse> {
    try {
      const issues = await this.documentation.getJavaTronIssues(state, limit);
      return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to get issues: ${error.message}`);
    }
  }

  private async estimateContractEnergy({ contractAddress, functionName, parameters = [], callerAddress, feeLimit = 100000000 }: {
    contractAddress: string; functionName: string; parameters?: any[]; callerAddress?: string; feeLimit?: number;
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
          const fromAddress = callerAddress || 'TU4vEruvZwLLkSfV9bNw12EJTPvNr7Pvaa';
          console.error(`[TRON-MCP] Using sender address: ${fromAddress}`);

          try {
            let parameter_hex = '';

            if (contractAddress === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' && functionName === 'transfer' && parameters.length === 2) {
              const userAddress = parameters[0];
              const amount = parameters[1];
              const isUserAddressProvided = userAddress && typeof userAddress === 'string' && userAddress.startsWith('T') && userAddress.length === 34;

              if (isUserAddressProvided) {
                try {
                  const encodedParams = this.tronWeb.utils.abi.encodeParams(['address', 'uint256'], [userAddress, amount]);
                  parameter_hex = encodedParams.replace(/^0x/, '');

                  const apiResult = await this.trongridApiCall({
                    endpoint: '/wallet/triggerconstantcontract',
                    method: 'POST',
                    data: {
                      owner_address: fromAddress,
                      contract_address: contractAddress,
                      function_selector: 'transfer(address,uint256)',
                      parameter: parameter_hex,
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
                        energy: energyUsed, method: 'triggerconstantcontract', accuracy: 'high',
                        recipient_address: userAddress, api_response: parsed,
                      },
                    },
                    recommended: energyUsed,
                    timestamp: new Date().toISOString(),
                  };
                } catch (error: any) {
                  console.error(`[TRON-MCP] Failed to check user address: ${error.message}`);
                  return await this.estimateUSDTDualAddress(fromAddress, contractAddress, functionName, parameters, amount);
                }
              } else {
                const amount = parameters[1];
                return await this.estimateUSDTDualAddress(fromAddress, contractAddress, functionName, parameters, amount);
              }
            }

            // Non-USDT contracts
            const apiResult = await this.trongridApiCall({
              endpoint: '/wallet/triggerconstantcontract',
              method: 'POST',
              data: {
                owner_address: fromAddress,
                contract_address: contractAddress,
                function_selector: functionName,
                parameter: parameter_hex,
                visible: true,
              },
            });

            const parsed = JSON.parse(apiResult.content[0]!.text).result;
            const energyUsed = parsed.energy_used || 0;
            const displayToAddress = parameters.length > 0 ? parameters[0] : null;
            const finalEnergy = energyUsed > 0 ? energyUsed : this.getFallbackEnergyEstimate(functionName, parameters, contractAddress, displayToAddress);

            return {
              contractAddress, functionName, parameters,
              callerAddress: fromAddress,
              estimations: {
                trongrid: {
                  energy: finalEnergy, method: 'triggerconstantcontract',
                  accuracy: energyUsed > 0 ? 'high' : 'medium',
                  raw_energy_used: energyUsed, api_response: parsed,
                  recipient_address: displayToAddress,
                },
              },
              recommended: finalEnergy,
              timestamp: new Date().toISOString(),
            };
          } catch (apiError: any) {
            console.error('TronGrid API call failed:', apiError.message);
            const displayToAddress = parameters.length > 0 ? parameters[0] : null;
            const energy = this.getFallbackEnergyEstimate(functionName, parameters, contractAddress, displayToAddress);
            return {
              contractAddress, functionName, parameters,
              callerAddress: fromAddress,
              estimations: {
                fallback: { energy, method: 'predefined', accuracy: 'medium', error: apiError.message },
              },
              recommended: energy,
              timestamp: new Date().toISOString(),
            };
          }
        },
        tronscan: async () => {
          const displayToAddress = parameters.length > 0 ? parameters[0] : null;
          const energy = this.getFallbackEnergyEstimate(functionName, parameters, contractAddress, displayToAddress);
          return {
            contractAddress, functionName, parameters,
            callerAddress: callerAddress || 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH',
            estimations: {
              fallback: { energy, method: 'predefined', accuracy: 'medium' },
            },
            recommended: energy,
            timestamp: new Date().toISOString(),
          };
        },
      }, 'estimateContractEnergy');

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to estimate contract energy: ${error.message}`);
    }
  }

  private async estimateUSDTDualAddress(
    fromAddress: string, contractAddress: string, functionName: string, parameters: any[], amount: any
  ): Promise<any> {
    const addressWithUSDT = 'TAHT3rrriD23a6AXmaM2YJRRvTYusKGVwD';
    const addressWithoutUSDT = 'TZ4UXDV5ZhNW7fb2AMSbgfAEZ7hWsnYS2g';
    const results: any = {};

    try {
      const encodedParams = this.tronWeb.utils.abi.encodeParams(['address', 'uint256'], [addressWithUSDT, amount]);
      const resultWithUSDT = await this.trongridApiCall({
        endpoint: '/wallet/triggerconstantcontract',
        method: 'POST',
        data: {
          owner_address: fromAddress, contract_address: contractAddress,
          function_selector: 'transfer(address,uint256)',
          parameter: encodedParams.replace(/^0x/, ''), visible: true,
        },
      });
      const parsed = JSON.parse(resultWithUSDT.content[0]!.text).result;
      results.withUSDT = { address: addressWithUSDT, energy: parsed.energy_used || 0, api_response: parsed };
    } catch (err: any) {
      results.withUSDT = { address: addressWithUSDT, energy: 64285, error: err.message };
    }

    try {
      const encodedParams = this.tronWeb.utils.abi.encodeParams(['address', 'uint256'], [addressWithoutUSDT, amount]);
      const resultWithoutUSDT = await this.trongridApiCall({
        endpoint: '/wallet/triggerconstantcontract',
        method: 'POST',
        data: {
          owner_address: fromAddress, contract_address: contractAddress,
          function_selector: 'transfer(address,uint256)',
          parameter: encodedParams.replace(/^0x/, ''), visible: true,
        },
      });
      const parsed = JSON.parse(resultWithoutUSDT.content[0]!.text).result;
      results.withoutUSDT = { address: addressWithoutUSDT, energy: parsed.energy_used || 0, api_response: parsed };
    } catch (err: any) {
      results.withoutUSDT = { address: addressWithoutUSDT, energy: 130285, error: err.message };
    }

    return {
      contractAddress, functionName, parameters,
      callerAddress: fromAddress,
      estimations: {
        trongrid: {
          energy_with_usdt: results.withUSDT.energy,
          energy_without_usdt: results.withoutUSDT.energy,
          address_with_usdt: results.withUSDT.address,
          address_without_usdt: results.withoutUSDT.address,
          method: 'triggerconstantcontract_dual',
          accuracy: 'high',
          api_responses: {
            with_usdt: results.withUSDT.api_response,
            without_usdt: results.withoutUSDT.api_response,
          },
        },
      },
      recommended: {
        existing_usdt_address: results.withUSDT.energy,
        new_usdt_address: results.withoutUSDT.energy,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private getFallbackEnergyEstimate(functionName: string, parameters: any[], contractAddress: string, toAddress: string | null = null): number {
    const functionLower = functionName.toLowerCase();

    if (contractAddress === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') {
      if (functionLower === 'transfer') {
        if (toAddress) {
          if (toAddress === 'TSLbRevWFn3hktZmfDrzRbDLfEA6RQjNwK') return 28000;
          if (toAddress === 'TAHT3rrriD23a6AXmaM2YJRRvTYusKGVwD') return 13940;
        }
        return 13940;
      }
      if (functionLower === 'approve') return 13180;
      if (functionLower === 'transferfrom') return 18190;
      if (functionLower === 'balanceof') return 680;
    }

    if (functionLower.includes('transfer') || functionLower.includes('send')) return 14010;
    if (functionLower.includes('approve') || functionLower.includes('allowance')) return 10000;
    if (functionLower.includes('swap') || functionLower.includes('exchange')) return 50000;
    if (functionLower.includes('mint') || functionLower.includes('burn')) return 30000;
    if (functionLower.includes('view') || functionLower.includes('get') || functionLower.includes('balance')) return 1000;

    return 20000 + (parameters.length * 5000);
  }

  private async batchEstimateEnergy({ contractCalls }: { contractCalls: any[] }): Promise<McpToolResponse> {
    try {
      if (!this.energyEstimator) throw new Error('Energy estimator not initialized');
      const results = await this.energyEstimator.batchEstimateEnergy(contractCalls);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to batch estimate energy: ${error.message}`);
    }
  }

  private async analyzeContractGas({ contractAddress }: { contractAddress: string }): Promise<McpToolResponse> {
    try {
      if (!this.energyEstimator) throw new Error('Energy estimator not initialized');
      const analysis = await this.energyEstimator.analyzeContractGasCosts(contractAddress);
      return { content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to analyze contract gas: ${error.message}`);
    }
  }

  private async clearEnergyCache(): Promise<McpToolResponse> {
    try {
      if (!this.energyEstimator) throw new Error('Energy estimator not initialized');
      const result = await this.energyEstimator.clearCache();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to clear energy cache: ${error.message}`);
    }
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

  private async getTrongridBlock({ blockNumber, onlyNumber = false }: {
    blockNumber?: number; onlyNumber?: boolean;
  }): Promise<McpToolResponse> {
    try {
      const endpoint = blockNumber ? '/wallet/getblockbynum' : '/wallet/getnowblock';
      const data = blockNumber ? { num: blockNumber } : {};

      const result = await this.trongridApiCall({ endpoint, method: 'POST', data });

      if (onlyNumber) {
        const blockData = JSON.parse(result.content[0]!.text).result;
        const number = blockData.block_header?.raw_data?.number;

        if (!number) throw new Error('Unable to extract block number from response');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              current_block_number: number,
              timestamp: new Date().toISOString(),
              source: 'trongrid_api',
            }, null, 2),
          }],
        };
      }

      return result;
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `TronGrid block request failed: ${error.message}`);
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
