# Tempo MCP Server

TypeScript MCP server for burn-up tracking with Tempo and Jira. Fetches Tempo plans/worklogs and Jira changelog history.

**✨ Full TypeScript Migration Complete!** - All tools migrated from PowerShell to TypeScript for better reliability, type safety, and performance.

## Features

### 🎯 Four MCP Tools:
1. **`get_tempo_data`** - Tempo plans and worklogs for teams/individuals
2. **`get_jira_changelogs`** - Field change history (Story Points, status, resolution, Fix Version, parent)
3. **`get_worklog_summary`** - Aggregated worklogs by ISO week and epic
4. **`copy_tempo_plans`** - Copy Tempo Planner allocations from one person to others

### 📁 Repository Structure
```
tempo-mcp-server/
├── src/
│   ├── index.ts                          # MCP server entry point
│   ├── tempo-api.ts                      # Tempo REST API client
│   ├── jira-api.ts                       # Jira REST API client
│   └── tools/
│       ├── copy-plans.ts                 # Copy Tempo plans service
│       ├── get-tempo-data.ts             # Tempo data fetching service
│       ├── get-jira-changelogs.ts        # Jira changelog service
│       └── get-worklog-summary.ts        # Worklog aggregation service
├── dist/                                  # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## Installation

```bash
cd tempo-mcp-server
npm install
npm run build  # Compile TypeScript to JavaScript
```

**Development:**
```bash
npm run watch  # Auto-compile on file changes
npm run dev    # Build and run
```

## Configuration

Add to Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tempo-planner": {
      "command": "node",
      "args": ["C:\\path\\to\\tempo-mcp-server\\dist\\index.js"],
      "env": {
        "TEMPO_API_TOKEN": "your-tempo-token",
        "JIRA_API_TOKEN": "your-jira-token",
        "JIRA_EMAIL": "your-email@company.com",
        "JIRA_BASE_URL": "https://your-org.atlassian.net"
      }
    }
  }
}
```

**Restart Claude Desktop** after configuration changes.

## Tools

### 1. get_tempo_data
Fetches Tempo plans and/or worklogs with enriched data.

**Parameters:**
- `from`, `to` (required): yyyy-MM-dd dates
- `team_ids`: Array of Tempo team IDs
- `account_ids`: Array of Atlassian account IDs
- `data_type`: "Plans", "Worklogs", or "Both"

**Returns:** Structured JSON with enriched fields:
- Plans: `plannedHoursPerDay`, `totalPlannedHours`, `teams`
- Worklogs: `hours`, `billableHours`, `teams`

**Example:**
> "Get Tempo data from 2026-10-01 to 2026-12-31 for team 3"

### 2. get_jira_changelogs
Fetches field change history for burn-up tracking using bulk changelog endpoint.

**Parameters:**
- `jql` OR `issue_keys`: JQL query or specific issue keys
- `fields`: Fields to track (default: Story Points, status, resolution, Fix Version, parent)
- `since`: Optional date filter (yyyy-MM-dd)
- `include_current`: Include current values (default: true)

**Returns:** Structured JSON with:
- `changes`: Array of changelog entries (issueKey, changedAt, field, from, to)
- `currentValues`: Enriched issue data (storyPoints, statusName, fixVersionNames, parentKey)
- `metadata`: Issue count, change count, tracked fields

**Example:**
> "Get changelog for parent = JOBS-20161 since 2026-10-01"

### 3. get_worklog_summary
Aggregates Tempo worklogs by ISO week and epic with control sum.

**Parameters:**
- `jql` (required): JQL query for issues
- `from`, `to` (required): yyyy-MM-dd dates
- `group_by`: Dimensions (default: ["week", "epic"]) - supports: week, epic, issue, author

**Returns:** Structured JSON with:
- `summary`: Array of aggregated entries with ISO week, epic, hours, worklog count
- `controlSum`: Total hours and count for verification
- `metadata`: Issue count, worklog count, grouping dimensions

**Example:**
> "Get worklog summary for parent = JOBS-20161 from Aug to Oct 2026"

### 4. copy_tempo_plans
Copies Tempo Planner allocations from one person to others with preview and conflict handling.

**Parameters:**
- `source_account_id` (required): Account ID to copy from
- `target_team_id`: Optional - Tempo team ID (copies to all members)
- `target_account_ids`: Optional - Array of specific account IDs
- `from`, `to` (required): yyyy-MM-dd dates
- `project_ids`: Optional - Only copy these project IDs
- `conflict_mode`: How to handle existing allocations (Add/Keep/Replace, default: Add)
- `skip_holidays`: Skip vacation/holidays (default: true)
- `max_weekly_hours`: Warn if weekly total exceeds this (default: 40)
- `dry_run`: Preview mode without writing (default: true)

**Conflict modes:**
- **Add**: Sum hours with existing allocations
- **Keep**: Skip if target already has allocation for that project+date
- **Replace**: Overwrite existing (requires manual deletion first)

**Returns:** 
- **Preview (dry_run=true)**: Shows what would be copied with warnings for overbooking
- **Write (dry_run=false)**: Actually writes plans and returns confirmation

**Example:**
> "Preview copying AXLD's Q1 2027 plans for project 123 to team 3"
> 
> "Copy AXLD's plans from Jan to Mar 2027 to accounts ABCD and WXYZ - add mode"

## Features

✅ **Full TypeScript implementation** - All tools now in TypeScript (faster, type-safe, compile-time error checking)  
✅ **Structured JSON output** - Better integration with MCP and easier data processing  
✅ **Enriched data** - Computed fields (hours, teams, ISO weeks) included automatically  
✅ **Bulk operations** - Efficient Jira bulk changelog endpoint  
✅ **Modern API endpoints** - Fixed deprecated endpoints (HTTP 410) → uses /rest/api/3/search/jql  
✅ **Rate limiting** - Automatic retry with Retry-After  
✅ **Error handling** - Clear error messages with proper stack traces  
✅ **Incremental updates** - Use `since` parameter for changelog  

## Why TypeScript?

All tools have been migrated from PowerShell to TypeScript:

- 🚀 **Faster** - No process spawn overhead, direct API calls
- 🛡️ **Type-safe** - Compile-time error checking prevents runtime bugs
- 🔍 **Better errors** - Stack traces and clear error messages
- 🧪 **Testable** - Unit tests possible with Vitest
- 📝 **IntelliSense** - Full IDE support with autocomplete
- 🔧 **Modern APIs** - Uses latest Jira/Tempo endpoints

**Before (PowerShell):** Runtime errors, CSV parsing, deprecated endpoints  
**After (TypeScript):** Compile-time safety, structured JSON, modern APIs

## TypeScript Architecture

### API Clients
- **TempoApi** (`src/tempo-api.ts`) - Plans, worklogs, teams, holidays
- **JiraApi** (`src/jira-api.ts`) - JQL search, bulk changelog, issue data

### Service Layer
- **GetTempoDataService** - Fetches and enriches Tempo data
- **GetJiraChangelogsService** - Fetches changelog history with field mapping
- **GetWorklogSummaryService** - Aggregates worklogs with ISO week calculation
- **CopyPlansService** - Plan copying with conflict handling

### Key Features
- Async/await patterns with proper error handling
- Pagination support (nextPageToken for Jira, metadata.next for Tempo)
- Type-safe interfaces for all API responses
- Computed fields enrichment (hours, teams, ISO weeks)

## Troubleshooting

**"TEMPO_API_TOKEN not set"** → Add token to config, restart Claude Desktop

**"JIRA_API_TOKEN not set"** → Add Jira credentials to config

**HTTP 410 error** → Fixed in v3.0.0 (migrated to /rest/api/3/search/jql)

**No changelog changes returned** → Field mapping is automatic (customfield_10008 → Story Points, etc.)

## API Requirements

**Tempo token scopes:**
- Worklogs: View
- Plans: View & Write (for copy_tempo_plans)
- Teams: View
- Holidays: View (for skip_holidays feature)

**Jira token:** Generate at https://id.atlassian.com/manage-profile/security/api-tokens

## Development

```bash
# Build TypeScript
npm run build

# Watch mode (auto-compile on changes)
npm run watch

# Run server
npm start

# Build and run
npm run dev
```

## Migration History

- **v1.0.0** - Initial PowerShell implementation
- **v2.0.0** - TypeScript migration Phase 1-2 (setup, copy_tempo_plans)
- **v3.0.0** - Complete TypeScript migration:
  - Phase 3: get_tempo_data
  - Phase 4: get_jira_changelogs (fixed HTTP 410)
  - Phase 5: get_worklog_summary
  - Phase 6: Cleanup (removed PowerShell scripts)
