/**
 * Smoke tests for all MCP tools.
 *
 * Uses a SINGLE server connection to respect rate limits across all calls.
 * Each tool is called once to verify it returns data from the API.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTransport, createClient, callTool as _callTool } from './helpers.js';

const TEST_WALLET = 'TCutjeeXCEgRdNCYHCQxj7mtsp7kjTKSg7';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const KNOWN_TX = 'a5ef40ae4489f2eb5e0aa8efbf707cb40e498e960331a3498e57a2ccadf4e024';

let client: Client;
let transport: StdioClientTransport;
const call = (name: string, args: Record<string, unknown> = {}) => _callTool(client, name, args);

before(async () => {
  transport = createTransport();
  client = createClient();
  await client.connect(transport);
});

after(async () => {
  await transport.close();
});

// ---------------------------------------------------------------------------
// Tool inventory
// ---------------------------------------------------------------------------
describe('Tool inventory', () => {
  it('registers 38 tools', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 38);
    console.log(`  [inventory] ${tools.length} tools`);
  });
});

// ---------------------------------------------------------------------------
// Account & Wallet (10 tools)
// ---------------------------------------------------------------------------
describe('Account & Wallet', () => {
  it('get_balance', { timeout: 30_000 }, async () => {
    const d = await call('get_balance', { address: TEST_WALLET });
    assert.ok('balance' in d || 'balanceInSun' in d);
    console.log(`  balance: ${d.balance} TRX`);
  });

  it('get_account_resources', { timeout: 30_000 }, async () => {
    const d = await call('get_account_resources', { address: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });

  it('get_account_overview', { timeout: 30_000 }, async () => {
    const d = await call('get_account_overview', { address: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });

  it('get_account_tokens', { timeout: 30_000 }, async () => {
    const d = await call('get_account_tokens', { address: TEST_WALLET, limit: 3 });
    assert.ok(typeof d === 'object');
  });

  it('get_account_votes', { timeout: 30_000 }, async () => {
    const d = await call('get_account_votes', { voter: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });

  it('get_account_approvals', { timeout: 30_000 }, async () => {
    const d = await call('get_account_approvals', { address: TEST_WALLET, limit: 3 });
    assert.ok(typeof d === 'object');
  });

  it('get_account_approval_changes', { timeout: 30_000 }, async () => {
    const d = await call('get_account_approval_changes', { contract_address: USDT_CONTRACT, limit: 3 });
    assert.ok(d !== undefined && d !== null);
  });

  it('get_account_analysis', { timeout: 30_000 }, async () => {
    const d = await call('get_account_analysis', { address: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });

  it('get_account_defi', { timeout: 30_000 }, async () => {
    const d = await call('get_account_defi', { address: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });

  it('get_account_token_overview', { timeout: 30_000 }, async () => {
    const d = await call('get_account_token_overview', { address: TEST_WALLET });
    assert.ok(typeof d === 'object');
  });
});

// ---------------------------------------------------------------------------
// Transactions & Blocks (5 tools)
// ---------------------------------------------------------------------------
describe('Transactions & Blocks', () => {
  it('get_transaction', { timeout: 30_000 }, async () => {
    const d = await call('get_transaction', { txHash: KNOWN_TX });
    assert.ok(typeof d === 'object');
  });

  it('get_transactions_by_address', { timeout: 30_000 }, async () => {
    const d = await call('get_transactions_by_address', { address: TEST_WALLET, limit: 3 });
    assert.ok(typeof d === 'object');
  });

  it('get_trc20_transfers_by_address', { timeout: 30_000 }, async () => {
    const d = await call('get_trc20_transfers_by_address', {
      address: TEST_WALLET, contract_address: USDT_CONTRACT, limit: 3,
    });
    assert.ok(typeof d === 'object');
  });

  it('get_block', { timeout: 30_000 }, async () => {
    const d = await call('get_block', { blockNumber: 70000000, summary: true });
    assert.ok(typeof d === 'object');
  });

  it('get_current_block_number', { timeout: 30_000 }, async () => {
    const d = await call('get_current_block_number');
    assert.ok(typeof d === 'object');
  });
});

// ---------------------------------------------------------------------------
// Smart Contracts (10 tools)
// ---------------------------------------------------------------------------
describe('Smart Contracts', () => {
  it('contract_call (via trongrid_api_call)', { timeout: 30_000 }, async () => {
    const d = await call('trongrid_api_call', {
      endpoint: '/wallet/triggerconstantcontract',
      method: 'POST',
      data: {
        owner_address: TEST_WALLET,
        contract_address: USDT_CONTRACT,
        function_selector: 'balanceOf(address)',
        parameter: '000000000000000000000000' + 'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
        visible: true,
      },
    });
    assert.ok(typeof d === 'object');
  });

  it('estimate_energy', { timeout: 30_000 }, async () => {
    const d = await call('estimate_energy', {
      contractAddress: USDT_CONTRACT,
      functionName: 'transfer',
      parameters: [TEST_WALLET, 1000000],
      callerAddress: TEST_WALLET,
    });
    assert.ok(typeof d === 'object');
  });

  it('estimate_contract_deploy', { timeout: 30_000 }, async () => {
    const d = await call('estimate_contract_deploy', {
      bytecodeHex: '608060405234801561001057600080fd5b50604051602080610110833981016040525160005560e1806100326000396000f3',
    });
    assert.ok('estimatedEnergy' in d || 'estimatedBandwidth' in d);
  });

  it('get_contract_info', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_info', { contractAddress: USDT_CONTRACT });
    assert.equal(d.contractAddress, USDT_CONTRACT);
  });

  it('get_contract_energy_stats', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_energy_stats', { address: USDT_CONTRACT });
    assert.ok(typeof d === 'object');
  });

  it('get_contract_call_stats', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_call_stats', { contract_address: USDT_CONTRACT });
    assert.ok(typeof d === 'object');
  });

  it('get_contract_callers', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_callers', { address: USDT_CONTRACT, limit: 3 });
    assert.ok(typeof d === 'object');
  });

  it('get_contract_daily_activity', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_daily_activity', { address: USDT_CONTRACT });
    assert.ok(typeof d === 'object');
  });

  it('get_contract_analysis', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_analysis', { address: USDT_CONTRACT });
    assert.ok(typeof d === 'object');
  });

  it('get_contract_events', { timeout: 30_000 }, async () => {
    const d = await call('get_contract_events', { contractAddress: USDT_CONTRACT, limit: 3 });
    assert.ok(typeof d === 'object');
  });
});

// ---------------------------------------------------------------------------
// Market & Network Data (8 tools)
// ---------------------------------------------------------------------------
describe('Market & Network Data', () => {
  it('get_trx_price', { timeout: 30_000 }, async () => {
    const d = await call('get_trx_price');
    assert.ok(typeof d === 'object');
  });

  it('get_trx_market_data', { timeout: 30_000 }, async () => {
    const d = await call('get_trx_market_data');
    assert.ok(typeof d === 'object');
  });

  it('get_network_statistics', { timeout: 30_000 }, async () => {
    const d = await call('get_network_statistics');
    assert.ok(typeof d === 'object');
  });

  it('get_energy_consumption', { timeout: 30_000 }, async () => {
    const d = await call('get_energy_consumption', { limit: 3 });
    assert.ok(typeof d === 'object');
  });

  it('get_defi_tvl', { timeout: 30_000 }, async () => {
    const d = await call('get_defi_tvl');
    assert.ok(typeof d === 'object');
  });

  it('get_staking_info', { timeout: 30_000 }, async () => {
    const d = await call('get_staking_info');
    assert.ok(typeof d === 'object');
  });

  it('get_chain_parameters', { timeout: 30_000 }, async () => {
    const d = await call('get_chain_parameters');
    assert.ok(typeof d === 'object');
  });

  it('get_energy_prices', { timeout: 30_000 }, async () => {
    const d = await call('get_energy_prices');
    assert.ok(typeof d === 'object');
  });
});

// ---------------------------------------------------------------------------
// Documentation (2 tools)
// ---------------------------------------------------------------------------
describe('Documentation', () => {
  it('search_tron_docs', { timeout: 30_000 }, async () => {
    const d = await call('search_tron_docs', { query: 'smart contract energy' });
    assert.ok('resources' in d || 'suggestions' in d);
  });

  it('get_tron_reference', { timeout: 30_000 }, async () => {
    const d = await call('get_tron_reference', { topic: 'fees' });
    assert.ok(typeof d === 'object');
  });
});

// ---------------------------------------------------------------------------
// Raw API Access (3 tools)
// ---------------------------------------------------------------------------
describe('Raw API Access', () => {
  it('trongrid_api_call', { timeout: 30_000 }, async () => {
    const d = await call('trongrid_api_call', {
      endpoint: '/wallet/getnowblock', method: 'POST', data: {},
    });
    assert.ok('result' in d);
  });

  it('tronscan_api_call', { timeout: 30_000 }, async () => {
    const d = await call('tronscan_api_call', {
      endpoint: '/api/block/latest', params: {},
    });
    assert.ok(typeof d === 'object');
  });

  it('get_trongrid_account', { timeout: 30_000 }, async () => {
    const d = await call('get_trongrid_account', { address: USDT_CONTRACT });
    assert.ok(typeof d === 'object');
  });
});
