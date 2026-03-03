import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TARGET_ADDRESS = 'TCutjeeXCEgRdNCYHCQxj7mtsp7kjTKSg7';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

let client: Client;
let transport: StdioClientTransport;

/** Call an MCP tool, validate the response envelope, parse and return the JSON payload. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content;
  assert.ok(Array.isArray(content) && content.length > 0, `${name}: expected non-empty content array`);
  assert.equal(content[0].type, 'text', `${name}: expected content type "text"`);
  const data = JSON.parse(content[0].text);
  return data;
}

before(async () => {
  transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    env: process.env as Record<string, string>,
    stderr: 'inherit',
  });

  client = new Client(
    { name: 'integration-test', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
});

after(async () => {
  await transport.close();
});

// ---------------------------------------------------------------------------
// 1. Server connectivity
// ---------------------------------------------------------------------------
describe('Server connectivity', () => {
  it('lists expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t: any) => t.name);

    for (const expected of [
      'get_balance',
      'get_account_resources',
      'get_transactions_by_address',
      'get_trc20_transfers_by_address',
      'get_transaction',
    ]) {
      assert.ok(names.includes(expected), `Missing tool: ${expected}`);
    }

    console.log(`  [tools] ${tools.length} tools registered`);
  });
});

// ---------------------------------------------------------------------------
// 2. Account analysis
// ---------------------------------------------------------------------------
describe('Account analysis', () => {
  it('get_balance returns expected shape', { timeout: 30_000 }, async () => {
    const data = await callTool('get_balance', { address: TARGET_ADDRESS });

    assert.ok('address' in data, 'missing address');
    assert.ok(
      typeof data.balance === 'number' || typeof data.balance === 'string',
      'balance should be a number or numeric string',
    );
    assert.ok(Number(data.balanceInSun) >= 0, 'balanceInSun should be >= 0');
    assert.equal(data.unit, 'TRX', 'unit should be TRX');
    assert.ok('source' in data, 'missing source field');

    console.log(`  [balance] ${data.balance} TRX (source: ${data.source})`);
  });

  it('get_account_resources returns resource fields', { timeout: 30_000 }, async () => {
    const data = await callTool('get_account_resources', { address: TARGET_ADDRESS });

    assert.ok('freeNetLimit' in data || 'NetLimit' in data || 'EnergyLimit' in data,
      'expected at least one resource field');

    console.log(`  [resources] freeNetLimit=${data.freeNetLimit ?? 'N/A'}, ` +
      `NetLimit=${data.NetLimit ?? 'N/A'}, EnergyLimit=${data.EnergyLimit ?? 'N/A'}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Transaction history
// ---------------------------------------------------------------------------
let outgoingHashes: string[] = [];

describe('Transaction history', () => {
  it('fetches all transactions', { timeout: 30_000 }, async () => {
    const data = await callTool('get_transactions_by_address', {
      address: TARGET_ADDRESS,
      direction: 'all',
      limit: 20,
    });

    const txs = data.transactions ?? data;
    assert.ok(Array.isArray(txs) && txs.length > 0, 'expected at least one transaction');

    for (const tx of txs) {
      assert.ok(tx.hash || tx.txID, 'tx missing hash/txID');
    }

    // Log type breakdown
    const types: Record<string, number> = {};
    for (const tx of txs) {
      const t = tx.type ?? tx.contractType ?? 'unknown';
      types[t] = (types[t] || 0) + 1;
    }
    console.log(`  [txs-all] ${txs.length} transactions, types:`, types);
  });

  it('fetches outgoing transactions', { timeout: 30_000 }, async () => {
    const data = await callTool('get_transactions_by_address', {
      address: TARGET_ADDRESS,
      direction: 'outgoing',
      limit: 10,
    });

    const txs = data.transactions ?? data;
    assert.ok(Array.isArray(txs), 'expected array of transactions');

    for (const tx of txs) {
      const from = (tx.from ?? tx.ownerAddress ?? '').toLowerCase();
      assert.ok(
        from === TARGET_ADDRESS.toLowerCase() || from === '',
        `outgoing tx from=${from} does not match target address`,
      );
    }

    // Collect hashes for fee analysis
    outgoingHashes = txs
      .map((tx: any) => tx.hash ?? tx.txID)
      .filter(Boolean)
      .slice(0, 3);

    console.log(`  [txs-out] ${txs.length} outgoing, collected ${outgoingHashes.length} hashes for fee analysis`);
  });

  it('fetches incoming transactions', { timeout: 30_000 }, async () => {
    const data = await callTool('get_transactions_by_address', {
      address: TARGET_ADDRESS,
      direction: 'incoming',
      limit: 10,
    });

    const txs = data.transactions ?? data;
    assert.ok(Array.isArray(txs), 'expected array of transactions');

    for (const tx of txs) {
      const to = (tx.to ?? tx.toAddress ?? '').toLowerCase();
      assert.ok(
        to === TARGET_ADDRESS.toLowerCase() || to === '',
        `incoming tx to=${to} does not match target address`,
      );
    }

    console.log(`  [txs-in] ${txs.length} incoming transactions`);
  });
});

// ---------------------------------------------------------------------------
// 4. Fee analysis
// ---------------------------------------------------------------------------
describe('Fee analysis', () => {
  it('analyzes fees from outgoing transactions', { timeout: 60_000 }, async () => {
    if (outgoingHashes.length === 0) {
      console.log('  [fees] skipped — no outgoing tx hashes available');
      return;
    }

    let totalFeeSun = 0;
    let totalEnergy = 0;
    let totalBandwidth = 0;

    for (const hash of outgoingHashes) {
      const data = await callTool('get_transaction', { txHash: hash });

      const fee = data.info?.fee ?? data.fee ?? 0;
      const energy = data.info?.receipt?.energy_usage_total ?? data.receipt?.energy_usage_total ?? 0;
      const bandwidth = data.info?.receipt?.net_usage ?? data.receipt?.net_usage ?? 0;

      totalFeeSun += fee;
      totalEnergy += energy;
      totalBandwidth += bandwidth;
    }

    console.log(`  [fees] ${outgoingHashes.length} txs: ` +
      `total fee = ${totalFeeSun} SUN (${totalFeeSun / 1_000_000} TRX), ` +
      `energy = ${totalEnergy}, bandwidth = ${totalBandwidth}`);
  });
});

// ---------------------------------------------------------------------------
// 5. TRC20 transfer analysis
// ---------------------------------------------------------------------------
describe('TRC20 transfer analysis', () => {
  it('fetches all TRC20 transfers', { timeout: 30_000 }, async () => {
    const data = await callTool('get_trc20_transfers_by_address', {
      address: TARGET_ADDRESS,
      limit: 20,
    });

    const transfers = data.transfers ?? data;
    assert.ok(Array.isArray(transfers) && transfers.length > 0, 'expected at least one TRC20 transfer');

    // Token breakdown with BigInt volumes
    const tokens: Record<string, { count: number; volume: bigint; symbol: string }> = {};
    for (const t of transfers) {
      const addr = t.tokenAddress ?? t.token_info?.address ?? 'unknown';
      const symbol = t.tokenSymbol ?? t.token_info?.symbol ?? addr.slice(0, 8);
      if (!tokens[addr]) tokens[addr] = { count: 0, volume: 0n, symbol };
      tokens[addr].count++;
      try {
        tokens[addr].volume += BigInt(t.value ?? t.amount ?? '0');
      } catch { /* skip unparseable amounts */ }
    }

    console.log(`  [trc20-all] ${transfers.length} transfers`);
    for (const [addr, info] of Object.entries(tokens)) {
      console.log(`    ${info.symbol} (${addr.slice(0, 12)}...): ${info.count} transfers, raw volume = ${info.volume.toString()}`);
    }
  });

  it('filters TRC20 transfers by USDT contract', { timeout: 30_000 }, async () => {
    const data = await callTool('get_trc20_transfers_by_address', {
      address: TARGET_ADDRESS,
      contract_address: USDT_CONTRACT,
      limit: 20,
    });

    const transfers = data.transfers ?? data;
    assert.ok(Array.isArray(transfers), 'expected array of transfers');

    for (const t of transfers) {
      const tokenAddr = t.tokenAddress ?? t.token_info?.address ?? '';
      assert.equal(tokenAddr, USDT_CONTRACT, `expected USDT contract, got ${tokenAddr}`);
    }

    console.log(`  [trc20-usdt] ${transfers.length} USDT transfers`);
  });
});
