import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { PriceTracker } from '../../price-tracker.js';
import type { McpToolResponse } from '../../types.js';

export class MarketModule {
  private priceTracker: PriceTracker;

  constructor(priceTracker: PriceTracker) {
    if (!priceTracker) {
      throw new Error('MarketModule requires priceTracker instance');
    }
    this.priceTracker = priceTracker;
  }

  async getTRXPrice(): Promise<McpToolResponse> {
    try {
      const priceData = await this.priceTracker.getTRXPrice();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(priceData, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get TRX price: ${error.message}`
      );
    }
  }

  async getTRXMarketData(): Promise<McpToolResponse> {
    try {
      const marketData = await this.priceTracker.getTRXMarketData();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(marketData, null, 2),
          },
        ],
      };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get TRX market data: ${error.message}`
      );
    }
  }
}
