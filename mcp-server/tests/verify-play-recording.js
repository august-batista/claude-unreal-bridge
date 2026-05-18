#!/usr/bin/env node
/**
 * Smoke test for the playRecording scenario step.
 *
 * Drives the same path run-scenario.ts uses in production: boot the
 * project in -game with a real RHI but -RenderOffscreen (no window
 * appears on macOS), have the in-game Python runner bind the player's
 * IMC(s) and then dispatch `Rec.Play <name>`, poll for completion,
 * SIGTERM the editor once the runner writes its result JSON.
 *
 * Env vars (required):
 *   CLAUDE_TEST_PROJECT   absolute path to the project's .uproject dir
 *   CLAUDE_TEST_RECORDING base name (e.g. fishtest3) or absolute path
 *
 * Env vars (optional):
 *   CLAUDE_TEST_MAP        asset path to boot, e.g. /Game/Bearships/Modules/Game/Game
 *                          (defaults to the project's GameDefaultMap if it
 *                          can be detected; otherwise we skip with an error)
 *   CLAUDE_TEST_IMC        comma-separated IMC paths/names to bind on the
 *                          local player. Omit to let the runner fall back
 *                          to recording metadata + pawn defaults.
 *   CLAUDE_TEST_TIMEOUT_MS hard backstop. Defaults to recording duration +
 *                          60s, or 180_000ms if duration can't be read.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject, defaultProjectLogPath } from "../dist/ue-bridge/project-detector.js";
import { runEditor } from "../dist/ue-bridge/editor-runner.js";

const PLUGIN_ROOT = "/Users/august/Documents/claude-unreal";

const PROJECT = process.env.CLAUDE_TEST_PROJECT;
const RECORDING = process.env.CLAUDE_TEST_RECORDING;

if (!PROJECT || !RECORDING) {
  console.log("SKIP: verify-play-recording requires CLAUDE_TEST_PROJECT + CLAUDE_TEST_RECORDING.");
  console.log("Example:");
  console.log("  CLAUDE_TEST_PROJECT=/Users/august/Documents/Bearships/Project/Bearships \\");
  console.log("  CLAUDE_TEST_RECORDING=fishtest3 \\");
  console.log("  CLAUDE_TEST_MAP=/Game/Bearships/Modules/Game/Game \\");
  console.log("  node mcp-server/tests/verify-play-recording.js");
  process.exit(0);
}

const project = detectProject(PROJECT);
const logPath = defaultProjectLogPath(project);

// Resolve recording path so we can sanity-check existence + read metadata.
const recordingPath = RECORDING.includes("/")
  ? RECORDING
  : join(PROJECT, "Saved", "ClaudeRecordings", RECORDING.endsWith(".json") ? RECORDING : `${RECORDING}.json`);

if (!existsSync(recordingPath)) {
  console.error(`ERROR: recording not found at ${recordingPath}`);
  process.exit(1);
}

const recording = JSON.parse(readFileSync(recordingPath, "utf-8").replace(/^﻿/, ""));
const recordingDuration = Number(recording.durationSeconds || 0);

// Map: prefer env, then GameDefaultMap from DefaultEngine.ini.
let map = process.env.CLAUDE_TEST_MAP;
if (!map) {
  try {
    const ini = readFileSync(join(PROJECT, "Config", "DefaultEngine.ini"), "utf-8");
    const m = ini.match(/^GameDefaultMap=(.+)$/m);
    if (m) {
      // Strip class suffix if present (e.g. /Game/X/Y.Y -> /Game/X/Y).
      map = m[1].replace(/\.[^/]+$/, "").trim();
    }
  } catch { /* fall through */ }
}
if (!map) {
  console.error("ERROR: no map specified (set CLAUDE_TEST_MAP) and could not read GameDefaultMap from DefaultEngine.ini");
  process.exit(1);
}

const imcList = (process.env.CLAUDE_TEST_IMC || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const timeoutMs = process.env.CLAUDE_TEST_TIMEOUT_MS
  ? Number(process.env.CLAUDE_TEST_TIMEOUT_MS)
  : recordingDuration > 0
    ? Math.ceil((recordingDuration + 60) * 1000)
    : 180_000;

const tmpDir = mkdtempSync(join(tmpdir(), "claude-play-recording-"));
const stepsPath = join(tmpDir, "steps.json");
const resultPath = join(tmpDir, "result.json");

const steps = [
  { type: "wait", seconds: 2.0 },
  {
    type: "playRecording",
    name: recordingPath,
    seekPawn: true,
    ...(imcList.length ? { mappingContexts: imcList } : {}),
  },
  { type: "quit" },
];
writeFileSync(stepsPath, JSON.stringify(steps, null, 2));

const runnerScript = join(PLUGIN_ROOT, "python-scripts", "scenario_runner.py");

console.log(`Project:   ${PROJECT}`);
console.log(`Map:       ${map}`);
console.log(`Recording: ${recordingPath}`);
console.log(`Duration:  ${recordingDuration.toFixed(1)}s (timeout backstop ${(timeoutMs/1000).toFixed(0)}s)`);
console.log(`IMCs:      ${imcList.length ? imcList.join(", ") : "(let runner discover)"}`);
console.log(`Log path:  ${logPath}`);
console.log("");
console.log("BEGIN PLAYBACK — no window should appear during the next ~" + Math.ceil(recordingDuration) + "s");
console.log("");

const startedAt = Date.now();

const run = await runEditor(project, {
  extraArgs: [
    "-game",
    map,
    `-ExecCmds=py ${runnerScript}`,
    "-log",
  ],
  timeoutMs,
  // Same `-RenderOffscreen` config that run-scenario.ts uses for the
  // playRecording branch: real RHI for Slate input routing, no on-screen
  // window on macOS.
  headlessFlags: ["-unattended", "-nopause", "-nosound", "-nosplash", "-RenderOffscreen"],
  env: {
    CLAUDE_SCENARIO_JSON: stepsPath,
    CLAUDE_SCENARIO_RESULT: resultPath,
    CLAUDE_SCENARIO_LOG: logPath,
  },
  onSpawn: (proc, kill) => {
    // Informational only: capture process state so we can tell at a glance
    // whether the editor is in a sane background-ish state.
    try {
      const ps = execSync(`ps -p ${proc.pid} -o pid=,pgid=,sess=,stat=`).toString().trim();
      console.log(`  child ps: ${ps}`);
    } catch { /* may have already exited */ }
    let killed = false;
    const interval = setInterval(() => {
      if (killed) return;
      if (existsSync(resultPath)) {
        killed = true;
        // Give the runner ~1s to also try its own quit before SIGTERM.
        setTimeout(() => kill(), 1000);
      }
    }, 500);
    return () => clearInterval(interval);
  },
});

const elapsedSec = (Date.now() - startedAt) / 1000;
console.log("");
console.log(`END PLAYBACK — editor exit ${run.exitCode}, ${elapsedSec.toFixed(1)}s wall`);
console.log("");

// Checks.
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log("    " + JSON.stringify(detail)); }
}

check("editor terminated (not timed out)", !run.timedOut, { timedOut: run.timedOut, durationMs: run.durationMs });
check("result JSON written", existsSync(resultPath));

let result;
if (existsSync(resultPath)) {
  result = JSON.parse(readFileSync(resultPath, "utf-8").replace(/^﻿/, ""));
  console.log("\n  result JSON:", JSON.stringify(result, null, 2).split("\n").map(l => "    " + l).join("\n"));

  check("steps[] has 3 entries (wait, playRecording, quit)", result.steps?.length === 3);
  const pr = result.steps?.[1];
  check("step 1 is playRecording", pr?.type === "playRecording", pr);
  check("step 1 outcome ok", pr?.outcome === "ok", pr);

  if (recordingDuration > 0 && pr?.outcome === "ok") {
    const lower = recordingDuration * 0.75;
    const upper = recordingDuration * 1.25;
    check(
      `step 1 duration within ±25% of recording (${recordingDuration.toFixed(1)}s)`,
      pr.durationSec >= lower && pr.durationSec <= upper,
      { expected: `${lower.toFixed(1)}–${upper.toFixed(1)}s`, actual: pr.durationSec },
    );
  }
  check("no earlyExit recorded", !result.earlyExit, result.earlyExit);
}

if (existsSync(logPath)) {
  const log = readFileSync(logPath, "utf-8");
  const claudeLines = log.split("\n").filter(l => l.includes("[ClaudeScenario]"));
  console.log(`\n  ${claudeLines.length} [ClaudeScenario] line(s) — last 30:`);
  claudeLines.slice(-30).forEach(l => console.log("    " + l));

  check("Rec.Play kicked off", claudeLines.some(l => l.includes("kicked off Rec.Play")));
  check("no Rec.Play errors", !claudeLines.some(l => l.includes("Rec.Play raised")), claudeLines.filter(l => l.includes("Rec.Play raised")));
  check("no IMC bind exceptions", !claudeLines.some(l => l.includes("IMC bind:") && l.includes("raised:")), claudeLines.filter(l => l.includes("IMC bind:") && l.includes("raised:")));

  if (imcList.length) {
    check(
      "explicit IMC(s) bound",
      claudeLines.some(l => l.match(/IMC bound: .+ \(priority \d+\)/)),
      claudeLines.filter(l => l.includes("IMC")),
    );
  }
}

try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
