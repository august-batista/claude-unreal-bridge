import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  detectProject,
  platformLogFallbacks,
} from "../ue-bridge/project-detector.js";
import {
  filterLog,
  formatLogEntries,
  type LogFilter,
  type LogSeverity,
} from "../parsers/log-output.js";
import { readLogsStructuredShape } from "../mcp/output-schemas.js";

interface LogFileInfo {
  path: string;
  isCurrent: boolean;
  mtime: Date;
  sizeBytes: number;
  source: "project" | "platform-fallback";
}

/**
 * List all log files for the project, sorted most recent first.
 *
 * Primary: `<ProjectDir>/Saved/Logs/<ProjectName>.log` plus backups.
 * Fallback (macOS / Linux): the OS-level log directory UE writes to when
 * `-AbsLog=` isn't passed (e.g. when the user opened UE manually).
 */
function findLogs(
  projectPath: string,
  projectName: string,
  fallbacks: string[],
): LogFileInfo[] {
  const result: LogFileInfo[] = [];

  const logsDir = join(projectPath, "Saved", "Logs");
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir)) {
      if (!name.endsWith(".log")) continue;
      const isCurrent = name === `${projectName}.log`;
      const isBackup = name.startsWith(`${projectName}-backup-`);
      if (!isCurrent && !isBackup) continue;

      const path = join(logsDir, name);
      const stat = statSync(path);
      result.push({
        path,
        isCurrent,
        mtime: stat.mtime,
        sizeBytes: stat.size,
        source: "project",
      });
    }
  }

  // Add platform-fallback locations and any backups in their parent dir.
  for (const candidate of fallbacks) {
    if (!existsSync(candidate)) continue;
    const parent = dirname(candidate);
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent)) {
      if (!name.endsWith(".log")) continue;
      const isCurrent = name === `${projectName}.log`;
      const isBackup = name.startsWith(`${projectName}-backup-`);
      if (!isCurrent && !isBackup) continue;
      const path = join(parent, name);
      // Skip if we already collected it (shouldn't happen, but be safe)
      if (result.some((r) => r.path === path)) continue;
      const stat = statSync(path);
      result.push({
        path,
        isCurrent,
        mtime: stat.mtime,
        sizeBytes: stat.size,
        source: "platform-fallback",
      });
    }
  }

  result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return result;
}

export function registerReadLogsTool(server: McpServer): void {
  server.registerTool(
    "read-logs",
    {
      title: "Read Logs",
      description:
        "Read and filter the UE editor/runtime log written to <Project>/Saved/Logs/. " +
        "Use after compile, run-tests, or run-scenario to inspect what happened. " +
        "Filters by category (LogBlueprint, LogTemp, etc.), severity, and regex. " +
        "Returns structured log entries alongside a readable rendering.",
      inputSchema: {
        projectPath: z
          .string()
          .describe("Absolute path to the UE project directory"),
        runIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Which run's log to read. 0 = most recent (default). 1 = previous run, etc. Backup logs are kept up to UE's rotation limit.",
          ),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these UE log categories, e.g. [\"LogBlueprint\", \"LogTemp\"]. Case-insensitive. Omit to include all categories.",
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
          .default("warning")
          .describe(
            "Lowest severity to include. Default `warning` keeps signal high. Use `display` to see normal log lines, `verbose` for everything.",
          ),
        pattern: z
          .string()
          .optional()
          .describe(
            "Optional regex matched (case-insensitive) against the message body.",
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(200)
          .describe(
            "Max entries to return. The most recent matches are kept. Default 200.",
          ),
        listAvailable: z
          .boolean()
          .default(false)
          .describe(
            "If true, just list the available log files (path, mtime, size) without reading content.",
          ),
      },
      outputSchema: readLogsStructuredShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({
      projectPath,
      runIndex,
      categories,
      minSeverity,
      pattern,
      maxResults,
      listAvailable,
    }) => {
      try {
        const project = detectProject(projectPath);
        const fallbacks = platformLogFallbacks(project);
        const logs = findLogs(
          project.projectPath,
          project.projectName,
          fallbacks,
        );

        if (logs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No logs found for project \`${project.projectName}\`. ` +
                  `Searched: \`${project.projectPath}/Saved/Logs/\`` +
                  (fallbacks.length > 0
                    ? ` and platform fallbacks (${fallbacks.map((f) => `\`${f}\``).join(", ")}).`
                    : ".") +
                  ` The project hasn't been run yet — try \`compile-blueprints\`, \`run-tests\`, or \`run-scenario\` first.`,
              },
            ],
            structuredContent: { mode: "list", logs: [] },
          };
        }

        if (listAvailable) {
          const lines = [`## Available logs (${logs.length})`, ""];
          for (let i = 0; i < logs.length; i++) {
            const l = logs[i];
            const tag = l.isCurrent ? "**current**" : "backup";
            const src = l.source === "platform-fallback" ? " _[platform fallback]_" : "";
            lines.push(
              `${i}. ${tag}${src} — \`${l.path}\` (${formatBytes(l.sizeBytes)}, ${l.mtime.toISOString()})`,
            );
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            structuredContent: {
              mode: "list",
              logs: logs.map((l, i) => ({
                index: i,
                path: l.path,
                isCurrent: l.isCurrent,
                source: l.source,
                mtime: l.mtime.toISOString(),
                sizeBytes: l.sizeBytes,
              })),
            },
          };
        }

        if (runIndex >= logs.length) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `runIndex ${runIndex} is out of range — only ${logs.length} log file(s) available. Use \`listAvailable: true\` to see them.`,
              },
            ],
          };
        }

        const target = logs[runIndex];
        const contents = readFileSync(target.path, "utf-8");
        const filter: LogFilter = {
          categories,
          minSeverity: minSeverity as LogSeverity,
          pattern,
        };
        const { entries, stats } = filterLog(contents, filter, maxResults);

        const fileLabel = `\`${target.path}\` (${target.isCurrent ? "current" : "backup"}, ${target.mtime.toISOString()})`;
        const formatted = formatLogEntries(entries, stats, fileLabel);

        return {
          content: [{ type: "text" as const, text: formatted }],
          structuredContent: {
            mode: "read",
            file: {
              path: target.path,
              isCurrent: target.isCurrent,
              source: target.source,
              mtime: target.mtime.toISOString(),
              sizeBytes: target.sizeBytes,
            },
            entries: entries.map((e) => ({
              timestamp: e.timestamp,
              frame: e.frame,
              category: e.category,
              severity: e.severity,
              message: e.message,
            })),
            stats,
          },
        };
      } catch (err) {
        return {
          isError: true,
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
