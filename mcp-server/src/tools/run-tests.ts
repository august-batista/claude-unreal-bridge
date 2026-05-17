import { z } from "zod";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectProject } from "../ue-bridge/project-detector.js";
import { runEditor } from "../ue-bridge/editor-runner.js";
import {
  parseTestReport,
  formatTestReport,
} from "../parsers/test-report.js";

export function registerRunTestsTool(server: McpServer): void {
  server.tool(
    "run-tests",
    "Run UE Automation tests headlessly and report pass/fail per test. " +
      "Drives `Automation RunTests <Filter>` and parses the JSON report UE writes to `-ReportExportPath`. " +
      "Covers both C++ tests (IMPLEMENT_SIMPLE_AUTOMATION_TEST) and Functional Tests placed in maps.",
    {
      projectPath: z
        .string()
        .describe("Absolute path to the UE project directory"),
      filter: z
        .string()
        .default("")
        .describe(
          "Test path filter. Examples: \"Sandbox.\" runs every test under Sandbox; \"Sandbox.Sanity.AlwaysPasses\" runs one test; empty string runs all discoverable tests (includes engine tests — usually too many).",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(60_000)
        .max(3_600_000)
        .default(600_000)
        .describe(
          "Timeout in milliseconds. Defaults to 10 minutes. UE startup alone is ~30-60s; budget accordingly.",
        ),
      mode: z
        .enum(["run", "list"])
        .default("run")
        .describe(
          "`run` (default) executes tests and parses results. `list` runs `Automation List` to enumerate available tests without executing them.",
        ),
      showAllPasses: z
        .boolean()
        .default(false)
        .describe(
          "If true, list every passing test in the output. By default, the first 30 are shown to keep responses readable.",
        ),
    },
    async ({ projectPath, filter, timeoutMs, mode, showAllPasses }) => {
      try {
        const project = detectProject(projectPath);

        // Temp dir UE will write index.json into.
        const reportDir = mkdtempSync(
          join(tmpdir(), "claude-unreal-tests-"),
        );
        const reportPath = join(reportDir, "index.json");

        const cmd =
          mode === "list"
            ? "Automation List"
            : `Automation RunTests ${filter}`.trim();

        // -TestExit asks UE to quit when the given log substring appears.
        // Belt: this works in most UE versions for the "Test queue empty"
        // marker. Suspenders: we also poll for the report file and SIGTERM
        // when it lands — UE doesn't always honour -TestExit reliably.
        const extraArgs = [
          `-ExecCmds=${cmd}`,
          `-ReportExportPath=${reportDir}`,
          `-TestExit=Automation Test Queue Empty`,
          "-log",
        ];

        const run = await runEditor(project, {
          extraArgs,
          timeoutMs,
          onSpawn:
            mode === "run"
              ? (_proc, kill) => {
                  // Poll for the report file. When it appears, give UE a
                  // moment to finish writing and then ask it to exit.
                  let killed = false;
                  const interval = setInterval(() => {
                    if (killed) return;
                    if (existsSync(reportPath)) {
                      killed = true;
                      // Brief pause for write completion before SIGTERM.
                      setTimeout(() => kill(), 1500);
                    }
                  }, 500);
                  return () => clearInterval(interval);
                }
              : undefined,
        });

        if (mode === "list") {
          // Test enumeration goes to the log, not the JSON report.
          // Pull the relevant lines out for the user.
          const listLines = extractAutomationList(run.stdout + run.stderr);
          const heading = `## Automation Tests (${listLines.length} discovered)`;
          const body =
            listLines.length === 0
              ? "_No tests discovered. The editor may have failed to start; try `read-logs` for details._"
              : "```\n" + listLines.join("\n") + "\n```";
          // Best-effort cleanup
          try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }
          return {
            content: [
              {
                type: "text" as const,
                text: `${heading}\n\n${body}\n\n_Editor run took ${(run.durationMs / 1000).toFixed(1)}s._`,
              },
            ],
          };
        }

        if (!existsSync(reportPath)) {
          // No report — surface as much diagnostic context as we can.
          const tail = (run.stderr || run.stdout).slice(-2000).trim();
          try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `## Tests: NO REPORT\n\n` +
                  `UE did not produce \`index.json\` at \`${reportDir}\`. ` +
                  `This usually means the editor failed to start or the test filter matched nothing. ` +
                  `Use \`read-logs\` for full context.\n\n` +
                  `Exit code: ${run.exitCode ?? "n/a (timeout)"} after ${(run.durationMs / 1000).toFixed(1)}s.\n\n` +
                  `Last 2KB of output:\n\n\`\`\`\n${tail}\n\`\`\``,
              },
            ],
          };
        }

        let raw: unknown;
        try {
          // UE writes the JSON with a UTF-8 BOM (U+FEFF) — strip it.
          const content = readFileSync(reportPath, "utf-8").replace(/^\uFEFF/, "");
          raw = JSON.parse(content);
        } catch (err) {
          try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to parse test report at \`${reportPath}\`: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }

        const report = parseTestReport(raw);
        const formatted = formatTestReport(report, { showAllEvents: showAllPasses });

        try { rmSync(reportDir, { recursive: true, force: true }); } catch { /* best effort */ }

        return {
          content: [
            {
              type: "text" as const,
              text: `${formatted}\n\n_Editor run took ${(run.durationMs / 1000).toFixed(1)}s._`,
            },
          ],
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

/**
 * Pull test-name lines out of `Automation List` output.
 *
 * Format from UE looks roughly like:
 *   LogAutomationCommandLine: Display: 	Sandbox.Sanity.AlwaysPasses
 *   LogAutomationCommandLine: Display: 	Project.Functional.Damage.HeadshotKill
 *
 * We accept either the explicit `LogAutomation*` prefixed form or any
 * tab/leading-whitespace line that looks like a dotted test path.
 */
function extractAutomationList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:LogAutomation\w*:\s+(?:Display:\s+)?)?\s*([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)\s*$/;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(".")) continue;
    const m = line.match(re);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    // Filter out things that look like log categories not tests
    if (/^Log\w+$/.test(name)) continue;
    seen.add(name);
    out.push(name);
  }
  out.sort();
  return out;
}
