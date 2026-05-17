---
description: Build the project's C++ target then compile all blueprints
allowed-tools: ["mcp__plugin_claude-unreal_claude-unreal__build-cpp", "mcp__plugin_claude-unreal_claude-unreal__compile-blueprints"]
---

Build the Unreal Engine project end-to-end: C++ first, then blueprints.

The project path is: $ARGUMENTS

If no path is provided, look for a .uproject file in the current working directory.

Steps:
1. Use `build-cpp` with the project path. This is a no-op for Blueprint-only projects.
   - On failure, stop and report the C++ errors with file:line — blueprints cannot compile until the editor module is buildable.
2. If the C++ build succeeded, use `compile-blueprints` to compile every project blueprint.
3. Report the combined result clearly:
   - C++ build status (success / failed / skipped) with duration
   - Blueprint compile status (success / failed) with totals if available
   - For any errors, group by stage and surface the most actionable detail (file:line for C++, asset path for blueprints)
4. If everything compiled, confirm with the per-stage summaries. If not, recommend the next debugging step (often `read-logs` for context that didn't make it into the parsed errors).
