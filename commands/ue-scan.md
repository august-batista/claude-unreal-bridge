---
description: Scan a UE project and generate a blueprint inventory and context file
allowed-tools: ["mcp__claude-unreal__list-blueprints", "mcp__claude-unreal__generate-context", "mcp__claude-unreal__read-asset"]
---

Scan the Unreal Engine project and generate a comprehensive overview.

The project path is: $ARGUMENTS

If no path is provided, look for a .uproject file in the current working directory.

Steps:
1. Use the `list-blueprints` tool to discover all blueprints in the project
2. Use the `generate-context` tool to create an UNREAL_CONTEXT.md file
3. Report a summary of findings: number of blueprints, key classes, project structure
