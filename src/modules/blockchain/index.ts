import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import type { McpToolResponse, TrongridApiCallFn, TronscanApiCallFn } from '../../types.js';
import type { RateLimiter } from '../../rate-limiter.js';
import type { TronScanAPI } from '../../tronscan.js';

export class BlockchainModule {
  private tronWeb: any;
  private trongridApiCall: TrongridApiCallFn;
  private tronscanApiCall: TronscanApiCallFn;
  private tronScanAPI: TronScanAPI;
  private trongridRateLimiter: RateLimiter | null;
  private tronscanRateLimiter: RateLimiter | null;
  private trc20FingerprintCache: Map<string, string>;

  constructor(
    tronWeb: any,
    trongridApiCall: TrongridApiCallFn,
    tronscanApiCall: TronscanApiCallFn,
    tronScanAPI: TronScanAPI,
    trongridRateLimiter: RateLimiter | null = null,
    tronscanRateLimiter: RateLimiter | null = null
  ) {
    if (!tronWeb) {
      throw new Error('BlockchainModule requires tronWeb instance');
    }
    this.tronWeb = tronWeb;
    this.trongridApiCall = trongridApiCall;
    this.tronscanApiCall = tronscanApiCall;
    this.tronScanAPI = tronScanAPI;
    this.trongridRateLimiter = trongridRateLimiter;
    this.tronscanRateLimiter = tronscanRateLimiter;
    this.trc20FingerprintCache = new Map();
  }

  private getTRC20CacheKey(address: string, contractAddress: string | undefined, direction: string): string {
    return `${address}_${contractAddress || 'all'}_${direction}`;
  }

  private isTronScanPrimary(): boolean {
    const primaryApi = (process.env.PRIMARY_API || 'TRONGRID').toUpperCase();
    return primaryApi === 'TRONSCAN';
  }

  async getTransaction({ txHash }: { txHash: string }): Promise<McpToolResponse> {
    try {
      // Try TronWeb (local node) first
      try {
        const transaction = await this.tronWeb.trx.getTransaction(txHash);
        const transactionInfo = await this.tronWeb.trx.getTransactionInfo(txHash);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              transaction,
              info: transactionInfo,
              source: 'tronweb_node',
            }, null, 2),
          }],
        };
      } catch (nodeError: any) {
        console.error('TronWeb failed, trying TronGrid API:', nodeError.message);

        try {
          const transactionResult = await this.trongridApiCall({
            endpoint: '/wallet/gettransactionbyid',
            method: 'POST',
            data: { value: txHash },
          });

          const infoResult = await this.trongridApiCall({
            endpoint: '/wallet/gettransactioninfobyid',
            method: 'POST',
            data: { value: txHash },
          });

          const transaction = JSON.parse(transactionResult.content[0]!.text).result;
          const info = JSON.parse(infoResult.content[0]!.text).result;

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                transaction,
                info,
                source: 'trongrid_api',
              }, null, 2),
            }],
          };
        } catch (trongridError: any) {
          console.error('TronGrid failed, trying TronScan API:', trongridError.message);

          try {
            const result = await this.tronscanApiCall({
              endpoint: '/api/transaction-info',
              params: { hash: txHash },
            });

            const txData = JSON.parse(result.content[0]!.text).result;

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  transaction: txData,
                  info: txData,
                  source: 'tronscan_api',
                }, null, 2),
              }],
            };
          } catch (tronscanError: any) {
            throw new Error(`All sources failed: ${nodeError.message}, ${trongridError.message}, ${tronscanError.message}`);
          }
        }
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get transaction: ${error.message}`
      );
    }
  }

  async getTransactionsByAddress({ address, direction = 'all', limit = 20, start = 0 }: {
    address: string;
    direction?: string;
    limit?: number;
    start?: number;
  }): Promise<McpToolResponse> {
    try {
      const safeLimit = Math.min(Math.max(1, limit || 20), 50);
      const safeStart = Math.max(0, start || 0);

      const useTronScanFirst = this.isTronScanPrimary();
      const primaryFetch = useTronScanFirst
        ? () => this.getTransactionsByAddressFromTronScan({ address, direction, limit: safeLimit, start: safeStart })
        : () => this.getTransactionsByAddressFromTronGrid({ address, direction, limit: safeLimit, start: safeStart });
      const fallbackFetch = useTronScanFirst
        ? () => this.getTransactionsByAddressFromTronGrid({ address, direction, limit: safeLimit, start: safeStart })
        : () => this.getTransactionsByAddressFromTronScan({ address, direction, limit: safeLimit, start: safeStart });
      const primaryName = useTronScanFirst ? 'TronScan' : 'TronGrid';
      const fallbackName = useTronScanFirst ? 'TronGrid' : 'TronScan';

      try {
        return await primaryFetch();
      } catch (primaryError: any) {
        console.error(`${primaryName} failed, trying ${fallbackName} API:`, primaryError.message);
        return await fallbackFetch();
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get transactions by address: ${error.message}`
      );
    }
  }

  private async getTransactionsByAddressFromTronGrid({ address, direction, limit, start }: {
    address: string; direction: string; limit: number; start: number;
  }): Promise<McpToolResponse> {
    const tronGridApiUrl = process.env.TRONGRID_API_URL || 'https://api.trongrid.io';
    const url = new URL(`${tronGridApiUrl}/v1/accounts/${address}/transactions`);

    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('order_by', 'block_timestamp,desc');

    if (direction === 'incoming') {
      url.searchParams.append('only_to', 'true');
    } else if (direction === 'outgoing') {
      url.searchParams.append('only_from', 'true');
    }

    const isExternalApi = tronGridApiUrl.includes('trongrid.io') || tronGridApiUrl.includes('tronstack.io');
    if (isExternalApi && this.trongridRateLimiter) {
      await this.trongridRateLimiter.throttle();
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.TRONGRID_API_KEY) {
      headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    }

    const response = await fetch(url.toString(), { method: 'GET', headers });

    if (response.status === 429 && isExternalApi && this.trongridRateLimiter) {
      const body = await response.text();
      this.trongridRateLimiter.handle429(response, body);
    }

    if (!response.ok) {
      throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
    }

    const responseData: any = await response.json();
    const transactions = this.mapTronGridTransactions(responseData.data || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          address,
          direction,
          total: responseData.meta?.page_size || transactions.length,
          returned: transactions.length,
          pagination: {
            start,
            limit,
            fingerprint: responseData.meta?.fingerprint || null,
            note: 'TronGrid uses fingerprint-based pagination. Use fingerprint for next page.',
          },
          transactions,
          source: 'trongrid_api',
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }

  private async getTransactionsByAddressFromTronScan({ address, direction, limit, start }: {
    address: string; direction: string; limit: number; start: number;
  }): Promise<McpToolResponse> {
    const params: Record<string, any> = {
      sort: '-timestamp',
      limit,
      start,
      count: true,
    };

    if (direction === 'incoming') {
      params.toAddress = address;
    } else if (direction === 'outgoing') {
      params.fromAddress = address;
    } else {
      params.address = address;
    }

    const result = await this.tronscanApiCall({ endpoint: '/api/transaction', params });
    const responseData = JSON.parse(result.content[0]!.text).result;
    const transactions = this.mapTronScanTransactions(responseData.data || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          address,
          direction,
          total: responseData.total || 0,
          returned: transactions.length,
          pagination: { start, limit },
          transactions,
          source: 'tronscan_api',
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }

  private convertToBase58(address: string): string {
    if (!address) return address;
    if (address.startsWith('T')) return address;
    try {
      return this.tronWeb.address.fromHex(address);
    } catch {
      return address;
    }
  }

  private mapTronGridTransactions(transactions: any[]): any[] {
    return transactions.map(tx => {
      const contract = tx.raw_data?.contract?.[0];
      const contractValue = contract?.parameter?.value || {};

      let from = contractValue.owner_address || tx.raw_data?.contract?.[0]?.parameter?.value?.owner_address;
      let to = contractValue.to_address || contractValue.contract_address || contractValue.receiver_address;

      from = this.convertToBase58(from);
      to = this.convertToBase58(to);

      const contractType = contract?.type;
      const result = tx.ret?.[0]?.contractRet || 'UNKNOWN';

      return {
        hash: tx.txID,
        block: tx.blockNumber,
        timestamp: tx.block_timestamp,
        from,
        to,
        type: contractType,
        confirmed: true,
        result,
      };
    });
  }

  private mapTronScanTransactions(transactions: any[]): any[] {
    return transactions.map(tx => ({
      hash: tx.hash,
      block: tx.block,
      timestamp: tx.timestamp,
      from: tx.ownerAddress,
      to: tx.toAddress,
      type: tx.contractType,
      confirmed: tx.confirmed,
      result: tx.result,
    }));
  }

  async getTRC20TransfersByAddress({ address, contract_address, direction = 'all', limit = 20, start = 0 }: {
    address: string;
    contract_address?: string;
    direction?: string;
    limit?: number;
    start?: number;
  }): Promise<McpToolResponse> {
    try {
      const safeLimit = Math.min(Math.max(1, limit || 20), 50);
      const safeStart = Math.max(0, start || 0);

      const useTronScanFirst = this.isTronScanPrimary();
      const primaryFetch = useTronScanFirst
        ? () => this.getTRC20TransfersFromTronScan({ address, contract_address, direction, limit: safeLimit, start: safeStart })
        : () => this.getTRC20TransfersFromTronGrid({ address, contract_address, direction, limit: safeLimit, start: safeStart });
      const fallbackFetch = useTronScanFirst
        ? () => this.getTRC20TransfersFromTronGrid({ address, contract_address, direction, limit: safeLimit, start: safeStart })
        : () => this.getTRC20TransfersFromTronScan({ address, contract_address, direction, limit: safeLimit, start: safeStart });
      const primaryName = useTronScanFirst ? 'TronScan' : 'TronGrid';
      const fallbackName = useTronScanFirst ? 'TronGrid' : 'TronScan';

      try {
        return await primaryFetch();
      } catch (primaryError: any) {
        console.error(`${primaryName} failed for TRC20 transfers, trying ${fallbackName} API:`, primaryError.message);
        return await fallbackFetch();
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get TRC20 transfers by address: ${error.message}`
      );
    }
  }

  private async getTRC20TransfersFromTronGrid({ address, contract_address, direction, limit, start }: {
    address: string; contract_address?: string; direction: string; limit: number; start: number;
  }): Promise<McpToolResponse> {
    const tronGridApiUrl = process.env.TRONGRID_API_URL || 'https://api.trongrid.io';
    const url = new URL(`${tronGridApiUrl}/v1/accounts/${address}/transactions/trc20`);

    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('order_by', 'block_timestamp,desc');

    if (contract_address) {
      url.searchParams.append('contract_address', contract_address);
    }

    if (direction === 'incoming') {
      url.searchParams.append('only_to', 'true');
    } else if (direction === 'outgoing') {
      url.searchParams.append('only_from', 'true');
    }

    const cacheKey = this.getTRC20CacheKey(address, contract_address, direction);
    const cachedFingerprint = this.trc20FingerprintCache.get(cacheKey);
    if (cachedFingerprint && start > 0) {
      url.searchParams.append('fingerprint', cachedFingerprint);
    }

    const isExternalApi = tronGridApiUrl.includes('trongrid.io') || tronGridApiUrl.includes('tronstack.io');
    if (isExternalApi && this.trongridRateLimiter) {
      await this.trongridRateLimiter.throttle();
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.TRONGRID_API_KEY) {
      headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    }

    const response = await fetch(url.toString(), { method: 'GET', headers });

    if (response.status === 429 && isExternalApi && this.trongridRateLimiter) {
      const body = await response.text();
      this.trongridRateLimiter.handle429(response, body);
    }

    if (!response.ok) {
      throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
    }

    const responseData: any = await response.json();

    if (responseData.meta?.fingerprint) {
      this.trc20FingerprintCache.set(cacheKey, responseData.meta.fingerprint);
    }

    const transfers = this.mapTronGridTRC20Transfers(responseData.data || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          address,
          contract_address: contract_address || null,
          direction,
          total: responseData.meta?.page_size || transfers.length,
          returned: transfers.length,
          pagination: {
            start,
            limit,
            fingerprint: responseData.meta?.fingerprint || null,
            note: 'TronGrid uses fingerprint-based pagination. Use fingerprint for next page.',
          },
          transfers,
          source: 'trongrid_api',
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }

  private async getTRC20TransfersFromTronScan({ address, contract_address, direction, limit, start }: {
    address: string; contract_address?: string; direction: string; limit: number; start: number;
  }): Promise<McpToolResponse> {
    const params: Record<string, any> = {
      sort: '-timestamp',
      limit,
      start,
      count: true,
    };

    if (contract_address) {
      params.contract_address = contract_address;
    }

    if (direction === 'incoming') {
      params.toAddress = address;
    } else if (direction === 'outgoing') {
      params.fromAddress = address;
    } else {
      params.relatedAddress = address;
    }

    const result = await this.tronscanApiCall({ endpoint: '/api/token_trc20/transfers', params });
    const responseData = JSON.parse(result.content[0]!.text).result;
    const transfers = this.mapTronScanTRC20Transfers(responseData.token_transfers || []);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          address,
          contract_address: contract_address || null,
          direction,
          total: responseData.total || 0,
          returned: transfers.length,
          pagination: { start, limit },
          transfers,
          source: 'tronscan_api',
          timestamp: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }

  private mapTronGridTRC20Transfers(transfers: any[]): any[] {
    return transfers.map(tx => ({
      hash: tx.transaction_id,
      block: null,
      timestamp: tx.block_timestamp,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      tokenSymbol: tx.token_info?.symbol || null,
      tokenAddress: tx.token_info?.address || null,
      tokenDecimals: tx.token_info?.decimals || null,
      tokenName: tx.token_info?.name || null,
      confirmed: true,
      result: tx.type || 'Transfer',
    }));
  }

  private mapTronScanTRC20Transfers(transfers: any[]): any[] {
    return transfers.map(tx => ({
      hash: tx.transaction_id,
      block: tx.block || null,
      timestamp: tx.block_ts,
      from: tx.from_address,
      to: tx.to_address,
      value: tx.quant,
      tokenSymbol: tx.tokenInfo?.tokenAbbr || null,
      tokenAddress: tx.tokenInfo?.tokenId || tx.contract_address || null,
      tokenDecimals: tx.tokenInfo?.tokenDecimal || null,
      tokenName: tx.tokenInfo?.tokenName || null,
      confirmed: tx.confirmed !== false,
      result: tx.finalResult || 'SUCCESS',
    }));
  }

  async getBlock({ blockNumber, summary = true, includeTransactions = false, transactionLimit = 10, saveToFile = false, fullResponse = false }: {
    blockNumber?: number;
    summary?: boolean;
    includeTransactions?: boolean;
    transactionLimit?: number;
    saveToFile?: boolean;
    fullResponse?: boolean;
  }): Promise<McpToolResponse> {
    try {
      let block: any;
      let source: string;

      try {
        block = blockNumber
          ? await this.tronWeb.trx.getBlock(blockNumber)
          : await this.tronWeb.trx.getCurrentBlock();
        source = 'tronweb_node';
      } catch (nodeError: any) {
        console.error('Local node failed, trying TronGrid API:', nodeError.message);

        try {
          const tronGridUrl = 'https://api.trongrid.io';
          const endpoint = blockNumber ? '/wallet/getblockbynum' : '/wallet/getnowblock';
          const body = blockNumber ? { num: blockNumber } : {};

          if (this.trongridRateLimiter) {
            await this.trongridRateLimiter.throttle();
          }

          const response = await fetch(`${tronGridUrl}${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '',
            },
            body: JSON.stringify(body),
          });

          if (response.status === 429 && this.trongridRateLimiter) {
            const responseBody = await response.text();
            this.trongridRateLimiter.handle429(response, responseBody);
          }

          if (!response.ok) {
            throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
          }

          block = await response.json();
          source = 'trongrid_api';
        } catch (trongridError: any) {
          block = blockNumber
            ? await this.tronScanAPI.getBlock(blockNumber)
            : await this.tronScanAPI.getCurrentBlock();
          source = 'tronscan_api';
        }
      }

      if (fullResponse) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(block, null, 2),
          }],
        };
      }

      const processedBlock = await this.processBlockData(block, {
        summary,
        includeTransactions,
        transactionLimit,
        saveToFile,
        source,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(processedBlock, null, 2),
        }],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get block: ${error.message}`
      );
    }
  }

  private async processBlockData(block: any, options: {
    summary: boolean;
    includeTransactions: boolean;
    transactionLimit: number;
    saveToFile: boolean;
    source: string;
  }): Promise<any> {
    const { summary, includeTransactions, transactionLimit, saveToFile, source } = options;

    const fullBlockJson = JSON.stringify(block);
    const fullSizeBytes = Buffer.byteLength(fullBlockJson);
    const estimatedTokens = Math.ceil(fullSizeBytes / 4);
    const transactionCount = block.transactions ? block.transactions.length : 0;

    const result: any = {
      block_header: block.block_header,
      blockID: block.blockID,
      block_number: block.block_header?.raw_data?.number,
      timestamp: block.block_header?.raw_data?.timestamp,
      witness_address: block.block_header?.raw_data?.witness_address,
      transaction_count: transactionCount,
      size_info: {
        full_size_bytes: fullSizeBytes,
        estimated_tokens: estimatedTokens,
        exceeds_limit: estimatedTokens > 25000,
      },
      source,
    };

    if (includeTransactions && block.transactions && block.transactions.length > 0) {
      result.transactions = block.transactions.slice(0, transactionLimit);
      result.transactions_info = {
        included: Math.min(transactionLimit, transactionCount),
        total: transactionCount,
        limited: transactionCount > transactionLimit,
      };
    }

    if (saveToFile) {
      const filePath = await this.saveBlockToFile(block, block.block_header?.raw_data?.number);
      result.full_data_file = filePath;
      result.file_info = {
        path: filePath,
        size_mb: (fullSizeBytes / 1024 / 1024).toFixed(2),
        note: 'Full block data saved to file',
      };
    }

    if (!summary) {
      result.help = {
        message: 'Block data was limited to prevent token overflow',
        options: {
          fullResponse: 'Set to true to get complete block data (may exceed token limit)',
          saveToFile: 'Set to true to save full block to file',
          includeTransactions: 'Set to true to include transactions',
          transactionLimit: `Increase to get more transactions (current: ${transactionLimit})`,
        },
      };
    }

    return result;
  }

  private async saveBlockToFile(block: any, blockNumber: number | undefined): Promise<string> {
    const tempDir = '/tmp/tron-blocks';

    try {
      await fs.mkdir(tempDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create temp directory:', error);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `block_${blockNumber || 'latest'}_${timestamp}.json`;
    const filePath = path.join(tempDir, filename);

    await fs.writeFile(filePath, JSON.stringify(block, null, 2));
    return filePath;
  }

  async getCurrentBlockNumber(): Promise<McpToolResponse> {
    try {
      try {
        const block = await this.tronWeb.trx.getCurrentBlock();
        const blockNumber = block.block_header.raw_data.number;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              current_block_number: blockNumber,
              timestamp: new Date().toISOString(),
              source: 'tronweb',
            }, null, 2),
          }],
        };
      } catch (nodeError: any) {
        console.error('TronWeb failed, trying TronGrid API:', nodeError.message);

        const tronGridUrl = process.env.FULL_NODE_URL || 'https://api.trongrid.io';
        const isExternalApi = tronGridUrl.includes('trongrid.io') || tronGridUrl.includes('tronstack.io');

        if (isExternalApi && this.trongridRateLimiter) {
          await this.trongridRateLimiter.throttle();
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.TRONGRID_API_KEY) {
          headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
        }

        const response = await fetch(`${tronGridUrl}/wallet/getnowblock`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });

        if (response.status === 429 && isExternalApi && this.trongridRateLimiter) {
          const body = await response.text();
          this.trongridRateLimiter.handle429(response, body);
        }

        if (!response.ok) {
          throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
        }

        const block: any = await response.json();
        const blockNumber = block.block_header?.raw_data?.number;

        if (!blockNumber) {
          throw new Error('Unable to extract block number from response');
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              current_block_number: blockNumber,
              timestamp: new Date().toISOString(),
              source: 'trongrid_api',
            }, null, 2),
          }],
        };
      }
    } catch (error: any) {
      try {
        const block = await this.tronScanAPI.getCurrentBlock();
        const blockNumber = block.number || block.block_header?.raw_data?.number;

        if (!blockNumber) {
          throw new Error('Unable to extract block number from TronScan response');
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              current_block_number: blockNumber,
              timestamp: new Date().toISOString(),
              source: 'tronscan_api',
            }, null, 2),
          }],
        };
      } catch {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get current block number from all sources: ${error.message}`
        );
      }
    }
  }
}
