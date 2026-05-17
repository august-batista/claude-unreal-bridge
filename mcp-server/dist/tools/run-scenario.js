import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runEditor } from "../ue-bridge/editor-runner.js";
import { filterLog, formatLogEntries, } from "../parsers/log-output.js";
export function registerRunScenarioTool(server) {
    server.tool("run-scenario", "Boot a map headlessly and run console commands against it, then capture filtered logs from the run. " +
        "Use to validate gameplay behaviour from outside the Automation framework — e.g. \"open this level, fire this ability, check the logs\". " +
        "End your `execCmds` with `Quit` for a clean exit; otherwise rely on `timeoutMs`.", {
        projectPath: z
            .string()
            .describe("Absolute path to the UE project directory"),
        mapPath: z
            .string()
            .describe("Map to boot. Accepts asset paths (`/Game/Maps/MyMap`) or short names (`MyMap`)."),
        execCmds: z
            .array(z.string())
            .default([])
            .describe("Console commands to run after the map loads, in order. Example: [\"showdebug game\", \"ke * StartScenario\", \"Quit\"]. Include `Quit` to terminate cleanly."),
        mode: z
            .enum(["editor", "game"])
            .default("game")
            .describe("`game` (default) launches with `-game` for actual gameplay execution (PIE-like). `editor` opens the map in editor mode (use when you need editor-only systems)."),
        timeoutMs: z
            .number()
            .int()
            .min(60_000)
            .max(3_600_000)
            .default(300_000)
            .describe("Hard timeout. Defaults to 5 minutes. The process is force-killed if it overruns."),
        logCategories: z
            .array(z.string())
            .optional()
            .describe("Restrict captured log output to these categories (e.g. [\"LogBlueprint\", \"LogTemp\"]). Omit to include everything matching `minSeverity`."),
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
            .describe("Lowest log severity to include in the captured output. Default `display` keeps gameplay UE_LOG output visible."),
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
            .describe("Max log lines to include in the response. The most recent matches are kept. Set to 0 to skip log embedding (use `read-logs` afterwards)."),
    }, async ({ projectPath, mapPath, execCmds, mode, timeoutMs, logCategories, minSeverity, pattern, maxLogLines, }) => {
        try {
            const project = detectProject(projectPath);
            // Note the current log mtime so we can confirm we're reading the
            // log this run produced, not a stale one.
            const logPath = join(project.projectPath, "Saved", "Logs", `${project.projectName}.log`);
            const beforeMtime = existsSync(logPath)
                ? statSync(logPath).mtimeMs
                : 0;
            const argv = [];
            if (mode === "game")
                argv.push("-game");
            argv.push(mapPath);
            if (execCmds.length > 0) {
                // UE expects "; "-separated commands in a single -ExecCmds arg.
                argv.push(`-ExecCmds=${execCmds.join("; ")}`);
            }
            argv.push("-log");
            const run = await runEditor(project, {
                extraArgs: argv,
                timeoutMs,
            });
            const lines = [];
            const status = run.timedOut
                ? "TIMED OUT"
                : run.exitCode === 0
                    ? "OK"
                    : "FAILED";
            lines.push(`## Scenario: ${status} — \`${mapPath}\` (${mode})`);
            lines.push(`Editor exit: ${run.exitCode ?? "killed"}, duration: ${(run.durationMs / 1000).toFixed(1)}s.`);
            if (execCmds.length > 0) {
                lines.push("", "**Exec commands sent:**", ...execCmds.map((c) => `- \`${c}\``));
            }
            if (maxLogLines > 0) {
                if (existsSync(logPath)) {
                    const afterMtime = statSync(logPath).mtimeMs;
                    if (afterMtime <= beforeMtime) {
                        lines.push("", "_Log file was not updated by this run — the editor may have failed before opening the project._");
                    }
                    else {
                        const contents = readFileSync(logPath, "utf-8");
                        const filter = {
                            categories: logCategories,
                            minSeverity: minSeverity,
                            pattern,
                        };
                        const { entries, stats } = filterLog(contents, filter, maxLogLines);
                        lines.push("", formatLogEntries(entries, stats, `\`${logPath}\``));
                    }
                }
                else {
                    lines.push("", "_No log file produced. Use `read-logs` to investigate._");
                }
            }
            if (status !== "OK" && (run.stderr || "").trim()) {
                // Surface the last bit of stderr to help diagnose launch failures
                // — these are usually editor-startup errors that pre-date logging.
                const tail = run.stderr.slice(-1500).trim();
                lines.push("", "### Editor stderr (tail)", "", "```", tail, "```");
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
}
//# sourceMappingURL=run-scenario.js.map