---
name: gameplay-tester
description: >
  Test Unreal Engine gameplay logic end-to-end. Run automation tests, boot
  maps headlessly with -game and DRIVE THE PLAYER (Enhanced Input injection,
  held buttons, sequenced inputs, log-reactive flows), and inspect what was
  logged. Use when the user wants to "test this", "run the tests", "verify
  this works in-game", "play this map and check what happens", "drive the
  player", "simulate a button hold", "test the fishing minigame", "see what
  was logged", "find errors in the log", or any workflow that observes UE
  behaviour at runtime rather than reading static asset data.
---

# Gameplay Tester

Verify UE gameplay end-to-end. Combines build, test, scenario-driving, and
log tools.

## The runtime toolset

| Tool | When to use it |
| --- | --- |
| `build-cpp` | Before anything else if C++ source has changed. The editor can't open with a stale module. |
| `compile-blueprints` | Before tests/scenarios. Catches BP-level errors that would otherwise show up later. |
| `run-tests` | UE Automation tests (C++ `IMPLEMENT_SIMPLE_AUTOMATION_TEST` and Functional Tests in maps). The closest thing UE has to xUnit. |
| `run-scenario` | Boot a map headlessly. Either send a single `execCmds` set at boot, OR (preferred for gameplay) pass a scripted `steps` list that drives the actual player input pipeline. |
| `read-logs` | Read `<Project>/Saved/Logs/<Project>.log`. Always available after any run. |

## Two ways to run a scenario

### Simple form — `execCmds`
Single-shot cvar set, summon, or `Quit`. Fast, but UE drops anything after
the first command in the `;`-separated string, so multi-step sequences are
unreliable. Use this for one-off cvars, not for driving gameplay.

### Scripted form — `steps`
A list of typed steps the in-game Python runner executes in order. This is
how you actually test player logic.

```json
[
  {"type": "wait",         "seconds": 2},
  {"type": "exec",         "cmd": "Cheat.SpawnRod"},
  {"type": "injectAction", "action": "IA_Move", "value": [1.0, 0.0]},
  {"type": "wait",         "seconds": 0.5},
  {"type": "injectAction", "action": "IA_UseItemPrimary", "holdSec": 1.5},
  {"type": "waitForLog",   "pattern": "LogFish.*cast complete", "timeoutSec": 5},
  {"type": "injectAction", "action": "IA_UseItemPrimary"},
  {"type": "waitForLog",   "pattern": "LogFish.*OnHooked", "timeoutSec": 10},
  {"type": "quit"}
]
```

### The step types

- **`exec`** — fire a console command. Best for cvars, cheats, `showdebug`,
  `KE * EventName`. Single-shot.
- **`wait`** — pause for N seconds of **game time**. Scales with `slomo`,
  pauses with engine pause.
- **`waitForLog`** — block until a regex matches a line in the live log
  (case-insensitive), or `timeoutSec` elapses. Resumable — sequential
  waitForLogs scan forward from where the previous one stopped.
- **`injectAction`** — fire an `UInputAction` through
  `UEnhancedInputLocalPlayerSubsystem::InjectInputForAction`. **The actual
  player input code path runs** — same handlers, same triggers, same
  modifiers as a real keypress. Not a cheat bypass.
  - `action`: asset path (`/Game/.../IA_Move`) or short name (`IA_Move`)
  - `value`: number → Axis1D; `[x,y]` → Axis2D (movement); `[x,y,z]` → Axis3D
  - `holdSec`: if set, re-inject every tick for this many game-time seconds
    (held buttons, charge-up casts, button-hold triggers)
- **`possess`** — force the local player controller to possess a specific
  actor. Useful when the default game mode hasn't spawned the pawn you
  want to drive.
- **`quit`** — clean shutdown. Automatically appended when the step list
  completes; usually only needed for mid-script aborts.

## Required dependency

`injectAction` and `possess` need the **ClaudeUnrealBridge** editor-side
plugin installed and the **ClaudeUnrealBridgeRuntime** submodule loaded.
UE 5.7's Python in `-game` mode has no built-in way to reach the live
UWorld (`GameplayStatics.get_player_controller(None, 0)` returns null
because it needs a valid WorldContextObject), so the runner relies on
`UClaudeRuntimeLibrary::GetGameWorld()` from the plugin.

Without the plugin, `exec`, `wait`, and `waitForLog` still work via
wall-clock fallback — useful for log-driven verification — but
`injectAction`/`possess` will return `error: no EnhancedInputLocalPlayerSubsystem`.

## A typical test loop

1. **Edit code** (C++, Blueprint, or both).
2. **Build** — `build-cpp` then `compile-blueprints` (or `/ue-build`).
   Stop and report errors here; nothing downstream works if either fails.
3. **Run scoped automation tests** — `run-tests` with a focused filter
   (`Project.Foo.`), not the whole world. Engine-wide test runs take 10+
   minutes.
4. **For player-driven scenarios** — `run-scenario` with `steps`. Discover
   the project's `IA_*` assets (search `Content/.../Input/` or its
   equivalent), construct a step list that exercises the feature, set
   `logCategories` to the project's relevant category (`LogFish`,
   `LogQuest`, etc.).
5. **For ad-hoc level boots** — `run-scenario` with `execCmds` for a
   single cvar or cheat at boot. Cheaper than the full `steps` runner.
6. **Read the log** — `read-logs` after any run for context not surfaced
   in the immediate output.

## Console-command tricks for `exec` / `execCmds`

- `ke * <FunctionName>` — call any custom event named `<FunctionName>` on
  every actor in the world.
- `summon /Script/<Module>.<ClassName>` — spawn a C++ class instance at
  the player camera location. BP classes don't auto-load this way.
- `showdebug game`, `stat game`, `stat unit` — debug overlays / counters.
- `t.MaxFPS 60` — pin frame rate so timing-sensitive logic is reproducible.
- `slomo 0.1` — slow time. Combine with `wait`/`waitForLog` to capture
  detailed state changes.

## Log filtering principles

- Default `minSeverity: warning` keeps responses readable. Drop to
  `display` only when you specifically need normal `UE_LOG` output (e.g.
  per-tick diagnostics).
- Restrict `categories` to what's relevant. Common gameplay categories:
  `LogBlueprint`, `LogTemp`, `LogScript`, `LogPython`, `LogAnimation`,
  `LogPhysics`. Projects often add custom ones (`LogFish`, `LogCombat`).
- Use `pattern` (regex) to narrow further when chasing a specific bug.
- **Logs are evidence. Quote the lines verbatim with timestamps; don't
  paraphrase.**

## What this skill is NOT for

- Static blueprint inspection — use `blueprint-reader` for that.
- Authoring tests — this skill runs them. The user (or an agent like
  `blueprint-architect`) writes them.
- Mouse-cursor / pixel-perfect UI clicks. `injectAction` drives the
  Enhanced Input pipeline, which fires gameplay handlers. UI tests need
  either Functional Tests with widget-driving helpers, or the user
  performing the click manually.
- Packaging/distribution — out of scope; UAT BuildCookRun isn't bridged.
