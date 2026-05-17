# claude-unreal Plugin

This is a Claude Code plugin for reading, building, testing, and observing
Unreal Engine projects. It runs Python scripts and editor commandlets
inside the UE editor headlessly via MCP tools.

## How it works

The plugin has two halves:

- **Read/inspect tools** extract Blueprint and asset data as JSON via Python
  scripts run inside the editor (`-run=pythonscript`). Claude reads the
  JSON as structured text and reasons about it.
- **Build/test/observe tools** drive the editor via commandlets
  (`CompileAllBlueprints`), exec commands (`Automation RunTests`), and
  UnrealBuildTool, then parse the structured outputs (compile messages,
  JSON test reports, log files) into actionable summaries.

## MCP Tools

### Read / inspect
- `list-blueprints` — Inventory all blueprints in a UE project
- `read-blueprint` — Read a specific blueprint's variables, functions, event graph
- `search-blueprints` — Search across all blueprints for functions, variables, node types
- `list-class-properties` — List properties on a UClass
- `read-asset` — Read general asset metadata
- `generate-context` — Generate UNREAL_CONTEXT.md overview of the project

### Mutate
- `set-blueprint-property` — Set a single property on a blueprint asset
- `set-blueprint-properties` — Batch set properties on a blueprint asset

### Build / compile
- `build-cpp` — UnrealBuildTool wrapper for the editor target. No-op for BP-only projects. Returns clang/MSVC errors with file:line.
- `compile-blueprints` — `CompileAllBlueprints` commandlet. Parser anchored on `LogBlueprint`/`LogK2Compiler` to suppress unrelated startup noise.

### Run / test / observe
- `run-tests` — Drives `Automation RunTests <Filter>` headlessly and parses the JSON report UE writes to `-ReportExportPath`. Pass/fail per test with error events.
- `run-scenario` — Boots a map (default `-game` mode), runs `-ExecCmds`, captures filtered logs from the run.
- `read-logs` — Reads `<Project>/Saved/Logs/<Project>.log` (current or previous runs); filters by category, severity, regex.

## Slash commands

- `/ue-scan <project-path>` — Scan a UE project and generate inventory
- `/ue-read <blueprint-path>` — Read and explain a specific blueprint
- `/ue-build <project-path>` — Build C++ then compile blueprints (full project build)
- `/ue-compile <project-path>` — Compile blueprints only
- `/ue-test <project-path> [filter]` — Run automation tests
- `/ue-scenario <project-path> <map> [...exec-cmds]` — Boot a map and capture logs
- `/ue-logs <project-path> [pattern]` — Read filtered log output

## Skills

- `blueprint-reader` — Static blueprint inspection
- `blueprint-compiler` — Build & compile workflows (C++ + Blueprints)
- `gameplay-tester` — Automation tests, scenario runs, log analysis
- `context-generator` — Project overview / documentation

## Agents

- `blueprint-architect` — Cross-blueprint analysis and architectural review
- `feature-verifier` — Runs the full build → compile → tests → scenario → log-triage pipeline against a feature change and produces a structured pass/fail report. Invoke after an implementation attempt to validate end-to-end.

## Sandbox project

`sandbox-project/` is a minimal Blueprints+C++ UE project used to verify
the tools end-to-end. Generated folders (`Binaries/`, `Intermediate/`,
`Saved/`, `Build/`, `DerivedDataCache/`) are gitignored. The
`Source/Sandbox/Tests/SandboxSanityTest.cpp` file holds two fixture
automation tests (one always passes, one always fails) used to verify
both code paths in the test report parser.

## Requirements

- Unreal Engine 5.5+ installed (5.7 confirmed in the dev environment)
- A valid UE project with a .uproject file
- For C++ tools: matching toolchain (Xcode on macOS, MSVC on Windows, clang on Linux)

## Development

```bash
cd mcp-server
npm install
npm run build
```

Test with: `claude --plugin-dir /path/to/claude-unreal`
