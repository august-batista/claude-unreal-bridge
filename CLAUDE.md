# claude-unreal Plugin

This is a Claude Code plugin for reading and working with Unreal Engine blueprint code.

## How it works

The plugin provides MCP tools that run Python scripts inside the UE editor headlessly to extract blueprint data as JSON. Claude can then read and reason about blueprint logic as structured text.

## MCP Tools

- `list-blueprints` — Inventory all blueprints in a UE project
- `read-blueprint` — Read a specific blueprint's variables, functions, and event graph logic
- `search-blueprints` — Search across all blueprints for functions, variables, or node types
- `compile-blueprints` — Run the CompileAllBlueprints commandlet and report errors
- `generate-context` — Generate an UNREAL_CONTEXT.md overview of the project
- `read-asset` — Read general asset metadata

## Commands

- `/ue-scan <project-path>` — Scan a UE project and generate inventory
- `/ue-read <blueprint-path>` — Read and explain a specific blueprint
- `/ue-compile <project-path>` — Compile blueprints and check for errors

## Requirements

- Unreal Engine 5.5+ installed
- A valid UE project with a .uproject file

## Development

```bash
cd mcp-server
npm install
npm run build
```

Test with: `claude --plugin-dir /path/to/claude-unreal`
