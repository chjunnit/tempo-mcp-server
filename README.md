# Tempo MCP Server

MCP server for burn-up tracking with Tempo and Jira. Fetches Tempo plans/worklogs and Jira changelog history.

## Features

### 🎯 Four MCP Tools:
1. **`get_tempo_data`** - Tempo plans and worklogs for teams/individuals
2. **`get_jira_changelogs`** - Field change history (Story Points, status, resolution, Fix Version, parent)
3. **`get_worklog_summary`** - Aggregated worklogs by ISO week and epic
4. **`copy_tempo_plans`** - Copy Tempo Planner allocations from one person to others

### 📁 Repository Structure
```
tempo-mcp-server/
├── index.js                  # MCP server (Node.js)
├── scripts/
│   ├── Get-TempoData.ps1    # Tempo API wrapper
│   └── Get-JiraData.ps1     # Jira changelog & worklog aggregation
├── package.json
└── README.md
```

## Installation

```bash
cd tempo-mcp-server
npm install
```

## Configuration

Add to Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tempo-planner": {
      "command": "node",
      "args": ["C:\\path\\to\\tempo-mcp-server\\index.js"],
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
Fetches Tempo plans and/or worklogs.

**Parameters:**
- `from`, `to` (required): yyyy-MM-dd dates
- `team_ids`: Array of Tempo team IDs
- `account_ids`: Array of Atlassian account IDs
- `data_type`: "Plans", "Worklogs", or "Both"

**Example:**
> "Get Tempo data from 2026-10-01 to 2026-12-31 for team 3"

### 2. get_jira_changelogs
Fetches field change history for burn-up tracking.

**Parameters:**
- `jql` OR `issue_keys`: JQL query or specific issue keys
- `fields`: Fields to track (default: Story Points, status, resolution, Fix Version, parent)
- `since`: Optional date filter (yyyy-MM-dd)
- `include_current`: Include current values (default: true)

**Returns:** Two CSV blocks:
- `changes`: issueKey, changedAt, field, from, to
- `current`: issueKey, issueType, status, storyPoints, fixVersions, parentKey, etc.

**Example:**
> "Get changelog for parent = JOBS-20161 since 2026-10-01"

### 3. get_worklog_summary
Aggregates Tempo worklogs by ISO week and epic.

**Parameters:**
- `jql` (required): JQL query for issues
- `from`, `to` (required): yyyy-MM-dd dates
- `group_by`: Dimensions (default: ["week", "epic"])

**Returns:** CSV with weekly summaries + control sum

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

✅ **Bulk operations** - Efficient Jira bulk changelog endpoint  
✅ **Rate limiting** - Automatic retry with Retry-After  
✅ **Large responses** - Files >200KB written to `tempo-exports/`  
✅ **Error handling** - Clear error messages (not "invalid response")  
✅ **Incremental updates** - Use `since` parameter for changelog  

## Troubleshooting

**"TEMPO_API_TOKEN not set"** → Add token to config, restart Claude Desktop

**"JIRA_API_TOKEN not set"** → Add Jira credentials to config

**Scripts fail to run** → Check PowerShell execution policy: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

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
# Test PowerShell scripts directly
.\scripts\Get-TempoData.ps1 -From 2026-10-01 -To 2026-10-31 -TeamIds 3 -Data Both -PassThru

.\scripts\Get-JiraData.ps1 -Action GetChangelogs -IssueKeys JOBS-22480

.\scripts\Get-JiraData.ps1 -Action GetWorklogSummary -JQL "parent = JOBS-20161" -From 2026-08-01 -To 2026-10-11

.\scripts\Copy-TempoPlans.ps1 -Action Preview -SourceAccountId "AXLD" -TargetAccountIds "ABCD,WXYZ" -From 2027-01-01 -To 2027-03-31 -ConflictMode Add
```
