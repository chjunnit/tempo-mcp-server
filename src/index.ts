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
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { TempoApi } from './tempo-api.js';
import { CopyPlansService, CopyPlansArgs, CopyPlansResult } from './tools/copy-plans.js';
import { GetTempoDataService, GetTempoDataArgs, TempoDataResult } from './tools/get-tempo-data.js';
import { JiraApi } from './jira-api.js';
import { GetJiraChangelogsService, GetJiraChangelogsArgs, ChangelogsResult } from './tools/get-jira-changelogs.js';
import { GetWorklogSummaryService, GetWorklogSummaryArgs, WorklogSummaryResult } from './tools/get-worklog-summary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths to PowerShell scripts (legacy - will migrate these to TypeScript)
const TEMPO_SCRIPT_PATH = join(__dirname, '..', 'scripts', 'Get-TempoData.ps1');
const JIRA_SCRIPT_PATH = join(__dirname, '..', 'scripts', 'Get-JiraData.ps1');

// Export settings
const EXPORTS_DIR = join(__dirname, '..', '..', 'tempo-exports');
const MAX_INLINE_SIZE = 200 * 1024; // 200 KB

class TempoMCPServer {
  private server: Server;
  private tempoApi: TempoApi | null = null;
  private copyPlansService: CopyPlansService | null = null;
  private getTempoDataService: GetTempoDataService | null = null;
  private jiraApi: JiraApi | null = null;
  private getJiraChangelogsService: GetJiraChangelogsService | null = null;
  private getWorklogSummaryService: GetWorklogSummaryService | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'tempo-mcp-server',
        version: '2.0.0',
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

  private initTempoApi(): void {
    if (!this.tempoApi) {
      const apiToken = process.env.TEMPO_API_TOKEN;
      if (!apiToken) {
        throw new Error('TEMPO_API_TOKEN environment variable is not set');
      }
      this.tempoApi = new TempoApi({ apiToken });
      this.copyPlansService = new CopyPlansService(this.tempoApi);
      this.getTempoDataService = new GetTempoDataService(this.tempoApi);
    }
  }

  private initJiraApi(): void {
    if (!this.jiraApi) {
      const apiToken = process.env.JIRA_API_TOKEN;
      const email = process.env.JIRA_EMAIL;
      const baseUrl = process.env.JIRA_BASE_URL;

      if (!apiToken || !email) {
        throw new Error('JIRA_API_TOKEN and JIRA_EMAIL environment variables must be set');
      }

      this.jiraApi = new JiraApi({ email, apiToken, baseUrl });
      this.getJiraChangelogsService = new GetJiraChangelogsService(this.jiraApi);
    }
  }

  private initWorklogSummaryService(): void {
    this.initJiraApi();
    this.initTempoApi();

    if (!this.getWorklogSummaryService) {
      this.getWorklogSummaryService = new GetWorklogSummaryService(
        this.jiraApi!,
        this.tempoApi!
      );
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_tempo_data',
          description: 'Fetches Tempo Planner plans and/or worklogs for specified teams and people within a date range. Returns structured JSON data with enriched fields (hours, teams). NOW IN TYPESCRIPT - faster and more reliable!',
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
        },
        {
          name: 'get_jira_changelogs',
          description: 'Fetches field change history for Jira issues using bulk changelog endpoint. Returns structured JSON with change history and current values for burn-up tracking. NOW IN TYPESCRIPT - faster and more reliable!',
          inputSchema: {
            type: 'object',
            properties: {
              jql: {
                type: 'string',
                description: 'JQL query to find issues (e.g., "parent in (JOBS-20161, JOBS-21640)"). Either jql or issue_keys must be provided.'
              },
              issue_keys: {
                type: 'array',
                description: 'Array of issue keys (e.g., ["JOBS-22480", "JOBS-22481"]). Either jql or issue_keys must be provided.',
                items: { type: 'string' }
              },
              fields: {
                type: 'array',
                description: 'Fields to track changes for. Defaults to ["customfield_10008", "status", "resolution", "fixVersions", "parent"].',
                items: { type: 'string' },
                default: ['customfield_10008', 'status', 'resolution', 'fixVersions', 'parent']
              },
              since: {
                type: 'string',
                description: 'Only return changes on or after this date (yyyy-MM-dd format). For incremental updates.',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              include_current: {
                type: 'boolean',
                description: 'Include current field values for each issue. Defaults to true.',
                default: true
              }
            }
          }
        },
        {
          name: 'get_worklog_summary',
          description: 'Aggregates Tempo worklogs by ISO week and epic for burn-up tracking. Returns structured JSON with weekly hour summaries and control sum. NOW IN TYPESCRIPT - faster and more reliable!',
          inputSchema: {
            type: 'object',
            properties: {
              jql: {
                type: 'string',
                description: 'JQL query to find issues (e.g., "parent in (JOBS-20161, JOBS-21640)")',
              },
              from: {
                type: 'string',
                description: 'Start date in yyyy-MM-dd format',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              to: {
                type: 'string',
                description: 'End date in yyyy-MM-dd format',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              group_by: {
                type: 'array',
                description: 'Group results by these dimensions. Defaults to ["week", "epic"].',
                items: {
                  type: 'string',
                  enum: ['week', 'epic', 'issue', 'author']
                },
                default: ['week', 'epic']
              }
            },
            required: ['jql', 'from', 'to']
          }
        },
        {
          name: 'copy_tempo_plans',
          description: 'Copy Tempo Planner allocations from one person to others. Supports dry-run preview and actual write with conflict handling (add/keep/replace existing plans). NOW IN TYPESCRIPT - faster and more reliable!',
          inputSchema: {
            type: 'object',
            properties: {
              source_account_id: {
                type: 'string',
                description: 'Atlassian account ID to copy plans from'
              },
              target_team_id: {
                type: 'string',
                description: 'Optional: Tempo team ID - copies to all team members'
              },
              target_account_ids: {
                type: 'array',
                description: 'Optional: Array of specific account IDs to copy to',
                items: { type: 'string' }
              },
              from: {
                type: 'string',
                description: 'Start date (yyyy-MM-dd)',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              to: {
                type: 'string',
                description: 'End date (yyyy-MM-dd)',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
              },
              project_ids: {
                type: 'array',
                description: 'Optional: Only copy plans for these project IDs',
                items: { type: 'number' }
              },
              project_mapping: {
                type: 'object',
                description: 'Optional: Map source project IDs to target project IDs. Example: {"10805": 10559} maps North Star to JOBS project',
                additionalProperties: { type: 'number' }
              },
              conflict_mode: {
                type: 'string',
                description: 'How to handle existing allocations. Add: sum hours, Keep: skip if exists, Replace: overwrite. Default: Add',
                enum: ['Add', 'Keep', 'Replace'],
                default: 'Add'
              },
              skip_holidays: {
                type: 'boolean',
                description: 'Skip days where target has vacation/holiday. Default: true',
                default: true
              },
              max_weekly_hours: {
                type: 'number',
                description: 'Warn if weekly total exceeds this. Default: 40',
                default: 40
              },
              dry_run: {
                type: 'boolean',
                description: 'If true (default), returns preview without writing. Set false to actually write plans.',
                default: true
              }
            },
            required: ['source_account_id', 'from', 'to']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;

      try {
        switch (toolName) {
          case 'get_tempo_data':
            return await this.handleGetTempoDataTS(request.params.arguments);
          case 'get_jira_changelogs':
            return await this.handleGetJiraChangelogsTS(request.params.arguments);
          case 'get_worklog_summary':
            return await this.handleGetWorklogSummaryTS(request.params.arguments);
          case 'copy_tempo_plans':
            return await this.handleCopyTempoPlansTS(request.params.arguments);
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
      } catch (error) {
        console.error(`[${toolName}] Error:`, error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
          console.error(`[${toolName}] Stack:`, error.stack);
        }

        // Return error as a normal response instead of throwing
        return {
          content: [
            {
              type: 'text',
              text: `ERROR: ${error instanceof Error ? error.message : String(error)}\n\nTool: ${toolName}\n\nThis is an error response, not a tool failure.`
            }
          ],
          isError: true
        };
      }
    });
  }

  // NEW: TypeScript implementation for get_tempo_data
  async handleGetTempoDataTS(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.initTempoApi();

    const typedArgs = args as GetTempoDataArgs;

    console.error('[get_tempo_data] Called with TypeScript implementation:', JSON.stringify({
      from: typedArgs.from,
      to: typedArgs.to,
      team_ids: typedArgs.team_ids || [],
      account_ids: typedArgs.account_ids || [],
      data_type: typedArgs.data_type || 'Both',
    }));

    const result = await this.getTempoDataService!.execute(typedArgs);

    // Format as JSON for better MCP integration
    const jsonOutput = JSON.stringify(result, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `✅ **Tempo Data Retrieved** ✨ *TypeScript Implementation*\n\n**Period:** ${result.from} to ${result.to}\n**Accounts:** ${result.accounts.length}\n\n${
            result.plans ? `**Plans:** ${result.plans.length} entries\n` : ''
          }${
            result.worklogs ? `**Worklogs:** ${result.worklogs.length} entries\n` : ''
          }\n---\n\n<details><summary>JSON Data</summary>\n\n\`\`\`json\n${jsonOutput}\n\`\`\`\n</details>`
        }
      ]
    };
  }

  // NEW: TypeScript implementation for get_jira_changelogs
  async handleGetJiraChangelogsTS(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.initJiraApi();

    const typedArgs = args as GetJiraChangelogsArgs;

    console.error('[get_jira_changelogs] Called with TypeScript implementation:', JSON.stringify({
      jql: typedArgs.jql,
      issue_keys: typedArgs.issue_keys,
      fields: typedArgs.fields || ['customfield_10008', 'status', 'resolution', 'fixVersions', 'parent'],
      since: typedArgs.since,
      include_current: typedArgs.include_current ?? true,
    }));

    const result = await this.getJiraChangelogsService!.execute(typedArgs);

    // Format as JSON for better MCP integration
    const jsonOutput = JSON.stringify(result, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `✅ **Jira Changelogs Retrieved** ✨ *TypeScript Implementation*\n\n**Issues:** ${result.metadata.issueCount}\n**Changes:** ${result.metadata.changeCount}\n**Fields:** ${result.metadata.fields.join(', ')}\n${
            result.metadata.since ? `**Since:** ${result.metadata.since}\n` : ''
          }${
            result.currentValues ? `**Current Values:** ${result.currentValues.length} issues\n` : ''
          }\n---\n\n<details><summary>JSON Data</summary>\n\n\`\`\`json\n${jsonOutput}\n\`\`\`\n</details>`
        }
      ]
    };
  }

  // NEW: TypeScript implementation for get_worklog_summary
  async handleGetWorklogSummaryTS(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.initWorklogSummaryService();

    const typedArgs = args as GetWorklogSummaryArgs;

    console.error('[get_worklog_summary] Called with TypeScript implementation:', JSON.stringify({
      jql: '(jql provided)',
      from: typedArgs.from,
      to: typedArgs.to,
      group_by: typedArgs.group_by || ['week', 'epic'],
    }));

    const result = await this.getWorklogSummaryService!.execute(typedArgs);

    // Format as JSON for better MCP integration
    const jsonOutput = JSON.stringify(result, null, 2);

    return {
      content: [
        {
          type: 'text',
          text: `✅ **Worklog Summary Retrieved** ✨ *TypeScript Implementation*\n\n**Period:** ${result.metadata.from} to ${result.metadata.to}\n**Issues:** ${result.metadata.issueCount}\n**Worklogs:** ${result.metadata.worklogCount}\n**Group by:** ${result.metadata.groupBy.join(', ')}\n\n**Summary entries:** ${result.summary.length}\n**Total hours:** ${result.controlSum.totalHours}\n**Total worklogs:** ${result.controlSum.totalCount}\n\n---\n\n<details><summary>JSON Data</summary>\n\n\`\`\`json\n${jsonOutput}\n\`\`\`\n</details>`
        }
      ]
    };
  }

  // NEW: TypeScript implementation for copy_tempo_plans
  async handleCopyTempoPlansTS(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.initTempoApi();

    const typedArgs = args as CopyPlansArgs;

    console.error('[copy_tempo_plans] Called with TypeScript implementation:', JSON.stringify({
      source_account_id: typedArgs.source_account_id,
      target_team_id: typedArgs.target_team_id || '(none)',
      target_count: typedArgs.target_account_ids?.length || 0,
      from: typedArgs.from,
      to: typedArgs.to,
      project_count: typedArgs.project_ids?.length || 0,
      conflict_mode: typedArgs.conflict_mode || 'Add',
      dry_run: typedArgs.dry_run ?? true
    }));

    // Execute copy operation
    const result = await this.copyPlansService!.execute(typedArgs);

    // Format output
    const text = this.formatCopyPlansResult(result);

    return {
      content: [
        {
          type: 'text',
          text: text
        }
      ]
    };
  }

  private formatCopyPlansResult(result: CopyPlansResult): string {
    const isDryRun = result.action === 'Preview';
    let text = '';

    if (isDryRun) {
      text += `📋 **Preview: Copy Tempo Plans** ✨ *TypeScript Implementation*\n\n`;
      text += `**Source:** ${result.source.accountId} (${result.source.from} to ${result.source.to})\n`;
      text += `**Source Plans:** ${result.source.planCount} plan periods\n\n`;
      text += `**Targets:** ${result.targets.length} people\n`;
      text += `**Mode:** ${result.conflictMode}\n\n`;

      if (result.totalConflicts > 0) {
        text += `⚠️ **${result.totalConflicts} conflicts** (existing allocations)\n`;
      }

      if (result.totalSkippedHolidays > 0) {
        text += `🏖️ **${result.totalSkippedHolidays} days skipped** (holidays/vacation)\n`;
      }

      text += `\n**Total to copy:** ${result.totalHoursCopied} hours (${result.totalEntries} entries)\n\n`;

      // Show per-person summary
      text += `### Per-person breakdown:\n\n`;
      for (const target of result.targets) {
        text += `**${target.accountId}:**\n`;
        text += `  - ${target.entries.length} entries, ${target.totalHours}h total\n`;

        if (target.conflicts > 0) {
          text += `  - ⚠️ ${target.conflicts} conflicts\n`;
        }

        if (target.skippedHolidays > 0) {
          text += `  - 🏖️ ${target.skippedHolidays} days skipped (holidays)\n`;
        }

        if (target.warnings.length > 0) {
          text += `  - ⚠️ Warnings:\n`;
          for (const warning of target.warnings) {
            text += `    - ${warning}\n`;
          }
        }

        text += `\n`;
      }

      if (result.warnings.length > 0) {
        text += `### ⚠️ Warnings:\n`;
        for (const warning of result.warnings) {
          text += `- ${warning}\n`;
        }
        text += `\n`;
      }

      text += `\n*This is a preview. To actually write these plans, call again with \`dry_run: false\`*`;

      // Add debug info if available
      if (result.debug) {
        text += `\n\n---\n### 🔍 Debug Info\n\n`;
        text += `**Source Plans Found:** ${result.debug.sourcePlansRaw.length}\n`;
        text += `**Clipped Plans Count:** ${result.debug.clippedPlansCount}\n\n`;

        text += `**Source Plans Raw Data:**\n`;
        for (const plan of result.debug.sourcePlansRaw) {
          text += `\n- **${plan.name}** (${plan.type} #${plan.id})\n`;
          text += `  - Period: ${plan.startDate} to ${plan.endDate}\n`;
          text += `  - plannedTime: \`${JSON.stringify(plan.plannedTime)}\`\n`;
          text += `  - includesNonWorkingDays: ${plan.includesNonWorkingDays}\n`;
        }

        text += `\n\n**Clipping Log:**\n\`\`\`\n${result.debug.clippingLog.join('\n')}\n\`\`\`\n`;
      }
    } else {
      // Check if write was successful
      const expectedEntries = result.totalEntries;
      const actualWritten = result.writtenCount ?? 0;
      const allSuccess = actualWritten === expectedEntries;

      if (allSuccess) {
        text += `✅ **Successfully wrote Tempo plans** ✨ *TypeScript Implementation*\n\n`;
      } else if (actualWritten > 0) {
        text += `⚠️ **Partially wrote Tempo plans** (${actualWritten}/${expectedEntries} succeeded) ✨ *TypeScript Implementation*\n\n`;
      } else {
        text += `❌ **Failed to write Tempo plans** (0/${expectedEntries} succeeded) ✨ *TypeScript Implementation*\n\n`;
      }

      text += `**Source:** ${result.source.accountId} (${result.source.from} to ${result.source.to})\n`;
      text += `**Targets:** ${result.targets.length} people\n`;
      text += `**Written:** ${actualWritten}/${expectedEntries} plan entries\n`;
      text += `**Total hours:** ${result.totalHoursCopied}h\n\n`;

      if (result.warnings.length > 0) {
        text += `### ⚠️ Errors and Warnings:\n`;
        for (const warning of result.warnings) {
          text += `- ${warning}\n`;
        }
        text += `\n`;
      }
    }

    // Include raw JSON for programmatic access
    text += `\n\n---\n<details><summary>Raw JSON result</summary>\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n</details>`;

    return text;
  }

  // Legacy PowerShell handlers - will migrate these to TypeScript later
  async handleGetTempoData(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const typedArgs = args as any;
    const { from, to, team_ids = [], account_ids = [], data_type = 'Both' } = typedArgs;

    console.error('[get_tempo_data] Called with:', JSON.stringify({ from, to, team_ids, account_ids, data_type }));

    if (!from || !to) {
      throw new Error('from and to dates are required');
    }

    if (team_ids.length === 0 && account_ids.length === 0) {
      throw new Error('At least one team_id or account_id must be provided');
    }

    if (!process.env.TEMPO_API_TOKEN) {
      throw new Error('TEMPO_API_TOKEN environment variable is not set. Please configure it in your MCP settings.');
    }

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', TEMPO_SCRIPT_PATH,
      '-From', from,
      '-To', to,
      '-Data', data_type,
      '-PassThru'
    ];

    if (team_ids.length > 0) {
      psArgs.push('-TeamIds', team_ids.join(','));
    }

    if (account_ids.length > 0) {
      psArgs.push('-AccountIds', account_ids.join(','));
    }

    const result = await this.executePowerShell(psArgs);

    if (!result.success || !result.output) {
      throw new Error(`Failed to fetch Tempo data: ${result.error || 'No output'}`);
    }

    const csvData = this.parseCSVFromOutput(result.output);
    const response = this.handleLargeResponse(csvData, 'get_tempo_data');

    return {
      content: [
        {
          type: 'text',
          text: `Successfully fetched Tempo data for period ${from} to ${to}.\n\n${response}`
        }
      ]
    };
  }

  async handleGetJiraChangelogs(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const typedArgs = args as any;
    const { jql, issue_keys, fields = ['customfield_10008', 'status', 'resolution', 'fixVersions', 'parent'], since, include_current = true } = typedArgs;

    console.error('[get_jira_changelogs] Called with:', JSON.stringify({ jql: jql ? '(jql provided)' : undefined, issue_keys, fields, since, include_current }));

    if (!jql && (!issue_keys || issue_keys.length === 0)) {
      throw new Error('Either jql or issue_keys must be provided');
    }

    if (!process.env.JIRA_API_TOKEN || !process.env.JIRA_EMAIL) {
      throw new Error('JIRA_API_TOKEN and JIRA_EMAIL environment variables must be set. Please configure them in your MCP settings.');
    }

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', JIRA_SCRIPT_PATH,
      '-Action', 'GetChangelogs',
      '-Fields', fields.join(','),
      '-IncludeCurrent', include_current.toString()
    ];

    if (jql) {
      psArgs.push('-JQL', jql);
    } else {
      psArgs.push('-IssueKeys');
      issue_keys.forEach((key: string) => psArgs.push(key));
    }

    if (since) {
      psArgs.push('-Since', since);
    }

    const result = await this.executePowerShell(psArgs);

    if (!result.success || !result.output) {
      throw new Error(`Failed to fetch Jira changelogs: ${result.error || 'No output'}`);
    }

    const csvData = this.parseCSVFromOutput(result.output);
    const response = this.handleLargeResponse(csvData, 'get_jira_changelogs');

    return {
      content: [
        {
          type: 'text',
          text: `Successfully fetched Jira changelogs.\n\n${response}`
        }
      ]
    };
  }

  async handleGetWorklogSummary(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const typedArgs = args as any;
    const { jql, from, to, group_by = ['week', 'epic'] } = typedArgs;

    console.error('[get_worklog_summary] Called with:', JSON.stringify({ jql: '(jql provided)', from, to, group_by }));

    if (!jql) {
      throw new Error('jql parameter is required');
    }
    if (!from || !to) {
      throw new Error('from and to dates are required');
    }

    if (!process.env.TEMPO_API_TOKEN) {
      throw new Error('TEMPO_API_TOKEN environment variable is not set. Please configure it in your MCP settings.');
    }
    if (!process.env.JIRA_API_TOKEN || !process.env.JIRA_EMAIL) {
      throw new Error('JIRA_API_TOKEN and JIRA_EMAIL environment variables must be set. Please configure them in your MCP settings.');
    }

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', JIRA_SCRIPT_PATH,
      '-Action', 'GetWorklogSummary',
      '-JQL', jql,
      '-From', from,
      '-To', to,
      '-GroupBy', group_by.join(',')
    ];

    const result = await this.executePowerShell(psArgs);

    if (!result.success || !result.output) {
      throw new Error(`Failed to fetch worklog summary: ${result.error || 'No output'}`);
    }

    const csvData = this.parseCSVFromOutput(result.output);
    const response = this.handleLargeResponse(csvData, 'get_worklog_summary');

    return {
      content: [
        {
          type: 'text',
          text: `Successfully fetched worklog summary for period ${from} to ${to}.\n\n${response}`
        }
      ]
    };
  }

  async executePowerShell(args: string[]): Promise<{ success: boolean; output?: string; error?: string }> {
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

  handleLargeResponse(csvData: string, toolName: string): string {
    const dataSize = Buffer.byteLength(csvData, 'utf8');

    if (dataSize < MAX_INLINE_SIZE) {
      return csvData;
    }

    if (!existsSync(EXPORTS_DIR)) {
      mkdirSync(EXPORTS_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${toolName}_${timestamp}.csv`;
    const filepath = join(EXPORTS_DIR, filename);

    writeFileSync(filepath, csvData, 'utf8');

    const lineCount = csvData.split('\n').length;

    return `Response written to file due to size (${Math.round(dataSize / 1024)} KB).\n\nFile: ${filepath}\nLines: ${lineCount}`;
  }

  parseCSVFromOutput(output: string): string {
    const sections: string[] = [];
    const regex = /=== BEGIN (.+?) ===\r?\n([\s\S]*?)\r?\n=== END \1 ===/g;

    let match;
    while ((match = regex.exec(output)) !== null) {
      const filename = match[1];
      const csvData = match[2];

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
    console.error('Tempo MCP server running on stdio (TypeScript edition!)');
  }
}

const server = new TempoMCPServer();
server.run().catch(console.error);
