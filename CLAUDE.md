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
- `edit-blueprint-graph` — Add / wire / delete **K2 graph nodes** in one editor session, then compile + save. Batch of ordered ops: `addFunctionNode`, `addSelfFunctionNode` (self/parent funcs), `addCustomEvent`, `addVariableGet`, `addVariableSet`, `addBranch`, `addSequence`, `addMacro` (ForLoop/ForEachLoop/WhileLoop/Gate/DoOnce/FlipFlop), `addCast`, `addMemberVariable`, `connect`, `breakPinLink`, `setPinDefault`, `deleteNode`, `moveNode`, `retargetNode` — enough for real logic (variables + branches + loops + casts + math/function calls). **Edits the existing graph in place** (not a rewrite): nodes spawned in the batch are referenced by a local `id`, existing nodes by GUID (from `read-blueprint`), so you can surgically wire/unwire (`connect`/`breakPinLink`), set pin defaults, move, delete, or reconfigure individual nodes (`retargetNode` retargets a function call / cast / variable or renames a custom event). Create a variable with `addMemberVariable` before get/set nodes reference it. Pass `autoLayout: true` to tidy the graph (exec backbone on a pin-aligned rail; data/condition feeders packed into the gap before their consumer; disconnected events parked); `operations` may be empty for a layout-only re-arrange. Returns structured per-op results + node GUIDs + positions. **Requires the `ClaudeUnrealBridge` plugin enabled and its editor target built** in the project (it ships the `UClaudeBPGraphLibrary` C++ wrapping `FGraphNodeCreator` / schema `TryCreateConnection` / `UEdGraph::RemoveNode` / `FKismetEditorUtilities::CompileBlueprint` + `AutoLayoutGraph` — all UE 5.7+, no 5.8 needed). Driver: `python-scripts/edit_blueprint_graph.py`. Regression: `cd mcp-server && npm run test:graph` (gated; needs UE 5.7 + a built `SandboxEditor`, skips otherwise).

### Build / compile
- `build-cpp` — UnrealBuildTool wrapper for the editor target. No-op for BP-only projects. Returns clang/MSVC errors with file:line.
- `compile-blueprints` — `CompileAllBlueprints` commandlet. Parser anchored on `LogBlueprint`/`LogK2Compiler` to suppress unrelated startup noise.

### Run / test / observe
- `run-tests` — Drives `Automation RunTests <Filter>` headlessly and parses the JSON report UE writes to `-ReportExportPath`. Pass/fail per test with error events.
- `run-scenario` — Boots a map (default `-game` mode), then either (a) sends single-shot `-ExecCmds`, or (b) executes a scripted `steps` list (exec, wait, waitForLog, injectAction with hold-per-tick, possess, **playRecording**, quit) that drives the actual Enhanced Input pipeline. The scripted form runs an in-game Python tick handler (`python-scripts/scenario_runner.py`) and needs the `ClaudeUnrealBridge` editor-side plugin's Runtime submodule for `injectAction`/`possess`/`playRecording`. Optional `visible: true` shows the editor window for live debugging; default is offscreen / no focus theft.
- `read-logs` — Reads `<Project>/Saved/Logs/<Project>.log` (current or previous runs); filters by category, severity, regex.

## MCP protocol features

Beyond plain-text tool output, the server implements several MCP primitives. These work with any MCP client on UE 5.5+ and need no in-engine plugin:

- **Structured output** — `build-cpp`, `compile-blueprints`, `run-tests`, and `read-logs` return machine-readable `structuredContent` (typed diagnostics, per-test results, log entries) next to the human-readable markdown, validated against a declared `outputSchema`. (`run-tests`/`read-logs` use one unified schema across their run/list modes; failure paths set `isError` so the schema isn't enforced on them.)
- **Progress notifications** — long-running tools (builds, tests, scenarios, blueprint extraction) stream `notifications/progress` when the client supplies a `progressToken`: an elapsed-time heartbeat plus milestones (UBT `[n/m]` compile steps, "test report written", per-section context generation). Silent when no token is sent.
- **Cancellation** — tools honor `notifications/cancelled` via the request `AbortSignal`; the spawned editor/UBT child is SIGTERM→SIGKILLed and the tool returns an `isError` "cancelled" result instead of running to the timeout.
- **Tool annotations** — every tool advertises `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` (the read/inspect tools are read-only; `set-blueprint-propert*` are destructive; `run-tests`/`run-scenario` are open-world).
- **Resources** — three pull-able views of the most-recently-used project (the "active project" is set by any tool call): `unreal://project/info` (project metadata JSON), `unreal://project/log` (current log tail), `unreal://project/context` (UNREAL_CONTEXT.md if generated). These are cheap filesystem reads; blueprint bodies and test reports stay as tools because they boot the editor.

The plumbing lives in `mcp-server/src/ue-bridge/run-control.ts` (transport-agnostic cancel/progress), `mcp-server/src/mcp/progress.ts` (MCP `extra` → progress adapter), `mcp-server/src/mcp/output-schemas.ts` (zod output schemas), and `mcp-server/src/mcp/resources.ts`. Hermetic tests: `mcp-server/tests/verify-mcp-primitives.js` and `verify-server-handshake.js`.

## Recording & playback (Slate-level replay)

The `playRecording` step in `run-scenario` replays a previously captured gameplay session through the live Slate input pipeline — same code path real key/mouse events take, so input handlers, IMCs, and game-side logic all fire normally. Backed by the `UClaudeInputRecorder` subsystem in the `ClaudeUnrealBridge` editor plugin.

### Per-project setup (one-time)
1. Enable `ClaudeUnrealBridge` in the project's `.uproject` Plugins list (`{"Name": "ClaudeUnrealBridge", "Enabled": true}`)
2. Build the project's editor target once so plugin binaries land in `<Plugin>/Binaries/Mac/`
3. Recordings will live in `<Project>/Saved/ClaudeRecordings/<name>.json` and are JSON, self-describing (carry `viewportOriginX/Y/Width/Height`, used by playback to keep aim correct regardless of playback window size)

### Capturing a recording
In the running editor's console:
- `Rec.Start <name>` — start capturing Slate input + camera samples
- (play normally)
- `Rec.Stop <name>` — finalise the JSON. The recorder trims the trailing console keystrokes (the very command you just typed) automatically (`Rec.TrimConsole 1`, default on).

### Replaying via MCP
Pass a `playRecording` step to `run-scenario`:
```json
{ "type": "playRecording", "name": "fishtest4", "seekPawn": true }
```
The runner resolves a bare name against `<Project>/Saved/ClaudeRecordings/`. Optional `mappingContexts: ["/Game/.../IMC_X"]` overrides the IMC auto-discovery (only needed if the headless boot skips a UI screen that normally calls `AddMappingContext`).

### Replaying via the smoke test
`mcp-server/tests/verify-play-recording.js` is env-var driven and skips with exit 0 when unconfigured:
```bash
CLAUDE_TEST_PROJECT=/path/to/MyProject \
CLAUDE_TEST_RECORDING=mytest \
CLAUDE_TEST_MAP=/Game/Maps/MyMap \
CLAUDE_TEST_VISIBLE=1            # optional — drops -RenderOffscreen so you can watch + hear it
CLAUDE_TEST_IMC=/Game/.../IMC_X  # optional — comma-separated, overrides auto-discovery
node mcp-server/tests/verify-play-recording.js
```
Asserts the run completed cleanly (duration matches recording ±25%, no `Rec.Play raised` in the log, IMC bind logged if requested). Doesn't assert game-specific outcomes — those vary with the project's RNG.

### Behaviour notes
- **Cursor stays put.** The scenario runner sets `Rec.SuppressCursor 1` before `Rec.Play`, so your physical mouse never gets warped during agent-driven playback.
- **No focus theft.** Default playback uses `-RenderOffscreen` so the editor window never appears on screen.
- **Aim is recording-resolution-independent.** The recorder snapshots its capture-time viewport rect and the playback dylib rebases mouse coords via an affine transform (scale + offset) against the live playback viewport — so a recording captured in PIE at one size replays correctly in a `-game` window at any other size.
- **`Rec.SuppressCursor 0`** restores the cursor-follow behaviour (useful for human-interactive `Rec.Play <name>` from the editor console).
- **`Rec.TrimConsole 0`** disables the auto-trim of trailing `Rec.Stop` keystrokes (rarely needed; only if you're recording console interactions on purpose).

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
