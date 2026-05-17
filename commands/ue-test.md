---
description: Run UE automation tests and report pass/fail
allowed-tools: ["mcp__plugin_claude-unreal_claude-unreal__run-tests", "mcp__plugin_claude-unreal_claude-unreal__read-logs", "mcp__plugin_claude-unreal_claude-unreal__build-cpp", "mcp__plugin_claude-unreal_claude-unreal__compile-blueprints"]
---

Run the project's automation tests and report results.

Arguments: $ARGUMENTS

Argument format: `<project-path> [test-filter]`. The test filter is a dotted prefix (e.g., `Sandbox.` or `Sandbox.Sanity.AlwaysPasses`). If omitted, runs all tests under the project's namespace.

Steps:
1. Resolve the project path (from arguments, or by finding a .uproject in the current directory).
2. If C++ source exists and might be stale, run `build-cpp` first. New tests landed since the last build won't be discoverable otherwise.
3. Use `run-tests` with the project path and filter.
   - If `mode: "list"` was requested, enumerate available tests instead of running them.
4. Report:
   - Overall pass/fail counts and total duration
   - For each failure: full test path, error events with file:line, warnings
   - First handful of passing tests (the rest is summarised — set `showAllPasses: true` only if explicitly asked)
5. On unexpected failures (no report, editor crash, etc.), call `read-logs` to surface the underlying cause.
