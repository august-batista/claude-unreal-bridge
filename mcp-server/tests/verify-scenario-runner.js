#!/usr/bin/env node
/**
 * Smoke test for the in-game scenario_runner.py via -ExecCmds=py.execfile.
 *
 * Boots OpenWorld with `-game` and runs a simple exec/wait/quit step
 * list. We don't need a player or IA asset for this — just want to
 * confirm the runner arms, ticks, walks the step list, writes the
 * result JSON, and quits cleanly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { detectProject, defaultProjectLogPath } from "../dist/ue-bridge/project-detector.js";
import { runEditor } from "../dist/ue-bridge/editor-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..", "..");
const SANDBOX = join(PLUGIN_ROOT, "sandbox-project");

const project = detectProject(SANDBOX);
const logPath = defaultProjectLogPath(project);

const tmpDir = mkdtempSync(join(tmpdir(), "claude-scen-test-"));
const stepsPath = join(tmpDir, "steps.json");
const resultPath = join(tmpDir, "result.json");

const steps = [
  { type: "exec", cmd: "stat fps" },
  { type: "wait", seconds: 1.0 },
  { type: "exec", cmd: "stat unit" },
  { type: "wait", seconds: 0.5 },
  { type: "quit" },
];
writeFileSync(stepsPath, JSON.stringify(steps, null, 2));

const runnerScript = join(PLUGIN_ROOT, "python-scripts", "scenario_runner.py");

console.log(`Booting OpenWorld + scenario runner (${steps.length} steps)`);
console.log(`  scenario JSON: ${stepsPath}`);
console.log(`  result JSON:   ${resultPath}`);
console.log(`  log path:      ${logPath}`);
console.log("");

const run = await runEditor(project, {
  extraArgs: [
    "-game",
    "/Engine/Maps/Templates/OpenWorld",
    `-ExecCmds=py ${runnerScript}`,
    "-log",
  ],
  timeoutMs: 90_000,
  env: {
    CLAUDE_SCENARIO_JSON: stepsPath,
    CLAUDE_SCENARIO_RESULT: resultPath,
    CLAUDE_SCENARIO_LOG: logPath,
  },
  // Same poll-and-kill pattern run-scenario uses in production:
  // SIGTERM as soon as the runner writes its result JSON.
  onSpawn: (_proc, kill) => {
    let killed = false;
    const interval = setInterval(() => {
      if (killed) return;
      if (existsSync(resultPath)) {
        killed = true;
        setTimeout(() => kill(), 1000);
      }
    }, 500);
    return () => clearInterval(interval);
  },
});

console.log(`editor exit ${run.exitCode}, ${(run.durationMs / 1000).toFixed(1)}s`);
console.log("");

// Check results.
let pass = 0, fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); if (detail) console.log("    " + JSON.stringify(detail)); }
}

// Editor exits via SIGTERM after we see the result file land. exitCode
// will be null (killed by signal). That's a successful path, not a failure.
check(
  "editor terminated after result file landed (not timeout)",
  run.durationMs < 60_000,
  { durationMs: run.durationMs, timedOut: run.timedOut },
);
check("result JSON written", existsSync(resultPath));

if (existsSync(resultPath)) {
  const result = JSON.parse(readFileSync(resultPath, "utf-8").replace(/^﻿/, ""));
  console.log("\n  result JSON:", JSON.stringify(result, null, 2).split("\n").map(l => "    " + l).join("\n"));

  check(`steps[] has ${steps.length} entries`, result.steps?.length === steps.length, result.steps);
  check("step 0 is exec ok", result.steps?.[0]?.type === "exec" && result.steps?.[0]?.outcome === "ok");
  check(
    "step 1 wait took roughly 1s game time",
    result.steps?.[1]?.durationSec >= 0.9 && result.steps?.[1]?.durationSec <= 1.5,
    { actual: result.steps?.[1]?.durationSec },
  );
  check(
    "step 3 wait took roughly 0.5s game time",
    result.steps?.[3]?.durationSec >= 0.4 && result.steps?.[3]?.durationSec <= 0.8,
    { actual: result.steps?.[3]?.durationSec },
  );
  check("step 4 quit ok", result.steps?.[4]?.type === "quit" && result.steps?.[4]?.outcome === "ok");
  check("no earlyExit recorded", !result.earlyExit, result.earlyExit);
}

if (existsSync(logPath)) {
  const log = readFileSync(logPath, "utf-8");
  const claudeLines = log.split("\n").filter(l => l.includes("[ClaudeScenario]"));
  console.log(`\n  ${claudeLines.length} [ClaudeScenario] line(s) in log:`);
  claudeLines.slice(0, 20).forEach(l => console.log("    " + l));

  check("runner armed", claudeLines.some(l => l.includes("arming scenario runner")));
  // No world-ready assertion: OpenWorld template doesn't auto-spawn a player,
  // so the runner falls back to wall-clock time. That fallback is validated
  // by the wait-step duration assertions above (which would fail if game
  // time wasn't advancing).
  check("at least one step BEGIN logged", claudeLines.some(l => l.includes("step 0 BEGIN")));
}

try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
