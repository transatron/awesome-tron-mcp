import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TronScanAPI } from './tronscan.js';
import type { PriceTracker } from './price-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NetworkMonitor {
  private tronWeb: any;
  private tronScanAPI: TronScanAPI;
  private priceTracker: PriceTracker;
  private cacheDir: string;
  private networkData: any;
  private updateInterval: ReturnType<typeof setInterval> | null;

  constructor(tronWeb: any, tronScanAPI: TronScanAPI, priceTracker: PriceTracker) {
    this.tronWeb = tronWeb;
    this.tronScanAPI = tronScanAPI;
    this.priceTracker = priceTracker;
    this.cacheDir = path.join(__dirname, '..', 'cache');
    this.networkData = {
      parameters: null,
      statistics: null,
      lastUpdate: null,
    };
    this.updateInterval = null;
  }

  async initialize(): Promise<void> {
    console.error('Initializing network monitor...');
    await this.updateNetworkData();

    this.updateInterval = setInterval(() => {
      this.updateNetworkData().catch(console.error);
    }, 3600000);

    console.error('Network monitor initialized. Updates every hour.');
  }

  async updateNetworkData(): Promise<any> {
    console.error('Updating network data...');

    try {
      const parameters = await this.tronWeb.trx.getChainParameters();
      const nodeInfo = await this.tronWeb.trx.getNodeInfo();
      const currentBlock = await this.tronWeb.trx.getCurrentBlock();
      const tronStats = await this.tronScanAPI.getTronStatistics();
      const energyPrices = await this.tronScanAPI.getEnergyPrices();
      const stakingRate = await this.tronScanAPI.getStakingRate();
      const bandwidthData = await this.tronScanAPI.getBandwidthConsumption();
      const trxPrice = await this.priceTracker.getTRXPrice();

      this.networkData = {
        parameters: this.parseChainParameters(parameters),
        nodeInfo: {
          version: nodeInfo.configNodeInfo?.codeVersion,
          p2pVersion: nodeInfo.configNodeInfo?.p2pVersion,
          listenPort: nodeInfo.configNodeInfo?.listenPort,
          discoverEnable: nodeInfo.configNodeInfo?.discoverEnable,
          activeNodeSize: nodeInfo.configNodeInfo?.activeNodeSize,
          passiveNodeSize: nodeInfo.configNodeInfo?.passiveNodeSize,
          totalFlow: nodeInfo.totalFlow,
          beginSyncNum: nodeInfo.beginSyncNum,
          block: nodeInfo.block,
          solidityBlock: nodeInfo.solidityBlock,
          currentConnectCount: nodeInfo.currentConnectCount,
        },
        currentBlock: {
          number: currentBlock.block_header.raw_data.number,
          timestamp: currentBlock.block_header.raw_data.timestamp,
          witnessAddress: currentBlock.block_header.raw_data.witness_address,
          transactionCount: currentBlock.transactions?.length || 0,
          blockID: currentBlock.blockID,
        },
        statistics: {
          overview: tronStats,
          energyPrices: energyPrices,
          stakingRate: stakingRate,
          bandwidth: bandwidthData,
        },
        price: trxPrice,
        lastUpdate: new Date().toISOString(),
      };

      await this.saveNetworkData();
      console.error('Network data updated successfully');
      return this.networkData;
    } catch (error) {
      console.error('Failed to update network data:', error);
      throw error;
    }
  }

  private parseChainParameters(parameters: any): Record<string, any> {
    const parsed: Record<string, any> = {};
    const params = Array.isArray(parameters) ? parameters : parameters?.chainParameter || [];

    for (const param of params) {
      if (param.key && param.value !== undefined) {
        parsed[param.key] = param.value;
      }
    }

    return parsed;
  }

  private async saveNetworkData(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cacheFile = path.join(this.cacheDir, 'network_data.json');
      await fs.writeFile(cacheFile, JSON.stringify(this.networkData, null, 2));
    } catch (error) {
      console.error('Failed to save network data:', error);
    }
  }

  getNetworkData(): any {
    return this.networkData;
  }

  getChainParameters(): any {
    return this.networkData?.parameters || null;
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}
