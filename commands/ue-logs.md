---
description: Read and filter the UE editor/runtime log
allowed-tools: ["mcp__plugin_claude-unreal_claude-unreal__read-logs"]
---

Read the UE log file written under `<Project>/Saved/Logs/`.

Arguments: $ARGUMENTS

Argument format: `<project-path> [filter-pattern]`. The filter pattern is an optional regex applied to message bodies.

Steps:
1. Resolve the project path.
2. Decide which run to inspect — default is `runIndex: 0` (most recent). Use `listAvailable: true` first if the user asks "what runs are there".
3. Default `minSeverity` to `warning`. Lower it (`display`) when the user wants normal log lines, or `verbose` for everything.
4. Default categories to all (omit the parameter). Restrict to specific ones (e.g. `LogBlueprint`, `LogTemp`, `LogPython`) when the user is hunting for a specific kind of message.
5. Report the matched entries verbatim — log lines are evidence, don't paraphrase. Note the file path and timestamp the log came from.
