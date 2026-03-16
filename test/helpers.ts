import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const BINANCE_WALLET = 'TLkFYwhd1ZjMz5eFE5GRpARLtCEij2iFWZ';
export const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const KNOWN_TX = 'a5ef40ae4489f2eb5e0aa8efbf707cb40e498e960331a3498e57a2ccadf4e024';

export function createTransport(): StdioClientTransport {
  return new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    env: process.env as Record<string, string>,
    stderr: 'inherit',
  });
}

export function createClient(): Client {
  return new Client(
    { name: 'smoke-test', version: '1.0.0' },
    { capabilities: {} },
  );
}

/** Call an MCP tool, validate envelope, return parsed JSON. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as any).content;
  assert.ok(Array.isArray(content) && content.length > 0, `${name}: expected non-empty content array`);
  assert.equal(content[0].type, 'text', `${name}: expected content type "text"`);
  try {
    return JSON.parse(content[0].text);
  } catch {
    // Some tools return plain text (e.g. docs)
    return content[0].text;
  }
}
