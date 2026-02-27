import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TronDocumentation {
  private cacheDir: string;
  private sources: Record<string, string>;
  private docTopics: Record<string, string>;

  constructor() {
    this.cacheDir = path.join(__dirname, '..', 'cache');
    this.ensureCacheDir();

    this.sources = {
      javaTronReleases: 'https://api.github.com/repos/tronprotocol/java-tron/releases',
      javaTronRepo: 'https://api.github.com/repos/tronprotocol/java-tron',
      javaTronContents: 'https://api.github.com/repos/tronprotocol/java-tron/contents',
      javaTronRaw: 'https://raw.githubusercontent.com/tronprotocol/java-tron',
      devDocs: 'https://developers.tron.network/docs',
      tronWebDocs: 'https://tronweb.network/docu',
    };

    this.docTopics = {
      'getting-started': 'Getting Started with TRON development',
      'smart-contracts': 'Smart contract development and deployment',
      'trc20': 'TRC20 token standard implementation',
      'trc721': 'TRC721 NFT standard implementation',
      'energy': 'Energy and bandwidth management',
      'staking': 'Staking and resource delegation',
      'apis': 'TRON HTTP APIs documentation',
      'tronweb': 'TronWeb JavaScript library usage',
      'wallet': 'Wallet integration guide',
      'dapp': 'DApp development guide',
      'tvm': 'TRON Virtual Machine documentation',
      'consensus': 'DPoS consensus mechanism',
      'nodes': 'Running TRON nodes guide',
      'tools': 'Development tools and utilities',
    };
  }

  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create cache directory:', error);
    }
  }

  async getJavaTronReleases(limit: number = 10): Promise<any> {
    try {
      const cacheFile = path.join(this.cacheDir, 'java-tron-releases.json');

      try {
        const stats = await fs.stat(cacheFile);
        const age = Date.now() - stats.mtimeMs;
        if (age < 3600000) {
          const cached = await fs.readFile(cacheFile, 'utf8');
          return JSON.parse(cached);
        }
      } catch {
        // Cache miss
      }

      const response = await axios.get(this.sources.javaTronReleases!, {
        params: { per_page: limit },
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MCP-TRON-Server',
        },
      });

      const releases = response.data.map((release: any) => ({
        version: release.tag_name,
        name: release.name,
        publishedAt: release.published_at,
        url: release.html_url,
        downloadUrl: release.assets.find((asset: any) =>
          asset.name.includes('FullNode.jar')
        )?.browser_download_url,
        releaseNotes: release.body,
        isPrerelease: release.prerelease,
        assets: release.assets.map((asset: any) => ({
          name: asset.name,
          size: asset.size,
          downloadUrl: asset.browser_download_url,
        })),
      }));

      await fs.writeFile(cacheFile, JSON.stringify(releases, null, 2));
      return releases;
    } catch (error: any) {
      throw new Error(`Failed to fetch java-tron releases: ${error.message}`);
    }
  }

  async searchDocumentation(query: string, topic: string | null = null): Promise<any> {
    try {
      const results: any = {
        query,
        topic,
        suggestions: [],
        resources: [],
        examples: [],
      };

      if (topic && this.docTopics[topic]) {
        results.topicDescription = this.docTopics[topic];
      }

      const queryLower = query.toLowerCase();

      if (queryLower.includes('smart contract') || queryLower.includes('contract')) {
        results.resources.push({
          title: 'Smart Contract Development',
          url: 'https://developers.tron.network/docs/smart-contract-development',
          description: 'Complete guide to developing smart contracts on TRON',
        });
        results.examples.push({
          title: 'TRC20 Token Contract',
          code: `pragma solidity ^0.5.0;\n\ncontract TRC20Token {\n    mapping(address => uint256) private _balances;\n    mapping(address => mapping(address => uint256)) private _allowances;\n    \n    uint256 private _totalSupply;\n    string public name;\n    string public symbol;\n    uint8 public decimals;\n    \n    event Transfer(address indexed from, address indexed to, uint256 value);\n    event Approval(address indexed owner, address indexed spender, uint256 value);\n    \n    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _supply) public {\n        name = _name;\n        symbol = _symbol;\n        decimals = _decimals;\n        _totalSupply = _supply * 10**uint256(_decimals);\n        _balances[msg.sender] = _totalSupply;\n    }\n}`,
        });
      }

      if (queryLower.includes('energy') || queryLower.includes('bandwidth')) {
        results.resources.push({
          title: 'Resource Model',
          url: 'https://developers.tron.network/docs/resource-model',
          description: 'Understanding TRON energy and bandwidth system',
        });
        results.suggestions.push('Use freezeBalance to obtain energy for contract execution');
        results.suggestions.push('1 TRX = 1 bandwidth when frozen');
      }

      if (queryLower.includes('tronweb') || queryLower.includes('javascript')) {
        results.resources.push({
          title: 'TronWeb Documentation',
          url: 'https://developers.tron.network/docs/tronweb-object',
          description: 'JavaScript library for TRON blockchain interaction',
        });
        results.examples.push({
          title: 'Initialize TronWeb',
          code: `const TronWeb = require('tronweb');\n\nconst tronWeb = new TronWeb({\n    fullHost: 'https://api.trongrid.io',\n    headers: { "TRON-PRO-API-KEY": 'your-api-key' },\n    privateKey: 'your-private-key'\n});`,
        });
      }

      if (queryLower.includes('node') || queryLower.includes('full node')) {
        results.resources.push({
          title: 'Deploy TRON Nodes',
          url: 'https://developers.tron.network/docs/deploy-tron-nodes',
          description: 'Guide to deploying FullNode and SolidityNode',
        });
        results.suggestions.push('Minimum requirements: 8 CPU, 16GB RAM, 500GB SSD');
        results.suggestions.push('Use official Docker images for easier deployment');
      }

      if (queryLower.includes('api') || queryLower.includes('http')) {
        results.resources.push({
          title: 'HTTP API Documentation',
          url: 'https://developers.tron.network/reference/background',
          description: 'Complete HTTP API reference for TRON',
        });
      }

      if (queryLower.includes('trc20') || queryLower.includes('token')) {
        results.resources.push({
          title: 'TRC20 Token Standard',
          url: 'https://developers.tron.network/docs/trc20',
          description: 'TRC20 token standard documentation',
        });
      }

      if (queryLower.includes('staking') || queryLower.includes('freeze') || queryLower.includes('stake')) {
        results.resources.push({
          title: 'Staking & Resource Delegation',
          url: 'https://developers.tron.network/docs/staking',
          description: 'Guide to staking TRX and resource delegation',
        });
      }

      if (queryLower.includes('dapp') || queryLower.includes('application')) {
        results.resources.push({
          title: 'DApp Development',
          url: 'https://developers.tron.network/docs/dapp-development',
          description: 'Build decentralized applications on TRON',
        });
      }

      return results;
    } catch (error: any) {
      throw new Error(`Documentation search failed: ${error.message}`);
    }
  }

  async getQuickReference(topic: string): Promise<any> {
    const references: Record<string, any> = {
      addresses: {
        topic: 'TRON Addresses',
        details: {
          format: 'Base58Check encoding, starting with T',
          length: '34 characters',
          hex_length: '42 characters (including 41 prefix)',
          example: 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW',
          note: 'TRON addresses are derived from Ethereum addresses with a different prefix (0x41 instead of 0x)',
        },
      },
      units: {
        topic: 'TRON Units',
        details: {
          TRX: '1 TRX = 1,000,000 SUN',
          SUN: 'Smallest unit (like Wei in Ethereum)',
          conversion: '1 SUN = 0.000001 TRX',
          energy: 'Used for smart contract execution',
          bandwidth: 'Used for transactions (1 transaction ≈ 200-300 bandwidth)',
        },
      },
      fees: {
        topic: 'TRON Transaction Fees',
        details: {
          bandwidth_free: '600 bandwidth points per day for free',
          bandwidth_cost: '1000 SUN per bandwidth point (when insufficient)',
          energy_price: '210 SUN per energy unit',
          create_account: '1 TRX (1,000,000 SUN)',
          trc20_transfer: '~13,940 energy (existing address) or ~31,990 energy (new address)',
          note: 'Staking TRX provides energy and bandwidth',
        },
      },
      limits: {
        topic: 'TRON Network Limits',
        details: {
          max_transaction_size: '500KB',
          block_size: '2MB',
          block_time: '3 seconds',
          daily_bandwidth: '600 free bandwidth points',
          max_frozen_duration: '3 days minimum',
          witness_count: '27 Super Representatives',
          fee_limit_max: '15000 TRX (15,000,000,000 SUN)',
          note: 'Limits may change through governance proposals',
        },
      },
    };

    return references[topic] || {
      error: `Unknown topic: ${topic}`,
      availableTopics: Object.keys(references),
    };
  }

  async getJavaTronReadme(): Promise<any> {
    try {
      const cacheFile = path.join(this.cacheDir, 'java-tron-readme.json');

      try {
        const stats = await fs.stat(cacheFile);
        const age = Date.now() - stats.mtimeMs;
        if (age < 86400000) { // 24 hours
          const cached = await fs.readFile(cacheFile, 'utf8');
          return JSON.parse(cached);
        }
      } catch {
        // Cache miss
      }

      const response = await axios.get(
        `${this.sources.javaTronRaw}/master/README.md`,
        { timeout: 10000 }
      );

      const result = { content: response.data, timestamp: Date.now() };
      await fs.writeFile(cacheFile, JSON.stringify(result, null, 2));
      return result;
    } catch (error: any) {
      throw new Error(`Failed to fetch java-tron README: ${error.message}`);
    }
  }

  async getJavaTronFileContent(filePath: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.sources.javaTronContents}/${filePath}`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCP-TRON-Server',
          },
          timeout: 10000,
        }
      );

      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      return {
        path: filePath,
        name: response.data.name,
        size: response.data.size,
        content,
        sha: response.data.sha,
      };
    } catch (error: any) {
      throw new Error(`Failed to fetch file content: ${error.message}`);
    }
  }

  async searchJavaTronRepo(query: string, options: { type?: string; limit?: number } = {}): Promise<any> {
    try {
      const { type = 'code', limit = 20 } = options;

      const response = await axios.get(`https://api.github.com/search/${type}`, {
        params: {
          q: `${query} repo:tronprotocol/java-tron`,
          per_page: limit,
        },
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MCP-TRON-Server',
        },
        timeout: 10000,
      });

      return {
        totalCount: response.data.total_count,
        items: response.data.items.map((item: any) => ({
          name: item.name || item.title,
          path: item.path || item.html_url,
          url: item.html_url,
          score: item.score,
        })),
      };
    } catch (error: any) {
      throw new Error(`Failed to search java-tron: ${error.message}`);
    }
  }

  async getJavaTronStructure(): Promise<any> {
    try {
      const cacheFile = path.join(this.cacheDir, 'java-tron-structure.json');

      try {
        const stats = await fs.stat(cacheFile);
        const age = Date.now() - stats.mtimeMs;
        if (age < 86400000) {
          const cached = await fs.readFile(cacheFile, 'utf8');
          return JSON.parse(cached);
        }
      } catch {
        // Cache miss
      }

      const response = await axios.get(this.sources.javaTronContents!, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MCP-TRON-Server',
        },
        timeout: 10000,
      });

      const structure = response.data.map((item: any) => ({
        name: item.name,
        type: item.type,
        path: item.path,
        size: item.size,
      }));

      await fs.writeFile(cacheFile, JSON.stringify(structure, null, 2));
      return structure;
    } catch (error: any) {
      throw new Error(`Failed to get java-tron structure: ${error.message}`);
    }
  }

  async getProtocolBuffers(): Promise<any> {
    try {
      const cacheFile = path.join(this.cacheDir, 'java-tron-protos.json');

      try {
        const stats = await fs.stat(cacheFile);
        const age = Date.now() - stats.mtimeMs;
        if (age < 86400000) {
          const cached = await fs.readFile(cacheFile, 'utf8');
          return JSON.parse(cached);
        }
      } catch {
        // Cache miss
      }

      const response = await axios.get(
        `${this.sources.javaTronContents}/protocol/src/main/protos`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCP-TRON-Server',
          },
          timeout: 10000,
        }
      );

      const protos = response.data.map((item: any) => ({
        name: item.name,
        path: item.path,
        size: item.size,
        url: item.html_url,
      }));

      await fs.writeFile(cacheFile, JSON.stringify(protos, null, 2));
      return protos;
    } catch (error: any) {
      throw new Error(`Failed to get Protocol Buffers: ${error.message}`);
    }
  }

  async getJavaTronIssues(state: string = 'open', limit: number = 20): Promise<any> {
    try {
      const response = await axios.get(
        `${this.sources.javaTronRepo}/issues`,
        {
          params: {
            state,
            per_page: limit,
            sort: 'updated',
            direction: 'desc',
          },
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCP-TRON-Server',
          },
          timeout: 10000,
        }
      );

      return response.data.map((issue: any) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        labels: issue.labels.map((l: any) => l.name),
        author: issue.user?.login,
      }));
    } catch (error: any) {
      throw new Error(`Failed to get java-tron issues: ${error.message}`);
    }
  }
}
