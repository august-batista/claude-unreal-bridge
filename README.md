# claude-unreal-bridge

Claude Code plugin that exposes Unreal Engine Blueprint internals as structured text. Runs Python scripts inside the UE editor (headlessly) via MCP tools, hands Claude back JSON, and renders it as markdown the model can reason about.

Tested against Unreal Engine 5.5+.

## What it provides

- **MCP tools**: `list-blueprints`, `read-blueprint`, `search-blueprints`, `compile-blueprints`, `generate-context`, `read-asset`
- **Slash commands**: `/ue-scan`, `/ue-read`, `/ue-compile`
- **Skills**: `blueprint-reader`, `blueprint-compiler`, `context-generator`
- **Agent**: `blueprint-architect`

## Requirements

- Unreal Engine 5.5+ with a `.uproject` you want to inspect
- Node.js (to build the MCP server)

## Install

```bash
git clone https://github.com/august-batista/claude-unreal-bridge ~/Developer/claude-unreal-bridge
cd ~/Developer/claude-unreal-bridge/mcp-server
npm install
npm run build
```

Then load as a Claude Code plugin:

```bash
claude --plugin-dir ~/Developer/claude-unreal-bridge
```

## Related repos

- **[august-batista/claude-unreal-bridge-editor](https://github.com/august-batista/claude-unreal-bridge-editor)** — the editor-side UE plugin (`ClaudeUnrealBridge.uplugin`). Unlocks `UBlueprint` reflection data that UE's default Python bridge keeps protected, and re-exposes it as a `UBlueprintFunctionLibrary` the Python in this repo can call. Install into a UE project for richer Blueprint reading. This repo works without it via T3D export + parsing; the C++ plugin enables an authoritative reflection path.

Changes often land in pairs across both repos. When extending Blueprint inspection, check whether a matching change is needed on the editor side.
