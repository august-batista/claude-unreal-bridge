// MCP resources for the active UE project.
//
// The tools in this server are all parameterised by `projectPath`, but MCP
// resources are addressed purely by URI with no arguments. We bridge the gap
// with an "active project" model: whenever a tool resolves a project
// (`detectProject`), it becomes the active one, and these resources expose that
// project's cheap, filesystem-backed artifacts so the client can pull them on
// demand instead of round-tripping a tool call:
//
//   unreal://project/info     — detected project metadata (JSON)
//   unreal://project/log      — the current editor/runtime log (text)
//   unreal://project/context  — the generated UNREAL_CONTEXT.md, if present
//
// Resource bodies that would require booting the editor (blueprint graphs,
// test reports) intentionally stay as tools — resources are meant to be cheap.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getActiveProject,
  defaultProjectLogPath,
  platformLogFallbacks,
} from "../ue-bridge/project-detector.js";

const NO_PROJECT_HINT =
  "No active Unreal project yet. Call any tool with a `projectPath` " +
  "(e.g. list-blueprints, read-logs) and this resource will reflect it.";

/** Last ~256 KB of the newest existing log file for the active project. */
const LOG_TAIL_BYTES = 256 * 1024;

function newestLogPath(): string | undefined {
  const project = getActiveProject();
  if (!project) return undefined;
  const candidates = [
    defaultProjectLogPath(project),
    ...platformLogFallbacks(project),
  ].filter((p) => existsSync(p));
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs,
  );
  return candidates[0];
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "ue-project-info",
    "unreal://project/info",
    {
      title: "Active UE project",
      description:
        "Metadata for the most recently used Unreal project: name, engine version, paths, modules, enabled plugins.",
      mimeType: "application/json",
    },
    async (uri) => {
      const project = getActiveProject();
      const body = project
        ? JSON.stringify(
            {
              projectName: project.projectName,
              engineVersion: project.engineVersion,
              uprojectFile: project.uprojectFile,
              projectPath: project.projectPath,
              contentPath: project.contentPath,
              sourcePath: project.sourcePath ?? null,
              isBlueprintOnly: !project.sourcePath,
              modules: project.modules,
              plugins: project.plugins,
            },
            null,
            2,
          )
        : JSON.stringify({ activeProject: null, hint: NO_PROJECT_HINT }, null, 2);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: body }],
      };
    },
  );

  server.registerResource(
    "ue-project-log",
    "unreal://project/log",
    {
      title: "Active UE project log (current)",
      description:
        "Tail of the current editor/runtime log for the active project (<Project>/Saved/Logs/<Project>.log). Use the read-logs tool for filtering, backups, and severity controls.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const logPath = newestLogPath();
      if (!logPath) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: getActiveProject()
                ? "No log file found yet — run compile-blueprints, run-tests, or run-scenario first."
                : NO_PROJECT_HINT,
            },
          ],
        };
      }
      let text = readFileSync(logPath, "utf-8");
      if (text.length > LOG_TAIL_BYTES) {
        text =
          `… (truncated to last ${Math.round(LOG_TAIL_BYTES / 1024)} KB; use read-logs for full filtering)\n` +
          text.slice(-LOG_TAIL_BYTES);
      }
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: `# ${logPath}\n\n${text}` },
        ],
      };
    },
  );

  server.registerResource(
    "ue-project-context",
    "unreal://project/context",
    {
      title: "UNREAL_CONTEXT.md",
      description:
        "The generated project overview (UNREAL_CONTEXT.md) for the active project, if it has been created with the generate-context tool.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const project = getActiveProject();
      if (!project) {
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: NO_PROJECT_HINT }],
        };
      }
      const contextPath = join(project.projectPath, "UNREAL_CONTEXT.md");
      const text = existsSync(contextPath)
        ? readFileSync(contextPath, "utf-8")
        : `No UNREAL_CONTEXT.md found for \`${project.projectName}\`. ` +
          "Run the generate-context tool to create one.";
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
      };
    },
  );
}
