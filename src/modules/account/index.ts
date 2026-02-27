import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolResponse, TrongridApiCallFn, TronscanApiCallFn, ExecuteWithFallbackFn } from '../../types.js';

export class AccountModule {
  private tronWeb: any;
  private trongridApiCall: TrongridApiCallFn;
  private tronscanApiCall: TronscanApiCallFn;
  private executeWithFallback: ExecuteWithFallbackFn;

  constructor(
    tronWeb: any,
    trongridApiCall: TrongridApiCallFn,
    tronscanApiCall: TronscanApiCallFn,
    executeWithFallback: ExecuteWithFallbackFn
  ) {
    if (!tronWeb) {
      throw new Error('AccountModule requires tronWeb instance');
    }
    this.tronWeb = tronWeb;
    this.trongridApiCall = trongridApiCall;
    this.tronscanApiCall = tronscanApiCall;
    this.executeWithFallback = executeWithFallback;
  }

  async getBalance({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      // Try TronWeb (local node) first
      try {
        const balance = await this.tronWeb.trx.getBalance(address);
        const balanceInTrx = this.tronWeb.fromSun(balance);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                address,
                balance: balanceInTrx,
                unit: 'TRX',
                balanceInSun: balance,
                source: 'tronweb_node',
              }, null, 2),
            },
          ],
        };
      } catch (nodeError: any) {
        console.error('TronWeb failed, trying TronGrid API:', nodeError.message);

        // Fallback to TronGrid API
        try {
          const result = await this.trongridApiCall({
            endpoint: '/wallet/getaccount',
            method: 'POST',
            data: { address },
          });

          const accountData = JSON.parse(result.content[0]!.text).result;
          const balance = accountData.balance || 0;
          const balanceInTrx = balance / 1000000;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  address,
                  balance: balanceInTrx,
                  unit: 'TRX',
                  balanceInSun: balance,
                  source: 'trongrid_api',
                }, null, 2),
              },
            ],
          };
        } catch (trongridError: any) {
          console.error('TronGrid failed, trying TronScan API:', trongridError.message);

          // Last fallback to TronScan
          try {
            const result = await this.tronscanApiCall({
              endpoint: '/api/account',
              params: { address },
            });

            const accountData = JSON.parse(result.content[0]!.text).result;
            const balance = accountData.balance || 0;
            const balanceInTrx = balance / 1000000;

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    address,
                    balance: balanceInTrx,
                    unit: 'TRX',
                    balanceInSun: balance,
                    source: 'tronscan_api',
                  }, null, 2),
                },
              ],
            };
          } catch (tronscanError: any) {
            throw new Error(`All sources failed: ${nodeError.message}, ${trongridError.message}, ${tronscanError.message}`);
          }
        }
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get balance: ${error.message}`
      );
    }
  }

  async getAccountResources({ address }: { address: string }): Promise<McpToolResponse> {
    try {
      // Try TronWeb (local node) first
      try {
        const resources = await this.tronWeb.trx.getAccountResources(address);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...resources,
                source: 'tronweb_node',
              }, null, 2),
            },
          ],
        };
      } catch (nodeError: any) {
        console.error('TronWeb failed, trying TronGrid API:', nodeError.message);

        try {
          const result = await this.trongridApiCall({
            endpoint: '/wallet/getaccountresource',
            method: 'POST',
            data: { address },
          });

          const resourceData = JSON.parse(result.content[0]!.text).result;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...resourceData,
                  source: 'trongrid_api',
                }, null, 2),
              },
            ],
          };
        } catch (trongridError: any) {
          console.error('TronGrid failed, trying TronScan API:', trongridError.message);

          try {
            const result = await this.tronscanApiCall({
              endpoint: '/api/account',
              params: { address },
            });

            const accountData = JSON.parse(result.content[0]!.text).result;

            const resources = {
              freeNetLimit: accountData.bandwidth?.freeNetLimit || 0,
              freeNetUsed: accountData.bandwidth?.freeNetUsed || 0,
              NetLimit: accountData.bandwidth?.netLimit || 0,
              NetUsed: accountData.bandwidth?.netUsed || 0,
              EnergyLimit: accountData.bandwidth?.energyLimit || 0,
              EnergyUsed: accountData.bandwidth?.energyUsed || 0,
              source: 'tronscan_api',
            };

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(resources, null, 2),
                },
              ],
            };
          } catch (tronscanError: any) {
            throw new Error(`All sources failed: ${nodeError.message}, ${trongridError.message}, ${tronscanError.message}`);
          }
        }
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get account resources: ${error.message}`
      );
    }
  }

  async sendTrx({ to, amount, privateKey }: { to: string; amount: number; privateKey?: string }): Promise<McpToolResponse> {
    try {
      if (privateKey) {
        this.tronWeb.setPrivateKey(privateKey);
      }

      if (!privateKey && !process.env.PRIVATE_KEY && !this.tronWeb.defaultPrivateKey) {
        throw new Error('Private key required for sending transactions. Set PRIVATE_KEY in environment or provide in request.');
      }

      const result = await this.executeWithFallback({
        tronweb: async () => {
          const transaction = await this.tronWeb.trx.sendTransaction(
            to,
            this.tronWeb.toSun(amount)
          );
          return {
            success: transaction.result,
            txid: transaction.txid,
            transaction,
          };
        },
        trongrid: async () => {
          const unsignedTx = await this.tronWeb.transactionBuilder.sendTrx(
            to,
            this.tronWeb.toSun(amount),
            this.tronWeb.defaultAddress.base58
          );

          const signedTx = await this.tronWeb.trx.sign(unsignedTx);

          const apiResult = await this.trongridApiCall({
            endpoint: '/wallet/broadcasttransaction',
            method: 'POST',
            data: signedTx,
          });

          const broadcastResult = JSON.parse(apiResult.content[0]!.text).result;

          return {
            success: broadcastResult.result || false,
            txid: broadcastResult.txid || signedTx.txID,
            transaction: signedTx,
            broadcastResult,
          };
        },
        tronscan: async () => {
          throw new Error('TronScan API does not support transaction broadcasting - read-only API');
        },
      }, 'sendTrx');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...result,
              to,
              amount,
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to send TRX: ${error.message}`
      );
    }
  }
}
