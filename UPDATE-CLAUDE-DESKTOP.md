# 🔧 VIGTIG: Opdater Claude Desktop Config

Din Claude Desktop konfiguration skal opdateres til at bruge den nye TypeScript version!

## Find din config fil:

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

Fuld sti:
```
C:\Users\ChristopherJuhl(CHJU\AppData\Roaming\Claude\claude_desktop_config.json
```

## Opdater "args" linjen:

### ❌ GAMMEL (peger på PowerShell version):
```json
{
  "mcpServers": {
    "tempo-planner": {
      "command": "node",
      "args": ["C:\\Users\\ChristopherJuhl(CHJU\\OneDrive - NNITGroup (Corporate)\\claude\\tempo-mcp-server\\index.js"],
      "env": {
        ...
      }
    }
  }
}
```

### ✅ NY (peger på TypeScript compiled version):
```json
{
  "mcpServers": {
    "tempo-planner": {
      "command": "node",
      "args": ["C:\\Users\\ChristopherJuhl(CHJU\\OneDrive - NNITGroup (Corporate)\\claude\\tempo-mcp-server\\dist\\index.js"],
      "env": {
        ...
      }
    }
  }
}
```

**Vigtigt:** Tilføj `\dist` før `\index.js`!

## Efter ændring:

1. **Gem filen**
2. **Luk Claude Desktop HELT** (ikke bare vinduet)
3. **Start Claude Desktop igen**
4. **Test copy_tempo_plans** - du vil nu se "✨ TypeScript Implementation" i output!

---

## Quick verification:

Kør denne kommando for at se hvad config filen siger:

```powershell
Get-Content "$env:APPDATA\Claude\claude_desktop_config.json" | Select-String "tempo-mcp-server"
```

Du skal se: `...\\tempo-mcp-server\\dist\\index.js"`
