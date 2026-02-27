export interface McpToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface FallbackOperations<T = any> {
  tronweb: () => Promise<T>;
  trongrid: () => Promise<T>;
  tronscan: () => Promise<T>;
}

export interface NetworkEndpoints {
  fullNode: string;
  solidityNode: string;
  eventServer: string;
  tronScan: string;
}

export interface NetworksConfig {
  mainnet: NetworkEndpoints;
  shasta: NetworkEndpoints;
  nile: NetworkEndpoints;
  [key: string]: NetworkEndpoints;
}

export interface ContractAddressesConfig {
  mainnet: {
    USDT: string;
    USDC: string;
    WTRX: string;
    [key: string]: string;
  };
  shasta: Record<string, string>;
  nile: Record<string, string>;
  [key: string]: Record<string, string>;
}

export interface TrongridApiCallParams {
  endpoint: string;
  method?: string;
  data?: Record<string, any>;
}

export interface TronscanApiCallParams {
  endpoint: string;
  params?: Record<string, any>;
}

export type TrongridApiCallFn = (params: TrongridApiCallParams) => Promise<McpToolResponse>;
export type TronscanApiCallFn = (params: TronscanApiCallParams) => Promise<McpToolResponse>;
export type ExecuteWithFallbackFn = <T>(operations: FallbackOperations<T>, operationName: string) => Promise<T & { source?: string }>;
