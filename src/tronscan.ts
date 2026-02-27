import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RateLimiter } from './rate-limiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TronScanAPI {
  private baseURL: string;
  private cacheDir: string;
  private apiKey: string | null;
  private apiKeys: string[];
  private currentKeyIndex: number;
  private rateLimiter: RateLimiter | null;

  constructor() {
    this.baseURL = 'https://apilist.tronscanapi.com/api';
    this.cacheDir = path.join(__dirname, '..', 'cache');
    this.apiKey = process.env.TRONSCAN_API_KEY || null;
    this.apiKeys = process.env.API_KEYS ? process.env.API_KEYS.split(',') : [];
    this.currentKeyIndex = 0;
    this.rateLimiter = null;
    this.ensureCacheDir();
  }

  setRateLimiter(rateLimiter: RateLimiter): void {
    this.rateLimiter = rateLimiter;
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  private getApiKey(): string | null {
    if (this.apiKey) return this.apiKey;
    if (this.apiKeys.length === 0) return null;
    const key = this.apiKeys[this.currentKeyIndex]!;
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  async makeRequest(endpoint: string, params: Record<string, any> = {}): Promise<any> {
    try {
      if (this.rateLimiter) {
        await this.rateLimiter.throttle();
      }

      const apiKey = this.getApiKey();
      const headers: Record<string, string> = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};

      const response = await axios.get(`${this.baseURL}${endpoint}`, {
        params,
        headers,
        timeout: 10000,
        validateStatus: (status: number) => status < 500,
      });

      if (response.status === 429 && this.rateLimiter) {
        this.rateLimiter.handle429(
          { headers: { get: (name: string) => response.headers[name.toLowerCase()] } },
          response.data
        );
      }

      if (response.status >= 400) {
        throw new Error(`TronScan API error: ${response.status} ${response.statusText}`);
      }

      return response.data;
    } catch (error: any) {
      console.error(`TronScan API error for ${endpoint}:`, error.message);
      throw error;
    }
  }

  async getEnergyConsumptionData(limit: number = 10, day: string | null = null): Promise<any> {
    const params: Record<string, any> = { limit };
    if (day) params.day = day;

    return await this.getCachedOrFetch(
      `energy_consumption_${limit}_${day || 'latest'}`,
      () => this.makeRequest('/energydailystatistic', params),
      3600000
    );
  }

  async getEnergyDistribution(): Promise<any> {
    return await this.getCachedOrFetch(
      'energy_distribution',
      () => this.makeRequest('/energystatistic'),
      3600000
    );
  }

  async getContractStatistics(limit: number = 10): Promise<any> {
    return await this.getCachedOrFetch(
      `contract_stats_${limit}`,
      () => this.makeRequest('/statistic/contract', { limit }),
      3600000
    );
  }

  async getTronStatistics(): Promise<any> {
    return await this.getCachedOrFetch(
      'tron_statistics',
      () => this.makeRequest('/stats/overview'),
      1800000
    );
  }

  async getTRXSupplyData(): Promise<any> {
    return await this.getCachedOrFetch(
      'trx_supply',
      () => this.makeRequest('/statistic/supply'),
      3600000
    );
  }

  async getTransactionTrend(days: number = 7): Promise<any> {
    return await this.getCachedOrFetch(
      `transaction_trend_${days}`,
      () => this.makeRequest('/statistic/transaction', { days }),
      3600000
    );
  }

  async getActiveAccounts(days: number = 7): Promise<any> {
    return await this.getCachedOrFetch(
      `active_accounts_${days}`,
      () => this.makeRequest('/statistic/activeaccounts', { days }),
      3600000
    );
  }

  async getBandwidthConsumption(): Promise<any> {
    return await this.getCachedOrFetch(
      'bandwidth_consumption',
      () => this.makeRequest('/netstatistic'),
      3600000
    );
  }

  async getDefiTVL(): Promise<any> {
    return await this.getCachedOrFetch(
      'defi_tvl',
      () => this.makeRequest('/defiTvl'),
      1800000
    );
  }

  async getEnergyPrices(): Promise<any> {
    return await this.getCachedOrFetch(
      'energy_prices',
      () => this.makeRequest('/acquisition_cost_statistic'),
      1800000
    );
  }

  async getStakingRate(): Promise<any> {
    return await this.getCachedOrFetch(
      'staking_rate',
      () => this.makeRequest('/freezeresource'),
      3600000
    );
  }

  async getContractCalledDistribution(contractAddress: string): Promise<any> {
    return await this.getCachedOrFetch(
      `contract_called_${contractAddress}`,
      () => this.makeRequest('/contract/called-distribution', { address: contractAddress }),
      3600000
    );
  }

  async getTokenTVC(): Promise<any> {
    return await this.getCachedOrFetch(
      'token_tvc',
      () => this.makeRequest('/statistic/token/tvc'),
      3600000
    );
  }

  async getBlockSizeData(days: number = 7): Promise<any> {
    return await this.getCachedOrFetch(
      `block_size_${days}`,
      () => this.makeRequest('/statistic/blocksize', { days }),
      3600000
    );
  }

  async getCumulativeBlockSize(): Promise<any> {
    return await this.getCachedOrFetch(
      'cumulative_block_size',
      () => this.makeRequest('/statistic/blocksize/cumulative'),
      3600000
    );
  }

  async getTRXPriceHistory(days: number = 30): Promise<any> {
    return await this.getCachedOrFetch(
      `trx_price_history_${days}`,
      () => this.makeRequest('/statistic/price', { days }),
      1800000
    );
  }

  async getTRXHolders(limit: number = 100): Promise<any> {
    return await this.getCachedOrFetch(
      `trx_holders_${limit}`,
      () => this.makeRequest('/statistic/holders', { limit }),
      3600000
    );
  }

  async getNewUsersDaily(days: number = 7): Promise<any> {
    return await this.getCachedOrFetch(
      `new_users_${days}`,
      () => this.makeRequest('/statistic/newusers', { days }),
      3600000
    );
  }

  async getCurrentBlock(): Promise<any> {
    return await this.getCachedOrFetch(
      'current_block',
      () => this.makeRequest('/block/latest'),
      30000
    );
  }

  async getBlock(blockNumber: number): Promise<any> {
    return await this.getCachedOrFetch(
      `block_${blockNumber}`,
      () => this.makeRequest(`/block/${blockNumber}`),
      3600000
    );
  }

  private async getCachedOrFetch(cacheKey: string, fetchFunction: () => Promise<any>, ttl: number = 3600000): Promise<any> {
    const cacheFile = path.join(this.cacheDir, `${cacheKey}.json`);

    try {
      const stats = await fs.stat(cacheFile);
      const age = Date.now() - stats.mtimeMs;

      if (age < ttl) {
        const cached = await fs.readFile(cacheFile, 'utf8');
        return JSON.parse(cached);
      }
    } catch {
      // Cache miss, continue to fetch
    }

    try {
      const data = await fetchFunction();
      await fs.writeFile(cacheFile, JSON.stringify(data, null, 2));
      return data;
    } catch (error) {
      // If fetch fails, try to return stale cache
      try {
        const cached = await fs.readFile(cacheFile, 'utf8');
        return JSON.parse(cached);
      } catch {
        throw error;
      }
    }
  }

  async clearCache(): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      await Promise.all(
        files.map(file => fs.unlink(path.join(this.cacheDir, file)))
      );
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }
}
