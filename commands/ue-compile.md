---
description: Compile UE blueprints and check for errors
allowed-tools: ["mcp__plugin_claude-unreal_claude-unreal__compile-blueprints"]
---

Compile all blueprints in the Unreal Engine project and report any errors.

The project path is: $ARGUMENTS

If no path is provided, look for a .uproject file in the current working directory.

Steps:
1. Use `compile-blueprints` with the project path
2. Report the results clearly:
   - If successful: confirm all blueprints compiled cleanly
   - If errors: list each error with the blueprint path and description
   - If warnings: list warnings separately
3. For any errors, suggest potential fixes based on the error messages
