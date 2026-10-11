# Tempo MCP Server

MCP server that wraps the Get-TempoData.ps1 script to fetch Tempo Planner data directly from Claude Desktop.

## Installation

1. Install dependencies:
```bash
cd tempo-mcp-server
npm install
```

## Configuration

Add this server to your Claude Desktop configuration file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tempo": {
      "command": "node",
      "args": [
        "C:\\Users\\ChristopherJuhl(CHJU\\OneDrive - NNITGroup (Corporate)\\claude\\tempo-mcp-server\\index.js"
      ],
      "env": {
        "TEMPO_API_TOKEN": "your-tempo-api-token-here"
      }
    }
  }
}
```

**Important:** Replace `your-tempo-api-token-here` with your actual Tempo API token.

## Usage in Claude Desktop

Once configured, you can ask Claude Desktop to fetch Tempo data:

**Example prompts:**

> "Get Tempo planner data from 2026-10-01 to 2026-12-31 for teams 12 and 15"

> "Fetch both plans and worklogs for team 23 and account 712020:abc123 from October to December 2026"

> "Get worklog data for teams 12, 15, 23 and individuals 712020:abc123, 712020:def456 for Q4 2026, then create a roadmap report"

Claude will automatically:
1. Call the `get_tempo_data` tool with your parameters
2. Run the PowerShell script
3. Return the CSV data for analysis
4. Use it with other tools (like Rovo MCP) to create reports

## Tool Parameters

- `from` (required): Start date in yyyy-MM-dd format
- `to` (required): End date in yyyy-MM-dd format  
- `team_ids` (optional): Array of Tempo team IDs (numbers)
- `account_ids` (optional): Array of Atlassian account IDs (strings)
- `data_type` (optional): "Plans", "Worklogs", or "Both" (default: "Both")

## Troubleshooting

If you get "TEMPO_API_TOKEN not set" errors:
- Make sure you added the token to the `env` section in claude_desktop_config.json
- Restart Claude Desktop after updating the config

If the script fails to run:
- Verify the path to Get-TempoData.ps1 is correct
- Ensure PowerShell execution policy allows the script to run
- Check that your Tempo API token has the required scopes (Plans: View, Worklogs: View, Teams: View)
