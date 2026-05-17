---
name: gameplay-tester
description: >
  Test Unreal Engine gameplay logic by running automation tests, booting maps
  with console commands, and inspecting the resulting logs. Use when the user
  wants to "test this", "run the tests", "verify this works in-game", "play
  this map and check what happens", "see what was logged", "find errors in the
  log", or any workflow that involves observing UE behaviour at runtime rather
  than just reading static asset data.
---

# Gameplay Tester

Verify UE gameplay end-to-end by combining the build, test, scenario, and
log tools.

## The four runtime tools

| Tool | When to use it |
| --- | --- |
| `build-cpp` | Before anything else if C++ source has changed. The editor cannot open with a stale module. |
| `compile-blueprints` | Before tests/scenarios — catches BP-level errors that would otherwise show up later. |
| `run-tests` | Run UE Automation tests (C++ `IMPLEMENT_SIMPLE_AUTOMATION_TEST` and Functional Tests in maps). The closest thing UE has to xUnit. |
| `run-scenario` | Boot a map headlessly with `-game` and drive it with console commands. For "load this level, fire this ability, see what happens" workflows that don't fit the Automation framework. |
| `read-logs` | Read `<Project>/Saved/Logs/<Project>.log`. Always available after any run. |

## A typical test loop

1. **Edit code** (C++, Blueprint, or both).
2. **Build the project** — call `build-cpp` then `compile-blueprints`. The
   `/ue-build` command does both. Stop and report errors here; nothing
   downstream will work if either fails.
3. **Run the tests** — `run-tests` with a focused filter (`Project.Foo.`)
   not the whole world. Engine-wide test runs take 10+ minutes.
4. **If a test fails**, read its error events first (already in the
   `run-tests` output), then `read-logs` for surrounding context like
   warnings just before the failure.
5. **For gameplay scenarios** that aren't a clean unit test, write a
   `run-scenario` invocation: open the level, send console commands
   (`ke * MyEvent`, `ce DebugCommand`, `Quit`), then inspect logs.

## Console-command tricks for `run-scenario`

- `ke * <FunctionName>` — call any custom event named `<FunctionName>`
  on every actor in the world. Great for triggering test scenarios from a
  Level Blueprint without writing C++.
- `showdebug game` — dump game-state info to the log.
- `stat game`, `stat unit` — performance counters.
- `t.MaxFPS 60` — pin frame rate so timing-sensitive logic is reproducible.
- `slomo 0.1` — slow time for stepping through fast events. Combine with a
  `Delay` and `Quit` to capture a snapshot.
- Always end with `Quit` for a clean exit; `timeoutMs` is the backstop.

## Log filtering principles

- Default `minSeverity: warning` — keeps the response readable. Drop to
  `display` only when you specifically need normal log output.
- Restrict `categories` to what's relevant. Common gameplay categories:
  `LogBlueprint`, `LogTemp` (`UE_LOG(LogTemp, ...)` from C++),
  `LogScript`, `LogPython`, `LogAnimation`, `LogPhysics`.
- Use `pattern` (regex) to narrow further when chasing a specific bug.
- Logs are evidence. Quote the lines; don't paraphrase.

## What this skill is NOT for

- Static blueprint inspection — use `blueprint-reader` for that.
- Authoring tests — this skill runs them. The user (or an agent like
  `blueprint-architect`) writes them.
- Packaging/distribution — out of scope; UAT BuildCookRun is a different
  workflow we don't yet bridge.
