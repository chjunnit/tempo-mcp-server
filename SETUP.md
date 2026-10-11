# Setup Guide for Tempo MCP Server

## Step 1: Install Node.js

1. Download Node.js LTS from: https://nodejs.org/
2. Run the installer (choose the default options)
3. Restart your terminal/PowerShell after installation
4. Verify installation:
   ```powershell
   node --version
   npm --version
   ```

## Step 2: Install MCP Server Dependencies

Open PowerShell in the tempo-mcp-server directory and run:

```powershell
npm install
```

This will install the required `@modelcontextprotocol/sdk` package.

## Step 3: Get Your Tempo API Token

1. Go to Tempo: Settings > API Integration
2. Create a new token with these scopes:
   - Plans: View
   - Worklogs: View
   - Teams: View
3. Copy the token (you'll need it for the next step)

## Step 4: Configure Claude Desktop

1. Open your Claude Desktop config file:
   - Press `Win + R`
   - Type: `%APPDATA%\Claude`
   - Open (or create) `claude_desktop_config.json`

2. Add the Tempo MCP server configuration:

```json
{
  "mcpServers": {
    "tempo": {
      "command": "node",
      "args": [
        "C:\\Users\\ChristopherJuhl(CHJU\\OneDrive - NNITGroup (Corporate)\\claude\\tempo-mcp-server\\index.js"
      ],
      "env": {
        "TEMPO_API_TOKEN": "YOUR_TEMPO_TOKEN_HERE"
      }
    }
  }
}
```

**If you already have other MCP servers configured** (like Rovo), your config will look like this:

```json
{
  "mcpServers": {
    "rovo": {
      "command": "...",
      "args": [...]
    },
    "tempo": {
      "command": "node",
      "args": [
        "C:\\Users\\ChristopherJuhl(CHJU\\OneDrive - NNITGroup (Corporate)\\claude\\tempo-mcp-server\\index.js"
      ],
      "env": {
        "TEMPO_API_TOKEN": "YOUR_TEMPO_TOKEN_HERE"
      }
    }
  }
}
```

3. Replace `YOUR_TEMPO_TOKEN_HERE` with your actual Tempo API token

## Step 5: Restart Claude Desktop

Close and reopen Claude Desktop completely for the changes to take effect.

## Step 6: Test It!

Open Claude Desktop and try:

> "Get Tempo planner data from 2026-10-01 to 2026-10-31 for team 12"

Claude should call the tool and return your Tempo data!

## Common Issues

### "npm not found"
- Make sure Node.js is installed and restart your terminal

### "TEMPO_API_TOKEN not set"
- Check that you added the token to the `env` section in claude_desktop_config.json
- Restart Claude Desktop after making config changes

### "Failed to fetch Tempo data"
- Verify your token has the correct scopes (Plans: View, Worklogs: View, Teams: View)
- Check that the path to Get-TempoData.ps1 is correct in index.js

### Tool doesn't appear in Claude Desktop
- Make sure you ran `npm install` successfully
- Verify the path in claude_desktop_config.json is correct
- Restart Claude Desktop

## Finding Team IDs and Account IDs

### Team IDs
You can find these in Tempo:
1. Go to Tempo > Teams
2. Click on a team
3. The team ID is in the URL: `https://your-domain.atlassian.net/plugins/servlet/ac/io.tempo.jira/tempo#!/configuration/teams/{TEAM_ID}`

### Account IDs
For Atlassian account IDs:
1. Go to Jira > People
2. Click on a person's profile
3. The account ID is in the URL: `https://your-domain.atlassian.net/jira/people/{ACCOUNT_ID}`

Or you can ask your Rovo MCP for this information!
