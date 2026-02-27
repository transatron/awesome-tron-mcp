declare module 'tronweb' {
  class TronWeb {
    constructor(fullNode: any, solidityNode: any, eventServer: any);

    static providers: {
      HttpProvider: new (url: string) => any;
    };

    trx: {
      getBalance(address: string): Promise<number>;
      getAccountResources(address: string): Promise<any>;
      sendTransaction(to: string, amount: number): Promise<any>;
      getTransaction(txHash: string): Promise<any>;
      getTransactionInfo(txHash: string): Promise<any>;
      getBlock(blockNumber: number): Promise<any>;
      getCurrentBlock(): Promise<any>;
      getChainParameters(): Promise<any>;
      getNodeInfo(): Promise<any>;
      estimateEnergy(contractAddress: string, functionName: string, options: any, parameters: any[], fromAddress: string): Promise<any>;
      sign(transaction: any): Promise<any>;
    };

    transactionBuilder: {
      sendTrx(to: string, amount: number, from: string): Promise<any>;
      triggerConstantContract(contractAddress: string, functionSelector: string, options: any, parameters: any[], fromAddress: string): Promise<any>;
    };

    address: {
      fromHex(hex: string): string;
      toHex(base58: string): string;
    };

    utils: {
      abi: {
        encodeParams(types: string[], values: any[]): string;
      };
    };

    defaultAddress: {
      base58: string;
      hex: string;
    };

    defaultPrivateKey: string | null;

    setHeader(headers: Record<string, string>): void;
    setPrivateKey(key: string): void;
    setAddress(address: string): void;
    fromSun(sun: number): number;
    toSun(trx: number): number;
    isAddress(address: string): boolean;
    contract(): { at(address: string): Promise<any> };
  }

  export default TronWeb;
}
