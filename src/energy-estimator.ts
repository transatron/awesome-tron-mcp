import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export class EnergyEstimator {
  private tronWeb: any;
  private cacheDir: string;
  private contractCache: Map<string, any>;

  constructor(tronWeb: any) {
    this.tronWeb = tronWeb;
    this.cacheDir = path.join(process.cwd(), 'cache');
    this.contractCache = new Map();
    this.ensureCacheDirSync();
  }

  private ensureCacheDirSync(): void {
    try {
      if (!fsSync.existsSync(this.cacheDir)) {
        fsSync.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  async estimateContractEnergy(
    contractAddress: string,
    functionName: string,
    parameters: any[] = [],
    callerAddress: string | null = null,
    feeLimit: number = 100000000
  ): Promise<any> {
    try {
      if (!this.tronWeb.isAddress(contractAddress)) {
        throw new Error(`Invalid contract address: ${contractAddress}`);
      }

      const fromAddress = callerAddress || this.tronWeb.defaultAddress.base58;
      if (!fromAddress) {
        throw new Error('No caller address provided and no default address set');
      }

      const contract = await this.getContractInstance(contractAddress);

      const transaction = await this.buildContractTransaction(
        contract,
        functionName,
        parameters,
        fromAddress,
        feeLimit
      );

      const estimations = await this.performEnergyEstimation(
        transaction,
        contractAddress,
        functionName,
        parameters,
        fromAddress
      );

      return {
        contractAddress,
        functionName,
        parameters,
        callerAddress: fromAddress,
        estimations,
        recommended: estimations.triggerConstantContract || estimations.estimateEnergy || estimations.fallback,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error('Energy estimation failed:', error);
      throw new Error(`Energy estimation failed: ${error.message}`);
    }
  }

  private async getContractInstance(contractAddress: string): Promise<any> {
    if (this.contractCache.has(contractAddress)) {
      return this.contractCache.get(contractAddress);
    }

    try {
      const contract = await this.tronWeb.contract().at(contractAddress);
      this.contractCache.set(contractAddress, contract);
      return contract;
    } catch (error: any) {
      throw new Error(`Failed to get contract at ${contractAddress}: ${error.message}`);
    }
  }

  private async buildContractTransaction(
    contract: any,
    functionName: string,
    parameters: any[],
    fromAddress: string,
    feeLimit: number
  ): Promise<any> {
    try {
      if (contract[functionName]) {
        const tx = await contract[functionName](...parameters).send({
          feeLimit,
          from: fromAddress,
          shouldPollResponse: false,
        });
        return tx;
      }
      return null;
    } catch (error: any) {
      console.error(`Failed to build transaction for ${functionName}:`, error.message);
      return null;
    }
  }

  private async performEnergyEstimation(
    _transaction: any,
    contractAddress: string,
    functionName: string,
    parameters: any[],
    fromAddress: string
  ): Promise<any> {
    const estimations: any = {};

    // Method 1: triggerConstantContract
    try {
      let functionSelector = functionName;
      if (functionName === 'transfer' && parameters.length === 2) {
        functionSelector = 'transfer(address,uint256)';
      } else if (functionName === 'balanceOf' && parameters.length === 1) {
        functionSelector = 'balanceOf(address)';
      } else if (functionName === 'approve' && parameters.length === 2) {
        functionSelector = 'approve(address,uint256)';
      }

      const result = await this.tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSelector,
        {},
        parameters.map((p: any, i: number) => {
          if (typeof p === 'string' && p.startsWith('T') && p.length === 34) {
            return { type: 'address', value: p };
          }
          if (typeof p === 'number' || (typeof p === 'string' && /^\d+$/.test(p))) {
            return { type: 'uint256', value: p };
          }
          return { type: 'uint256', value: p };
        }),
        fromAddress
      );

      if (result && result.energy_used) {
        estimations.triggerConstantContract = {
          energy: result.energy_used,
          method: 'triggerConstantContract',
          accuracy: 'high',
        };
      }
    } catch (error: any) {
      console.error('triggerConstantContract estimation failed:', error.message);
    }

    // Method 2: estimateEnergy API
    try {
      const result = await this.tronWeb.trx.estimateEnergy(
        contractAddress,
        functionName,
        {},
        parameters,
        fromAddress
      );

      if (result && result.energy_required) {
        estimations.estimateEnergy = {
          energy: result.energy_required,
          method: 'estimateEnergy',
          accuracy: 'high',
        };
      }
    } catch (error: any) {
      console.error('estimateEnergy API failed:', error.message);
    }

    // Method 3: Fallback estimates
    if (!estimations.triggerConstantContract && !estimations.estimateEnergy) {
      estimations.fallback = {
        energy: this.getFallbackEstimate(functionName, contractAddress),
        method: 'fallback',
        accuracy: 'low',
      };
    }

    return estimations;
  }

  private getFallbackEstimate(functionName: string, contractAddress: string): number {
    const fn = functionName.toLowerCase();

    if (contractAddress === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t') {
      if (fn === 'transfer') return 13940;
      if (fn === 'approve') return 13180;
      if (fn === 'transferfrom') return 18190;
      if (fn === 'balanceof') return 680;
    }

    if (fn.includes('transfer') || fn.includes('send')) return 14010;
    if (fn.includes('approve') || fn.includes('allowance')) return 10000;
    if (fn.includes('swap') || fn.includes('exchange')) return 50000;
    if (fn.includes('mint') || fn.includes('burn')) return 30000;
    if (fn.includes('view') || fn.includes('get') || fn.includes('balance')) return 1000;

    return 20000;
  }

  async batchEstimateEnergy(contractCalls: Array<{
    contractAddress: string;
    functionName: string;
    parameters?: any[];
    callerAddress?: string;
    feeLimit?: number;
  }>): Promise<any> {
    const results = await Promise.all(
      contractCalls.map(call =>
        this.estimateContractEnergy(
          call.contractAddress,
          call.functionName,
          call.parameters || [],
          call.callerAddress || null,
          call.feeLimit || 100000000
        ).catch((error: any) => ({
          contractAddress: call.contractAddress,
          functionName: call.functionName,
          error: error.message,
        }))
      )
    );

    return {
      results,
      totalEstimatedEnergy: results.reduce((sum: number, r: any) => {
        if (r.recommended && typeof r.recommended === 'object') {
          return sum + (r.recommended.energy || 0);
        }
        return sum + (r.recommended || 0);
      }, 0),
      timestamp: new Date().toISOString(),
    };
  }

  async analyzeContractGasCosts(contractAddress: string): Promise<any> {
    try {
      const contract = await this.getContractInstance(contractAddress);
      const abi = contract.abi || [];

      const functions = abi.filter((item: any) => item.type === 'function');

      const analysis = {
        contractAddress,
        totalFunctions: functions.length,
        functions: functions.map((fn: any) => ({
          name: fn.name,
          inputs: fn.inputs?.map((i: any) => `${i.type} ${i.name}`),
          stateMutability: fn.stateMutability,
          estimatedGas: fn.stateMutability === 'view' || fn.stateMutability === 'pure'
            ? 'Free (view/pure function)'
            : 'Requires energy',
        })),
        timestamp: new Date().toISOString(),
      };

      return analysis;
    } catch (error: any) {
      throw new Error(`Failed to analyze contract: ${error.message}`);
    }
  }

  async clearCache(): Promise<any> {
    this.contractCache.clear();
    return {
      message: 'Energy estimation cache cleared',
      timestamp: new Date().toISOString(),
    };
  }
}
