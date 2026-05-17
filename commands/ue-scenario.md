---
description: Boot a UE map headlessly, run console commands, capture logs
allowed-tools: ["mcp__plugin_claude-unreal_claude-unreal__run-scenario", "mcp__plugin_claude-unreal_claude-unreal__read-logs"]
---

Run a gameplay scenario: open a map, drive it with console commands, and inspect what was logged.

Arguments: $ARGUMENTS

Argument format: `<project-path> <map-path> [exec-cmd-1] [exec-cmd-2] ...`. The map path is an asset path (`/Game/Maps/MyMap`) or short name. Each subsequent argument is one console command, in order.

Steps:
1. Resolve the project path and map.
2. Use `run-scenario` with `mode: "game"` (default) so gameplay logic actually runs.
   - Always include `Quit` as the final exec command unless the scenario is expected to end on its own. The default `timeoutMs` (5 min) is the safety net.
3. Filter the captured log output to relevant categories — `LogBlueprint` and `LogTemp` cover most user-authored gameplay logging. Add `LogPython`, `LogScript`, or game-specific categories as needed.
4. Report:
   - Run status (OK / failed / timed out), duration, exit code
   - Console commands sent
   - Filtered log entries from this run
5. If the run failed without producing logs, follow up with `read-logs` (`runIndex: 0`) for full context.
