# claude-unreal-bridge

Claude Code plugin that reads, builds, tests, and observes Unreal Engine
projects from the command line. Runs Python scripts and editor commandlets
inside the UE editor headlessly via MCP, hands Claude back JSON/structured
text it can reason about.

Tested against Unreal Engine 5.5+ (5.7 in dev).

## What it provides

### MCP tools

**Read / inspect**
`list-blueprints`, `read-blueprint`, `search-blueprints`,
`list-class-properties`, `read-asset`, `generate-context`

**Mutate**
`set-blueprint-property`, `set-blueprint-properties`

**Build / compile**
`build-cpp` (UnrealBuildTool), `compile-blueprints` (CompileAllBlueprints commandlet)

**Run / test / observe**
`run-tests` (Automation framework), `run-scenario` (headless map run — single
`execCmds` or scripted `steps` with Enhanced Input injection, held buttons,
log-reactive waits), `read-logs` (Saved/Logs/<Project>.log with
category/severity/regex filtering)

Scripted scenarios with `injectAction`/`possess` require the
[ClaudeUnrealBridge editor plugin](https://github.com/august-batista/claude-unreal-bridge-editor)'s
Runtime submodule installed in the project; without it the other step types
still work but input injection fails gracefully with a clear error.

### Slash commands
`/ue-scan`, `/ue-read`, `/ue-build`, `/ue-compile`, `/ue-test`,
`/ue-scenario`, `/ue-logs`

### Skills
`blueprint-reader`, `blueprint-compiler`, `gameplay-tester`,
`context-generator`

### Agents
- `blueprint-architect` — cross-blueprint analysis and architectural review
- `feature-verifier` — runs the full build → compile → tests → scenario → log-triage pipeline after a feature change and reports a structured pass/fail verdict with evidence

## Requirements

- Unreal Engine 5.5+ with a `.uproject` you want to inspect
- Node.js (to build the MCP server)
- For C++ tools: matching toolchain installed (Xcode on macOS, MSVC on
  Windows, clang on Linux)

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

## Sandbox project

`sandbox-project/` is a minimal Blueprints+C++ UE project for verifying
the tools end-to-end. Includes two fixture automation tests
(`Sandbox.Sanity.AlwaysPasses`, `Sandbox.NegativeFixture.AlwaysFails`)
that exercise both code paths in the test report parser. Generated
folders are gitignored.

## Related repos

- **[august-batista/claude-unreal-bridge-editor](https://github.com/august-batista/claude-unreal-bridge-editor)** — the editor-side UE plugin (`ClaudeUnrealBridge.uplugin`). Unlocks `UBlueprint` reflection data that UE's default Python bridge keeps protected, and re-exposes it as a `UBlueprintFunctionLibrary` the Python in this repo can call. Install into a UE project for richer Blueprint reading. This repo works without it via T3D export + parsing; the C++ plugin enables an authoritative reflection path.

Changes often land in pairs across both repos. When extending Blueprint inspection, check whether a matching change is needed on the editor side.
