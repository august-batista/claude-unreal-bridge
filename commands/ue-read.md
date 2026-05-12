---
description: Read and explain a specific UE blueprint
allowed-tools: ["mcp__claude-unreal__read-blueprint", "mcp__claude-unreal__list-blueprints"]
---

Read and explain the Unreal Engine blueprint specified.

Arguments: $ARGUMENTS

The argument can be an asset path (like /Game/Blueprints/BP_Player), a file path
to a .uasset file, or a blueprint name. If you need to find the project path,
look for a .uproject file in the current directory or parent directories.

Steps:
1. Determine the project path and blueprint asset path from the arguments
2. Use `read-blueprint` with detail level "full" to extract the blueprint data
3. Explain what the blueprint does in clear language:
   - What class it extends and why
   - What variables it declares (their purpose)
   - What functions and events it implements
   - The logic flow of each event graph, translated to pseudocode
   - What components it has
4. Note any potential issues or patterns
