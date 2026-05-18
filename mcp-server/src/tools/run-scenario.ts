import { z } from "zod";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  detectProject,
  defaultProjectLogPath,
} from "../ue-bridge/project-detector.js";
import { runEditor } from "../ue-bridge/editor-runner.js";
import {
  filterLog,
  formatLogEntries,
  type LogFilter,
  type LogSeverity,
} from "../parsers/log-output.js";
import type {
  ScenarioStep,
  ScenarioRunResult,
} from "../types/scenario.js";

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();

// Zod schema mirroring ScenarioStep — has to be runtime-validated because
// the steps come in from the MCP client as JSON. Keep in sync with
// src/types/scenario.ts.
const stepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exec"),
    cmd: z.string().describe("Console command, e.g. 'KE * StartTest', 'showdebug game', 'slomo 0.5'."),
  }),
  z.object({
    type: z.literal("wait"),
    seconds: z.number().min(0).describe("Game-time seconds. Scales with slomo / engine pause."),
  }),
  z.object({
    type: z.literal("waitForLog"),
    pattern: z.string().describe("Regex matched (case-insensitive) against live log output."),
    timeoutSec: z.number().min(0).default(30).describe("Max game-time seconds to wait before advancing."),
  }),
  z.object({
    type: z.literal("injectAction"),
    action: z.string().describe("UInputAction asset path (`/Game/.../IA_Move`) or short name (`IA_Move`)."),
    value: z
      .union([
        z.number(),
        z.tuple([z.number(), z.number()]),
        z.tuple([z.number(), z.number(), z.number()]),
      ])
      .optional()
      .describe("Input value. Number for button/Axis1D, [x,y] for Axis2D (movement), [x,y,z] for Axis3D. Default 1.0 (boolean press)."),
    holdSec: z
      .number()
      .min(0)
      .optional()
      .describe("If set, re-inject every tick for this many game-time seconds (held buttons, charge-up). Omit for a single-tick press."),
  }),
  z.object({
    type: z.literal("possess"),
    actorTag: z.string().optional().describe("Find the first actor with this tag and possess it."),
    actorClass: z.string().optional().describe("Find the first actor of this class (e.g. `/Game/.../BP_Player.BP_Player_C`) and possess it."),
  }),
  z.object({
    type: z.literal("playRecording"),
    name: z.string().describe(
      "Recording base name (e.g. \"FishTest1\") — resolves to <Project>/Saved/ClaudeRecordings/<name>.json. If the value contains a slash or ends in `.json`, treated as a full path.",
    ),
    seekPawn: z.boolean().default(true).describe(
      "Teleport the player pawn to the recording's first pawn-location sample before replay begins. Default true.",
    ),
    mappingContexts: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of UInputMappingContext asset paths (`/Game/.../IMC_Default`) or short names to bind on the local player before playback. Needed when a headless boot skips the in-game flow that normally calls AddMappingContext. If omitted, the runner falls back to (a) the recording's own metadata, then (b) the pawn class's default IMC properties.",
      ),
  }),
  z.object({
    type: z.literal("quit"),
  }),
]);

export function registerRunScenarioTool(server: McpServer): void {
  server.tool(
    "run-scenario",
    "Boot a map headlessly and either (a) run a single -ExecCmds and capture logs, or (b) execute a scripted step list that drives the actual player input pipeline via EnhancedInput. " +
      "Use the step list (`steps` parameter) when you need to test player logic — held buttons, sequenced inputs, log-reactive flows. " +
      "Use the simple form (`execCmds`) for quick boot-and-cvar checks.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      mapPath: z
        .string()
        .describe("Map to boot. Asset path (`/Game/Maps/MyMap`) or short name."),
      mode: z
        .enum(["editor", "game"])
        .default("game")
        .describe(
          "`game` (default) launches with `-game` so gameplay logic actually runs. `editor` for editor-only systems.",
        ),
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          "Scripted step list. Drives the actual player input pipeline (EnhancedInput injection), supports holds, log-reactive waits, possess. Mutually exclusive with `execCmds`.",
        ),
      execCmds: z
        .array(z.string())
        .default([])
        .describe(
          "Simple form: console commands sent at boot via -ExecCmds (joined with `;`, but note UE drops anything after the first command unreliably — prefer `steps` for multi-command sequences). Include `Quit` if you want a clean exit.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(60_000)
        .max(3_600_000)
        .default(300_000)
        .describe("Hard timeout backstop. The process is force-killed if it overruns."),
      logCategories: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict captured log output to these categories (e.g. [\"LogBlueprint\", \"LogTemp\"]). Omit to include everything matching `minSeverity`.",
        ),
      minSeverity: z
        .enum([
          "fatal",
          "error",
          "warning",
          "display",
          "log",
          "verbose",
          "veryverbose",
        ])
        .default("display")
        .describe(
          "Lowest log severity to include in the captured slice. Default `display` keeps gameplay UE_LOG output visible.",
        ),
      pattern: z
        .string()
        .optional()
        .describe("Optional regex (case-insensitive) to filter log message bodies."),
      maxLogLines: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .default(150)
        .describe("Max log lines to include in the response. Set to 0 to skip log embedding (use `read-logs` afterwards)."),
    },
    async ({
      projectPath,
      mapPath,
      mode,
      steps,
      execCmds,
      timeoutMs,
      logCategories,
      minSeverity,
      pattern,
      maxLogLines,
    }) => {
      try {
        const project = detectProject(projectPath);

        if (steps && steps.length > 0 && execCmds.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Error: `steps` and `execCmds` are mutually exclusive. " +
                  "Use `steps` for scripted scenarios (preferred), or `execCmds` for a single-shot boot.",
              },
            ],
          };
        }

        const logPath = defaultProjectLogPath(project);
        const beforeMtime = existsSync(logPath) ? statSync(logPath).mtimeMs : 0;

        // Scenario mode — generate scenario JSON, launch with the Python runner.
        let scenarioDir: string | undefined;
        let scenarioPath: string | undefined;
        let scenarioResultPath: string | undefined;

        // playRecording runs in -game with a real RHI (Slate input routing
        // needs a viewport widget alive — the recording is at slate level,
        // not action-level) but rendered off-screen so no on-screen window
        // appears on macOS. IMC binding happens in scenario_runner.py
        // before Rec.Play fires, in case the game's normal flow that wires
        // AddMappingContext is gated behind a UI screen that the headless
        // boot skips.
        const wantsRecording = (steps ?? []).some((s) => s.type === "playRecording");

        const argv: string[] = [];
        if (mode === "game") argv.push("-game");
        argv.push(mapPath);

        let envExtra: Record<string, string> | undefined;

        if (steps && steps.length > 0) {
          scenarioDir = mkdtempSync(join(tmpdir(), "claude-unreal-scenario-"));
          scenarioPath = join(scenarioDir, "steps.json");
          scenarioResultPath = join(scenarioDir, "result.json");

          // Resolve playRecording.name → absolute path so the Python runner
          // doesn't need to know the project's saved-dir convention.
          const recordingsDir = join(project.projectPath, "Saved", "ClaudeRecordings");
          const resolvedSteps = steps.map((s) => {
            if (s.type !== "playRecording") return s;
            const name = s.name;
            let resolved = name;
            if (!name.includes("/")) {
              // Bare name like "FishTest1" — resolve in the standard dir.
              resolved = join(recordingsDir, name.endsWith(".json") ? name : `${name}.json`);
            } else if (!name.startsWith("/")) {
              // Relative path — resolve under recordings dir.
              resolved = join(recordingsDir, name);
            }
            return { ...s, name: resolved };
          });
          writeFileSync(scenarioPath, JSON.stringify(resolvedSteps, null, 2));

          const runnerPath = join(
            pluginRoot,
            "python-scripts",
            "scenario_runner.py",
          );

          // UE's `py` console command auto-loads a .py file given as its
          // argument. (`py.execfile` is not a real subcommand — UE will
          // parse it as `py` with argument `.execfile <path>` and try to
          // load that literal as a file.)
          argv.push(`-ExecCmds=py ${runnerPath}`);
          envExtra = {
            CLAUDE_SCENARIO_JSON: scenarioPath,
            CLAUDE_SCENARIO_RESULT: scenarioResultPath,
            CLAUDE_SCENARIO_LOG: logPath,
          };
        } else if (execCmds.length > 0) {
          argv.push(`-ExecCmds=${execCmds.join("; ")}`);
        }
        argv.push("-log");

        // For recording playback:
        //   keep -game (gameplay world boots normally, no editor UI)
        //   drop -nullrhi (Slate input routing into the focused viewport
        //                  needs a real RHI to set up the widget tree)
        //   add -RenderOffscreen (renders to backbuffer, no on-screen window
        //                         appears, so no focus steal on macOS)
        const headlessFlags = wantsRecording
          ? ["-unattended", "-nopause", "-nosound", "-nosplash", "-RenderOffscreen"]
          : undefined; // other scripted steps run under the default (with -nullrhi)

        const run = await runEditor(project, {
          extraArgs: argv,
          timeoutMs,
          env: envExtra,
          headlessFlags,
          // For scripted scenarios, poll for the result JSON. The Python
          // runner writes it when the step list completes; we then SIGTERM
          // because quit_game can't reliably terminate without a world ref
          // in -nullrhi mode.
          onSpawn: scenarioResultPath
            ? (_proc, kill) => {
                const resultFile = scenarioResultPath;
                let killed = false;
                const interval = setInterval(() => {
                  if (killed) return;
                  if (existsSync(resultFile)) {
                    killed = true;
                    // Give the runner ~1s to also try its own quit (and
                    // anything mid-flush) before we SIGTERM.
                    setTimeout(() => kill(), 1000);
                  }
                }, 500);
                return () => clearInterval(interval);
              }
            : undefined,
        });

        const lines: string[] = [];
        const status = run.timedOut
          ? "TIMED OUT"
          : run.exitCode === 0
            ? "OK"
            : "FAILED";
        lines.push(
          `## Scenario: ${status} — \`${mapPath}\` (${mode}${steps ? `, ${steps.length} step(s)` : ""})`,
        );
        lines.push(
          `Editor exit: ${run.exitCode ?? "killed"}, duration: ${(run.durationMs / 1000).toFixed(1)}s.`,
        );

        // If we ran a scripted scenario, fold the step trace in.
        if (scenarioResultPath && existsSync(scenarioResultPath)) {
          try {
            const result: ScenarioRunResult = JSON.parse(
              readFileSync(scenarioResultPath, "utf-8").replace(/^﻿/, ""),
            );
            lines.push("", "### Step trace", "");
            for (const r of result.steps) {
              const tag =
                r.outcome === "ok" || r.outcome === "matched"
                  ? "✓"
                  : r.outcome === "timedOut"
                    ? "⏱"
                    : "✗";
              lines.push(
                `${tag} **${r.index}. ${r.type}** — ${r.outcome} (${r.durationSec.toFixed(2)}s game time)` +
                  (r.detail ? ` — _${r.detail}_` : ""),
              );
            }
            if (result.earlyExit) {
              lines.push("", `_Early exit: ${result.earlyExit}_`);
            }
            lines.push("", `Final game time: ${result.finalGameSec.toFixed(2)}s.`);
          } catch (err) {
            lines.push(
              "",
              `_Failed to parse scenario result JSON: ${err instanceof Error ? err.message : String(err)}_`,
            );
          }
        } else if (steps && steps.length > 0) {
          lines.push(
            "",
            "_Scenario result JSON missing — the runner didn't reach completion. Check the log for `[ClaudeScenario]` lines._",
          );
        } else if (execCmds.length > 0) {
          lines.push(
            "",
            "**Exec commands sent:**",
            ...execCmds.map((c) => `- \`${c}\``),
          );
        }

        if (maxLogLines > 0) {
          if (existsSync(logPath)) {
            const afterMtime = statSync(logPath).mtimeMs;
            if (afterMtime <= beforeMtime) {
              lines.push(
                "",
                "_Log file was not updated by this run — the editor may have failed before opening the project._",
              );
            } else {
              const contents = readFileSync(logPath, "utf-8");
              const filter: LogFilter = {
                categories: logCategories,
                minSeverity: minSeverity as LogSeverity,
                pattern,
              };
              const { entries, stats } = filterLog(contents, filter, maxLogLines);
              lines.push("", formatLogEntries(entries, stats, `\`${logPath}\``));
            }
          } else {
            lines.push("", "_No log file produced. Use `read-logs` to investigate._");
          }
        }

        if (status !== "OK" && (run.stderr || "").trim()) {
          const tail = run.stderr.slice(-1500).trim();
          lines.push(
            "",
            "### Editor stderr (tail)",
            "",
            "```",
            tail,
            "```",
          );
        }

        // Clean up scenario temp dir.
        if (scenarioDir) {
          try { rmSync(scenarioDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
