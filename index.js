#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the PowerShell script
const SCRIPT_PATH = join(__dirname, '..', 'Report data', 'Get-TempoData.ps1');

class TempoMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'tempo-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_tempo_data',
          description: 'Fetches Tempo Planner plans and/or worklogs for specified teams and people within a date range. Returns CSV data for analysis.',
          inputSchema: {
            type: 'object',
            properties: {
              from: {
                type: 'string',
                description: 'Start date in yyyy-MM-dd format (e.g., 2026-10-01)',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              to: {
                type: 'string',
                description: 'End date in yyyy-MM-dd format (e.g., 2026-12-31)',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              team_ids: {
                type: 'array',
                description: 'Array of Tempo team IDs (numbers). Members of these teams will be included.',
                items: { type: 'number' },
                default: []
              },
              account_ids: {
                type: 'array',
                description: 'Array of Atlassian account IDs (strings) for individual people not on the specified teams.',
                items: { type: 'string' },
                default: []
              },
              data_type: {
                type: 'string',
                description: 'Type of data to fetch: Plans, Worklogs, or Both',
                enum: ['Plans', 'Worklogs', 'Both'],
                default: 'Both'
              }
            },
            required: ['from', 'to']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'get_tempo_data') {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      try {
        return await this.handleGetTempoData(request.params.arguments);
      } catch (error) {
        console.error('[get_tempo_data] Error:', error.message);
        console.error('[get_tempo_data] Stack:', error.stack);
        throw error;
      }
    });
  }

  async handleGetTempoData(args) {
    const { from, to, team_ids = [], account_ids = [], data_type = 'Both' } = args;

    // Log parameters for debugging
    console.error('[get_tempo_data] Called with:', JSON.stringify({ from, to, team_ids, account_ids, data_type }));

    // Validate required parameters
    if (!from || !to) {
      throw new Error('from and to dates are required');
    }

    if (team_ids.length === 0 && account_ids.length === 0) {
      throw new Error('At least one team_id or account_id must be provided');
    }

    // Check if TEMPO_API_TOKEN is set
    if (!process.env.TEMPO_API_TOKEN) {
      throw new Error('TEMPO_API_TOKEN environment variable is not set. Please configure it in your MCP settings.');
    }

    // Build PowerShell command with -PassThru to return data via stdout
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      '-From', from,
      '-To', to,
      '-Data', data_type,
      '-PassThru'
    ];

    if (team_ids.length > 0) {
      psArgs.push('-TeamIds', team_ids.join(','));
    }

    if (account_ids.length > 0) {
      // Pass each account ID as a separate argument for PowerShell array parameter
      psArgs.push('-AccountIds');
      account_ids.forEach(id => psArgs.push(id));
    }

    // Execute PowerShell script
    const result = await this.executePowerShell(psArgs);

    if (!result.success) {
      throw new Error(`Failed to fetch Tempo data: ${result.error}`);
    }

    // Parse CSV data from stdout
    const csvData = this.parseCSVFromOutput(result.output);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully fetched Tempo data for period ${from} to ${to}.\n\n${csvData}`
        }
      ]
    };
  }

  async executePowerShell(args) {
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', args, {
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ success: false, error: stderr || stdout });
        }
      });

      ps.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  parseCSVFromOutput(output) {
    // Extract CSV sections from PowerShell stdout
    // Format: === BEGIN filename.csv ===\n...csv data...\n=== END filename.csv ===
    const sections = [];
    const regex = /=== BEGIN (.+?) ===\r?\n([\s\S]*?)\r?\n=== END \1 ===/g;

    let match;
    while ((match = regex.exec(output)) !== null) {
      const filename = match[1];
      const csvData = match[2];

      // Extract data type from filename (tempo-plans_* or tempo-worklogs_*)
      let dataType = 'Data';
      if (filename.includes('plans')) {
        dataType = 'Plans';
      } else if (filename.includes('worklogs')) {
        dataType = 'Worklogs';
      }

      sections.push(`\n\n=== ${dataType} ===\n\n${csvData}`);
    }

    return sections.length > 0 ? sections.join('') : 'No data returned.';
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Tempo MCP server running on stdio');
  }
}

const server = new TempoMCPServer();
server.run().catch(console.error);
